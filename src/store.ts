import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cacheDir, type Config, type ResolvedProfile } from './config.js';
import { connect, extract, fingerprint } from './extract.js';
import type { Snapshot } from './types.js';

/** fresh: checked within ttl or fingerprint unchanged; refreshed: re-extracted; stale: DB unreachable, cache served. */
export type Freshness = 'fresh' | 'refreshed' | 'stale';

export interface Loaded {
  snapshot: Snapshot;
  freshness: Freshness;
  checkedAt: string;
  /** Why the cache is stale, when it is. */
  warning?: string;
}

interface CacheFile {
  checkedAt: string;
  snapshot: Snapshot;
}

function cacheFile(config: Config, profileName: string): string {
  return join(cacheDir(config), `${profileName.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

function readCache(path: string): CacheFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CacheFile;
  } catch {
    return null; // a corrupt cache is rebuilt, not fatal
  }
}

function writeCache(path: string, data: CacheFile): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}

/**
 * The schema for a profile, as fresh as ttlSeconds allows:
 * within ttl the cache is used as is; after it one fingerprint query decides
 * whether to re-extract; with the database down the cache is served marked stale.
 */
export async function load(config: Config, target: ResolvedProfile, force = false): Promise<Loaded> {
  const path = cacheFile(config, target.name);
  const cached = readCache(path);
  const now = Date.now();

  if (!force && cached && now - Date.parse(cached.checkedAt) < config.ttlSeconds * 1000) {
    return { snapshot: cached.snapshot, freshness: 'fresh', checkedAt: cached.checkedAt };
  }

  let conn;
  try {
    conn = await connect(target);
    const checkedAt = new Date(now).toISOString();
    if (!force && cached && cached.snapshot.database === target.profile.database) {
      const current = await fingerprint(conn, target.profile.database);
      if (current === cached.snapshot.fingerprint) {
        writeCache(path, { checkedAt, snapshot: cached.snapshot });
        return { snapshot: cached.snapshot, freshness: 'fresh', checkedAt };
      }
    }
    const snapshot = await extract(conn, target.name, target.profile.database);
    writeCache(path, { checkedAt, snapshot });
    return { snapshot, freshness: 'refreshed', checkedAt };
  } catch (e) {
    if (cached) {
      return {
        snapshot: cached.snapshot,
        freshness: 'stale',
        checkedAt: cached.checkedAt,
        warning: `Database unreachable (${(e as Error).message}); serving the cached schema from ${cached.snapshot.extractedAt}.`,
      };
    }
    throw new Error(`Cannot reach ${target.profile.host}:${target.profile.port}/${target.profile.database} and no cache exists: ${(e as Error).message}`);
  } finally {
    await conn?.end().catch(() => undefined);
  }
}

/** Status without forcing a refresh: is the DB reachable, and is the cache current? */
export async function status(config: Config, target: ResolvedProfile): Promise<Record<string, unknown>> {
  const cached = readCache(cacheFile(config, target.name));
  const result: Record<string, unknown> = {
    profile: target.name,
    database: `${target.profile.host}:${target.profile.port}/${target.profile.database}`,
    user: target.profile.user,
    passwordEnv: target.profile.passwordEnv,
    passwordSet: target.password !== undefined,
    cacheFile: cacheFile(config, target.name),
    cachedAt: cached?.snapshot.extractedAt ?? null,
    lastChecked: cached?.checkedAt ?? null,
    tables: cached?.snapshot.tables.length ?? null,
  };
  let conn;
  try {
    conn = await connect(target);
    const current = await fingerprint(conn, target.profile.database);
    result.reachable = true;
    result.cacheCurrent = cached ? current === cached.snapshot.fingerprint : false;
  } catch (e) {
    result.reachable = false;
    result.error = (e as Error).message;
  } finally {
    await conn?.end().catch(() => undefined);
  }
  return result;
}
