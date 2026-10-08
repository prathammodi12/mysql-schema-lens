import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Config, ResolvedProfile } from '../src/config.js';
import { fixture } from './fixture.js';

const db = vi.hoisted(() => ({
  connect: vi.fn(),
  fingerprint: vi.fn(),
  extract: vi.fn(),
}));
vi.mock('../src/extract.js', () => db);

const { load } = await import('../src/store.js');

let dir: string;
let config: Config;
const target: ResolvedProfile = {
  name: 'dev',
  profile: { host: 'h', port: 3306, user: 'u', database: 'app', passwordEnv: 'X' },
  password: 'secret',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'msl-'));
  config = { default: 'dev', ttlSeconds: 60, defaultFormat: 'compact', cacheDir: dir, inferAliases: {}, profiles: { dev: target.profile } };
  db.connect.mockReset().mockResolvedValue({ end: vi.fn().mockResolvedValue(undefined) });
  db.fingerprint.mockReset().mockResolvedValue('fp-1');
  db.extract.mockReset().mockResolvedValue(fixture());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('load', () => {
  it('extracts on first use and caches the snapshot', async () => {
    const first = await load(config, target);
    expect(first.freshness).toBe('refreshed');
    expect(db.extract).toHaveBeenCalledTimes(1);
  });

  it('serves the cache without touching the database inside the ttl', async () => {
    await load(config, target);
    db.connect.mockClear();
    const again = await load(config, target);
    expect(again.freshness).toBe('fresh');
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('after the ttl, one fingerprint check keeps an unchanged cache', async () => {
    config.ttlSeconds = 0;
    await load(config, target);
    const again = await load(config, target);
    expect(again.freshness).toBe('fresh');
    expect(db.fingerprint).toHaveBeenCalledTimes(1);
    expect(db.extract).toHaveBeenCalledTimes(1);
  });

  it('re-extracts when the fingerprint changed (a migration ran)', async () => {
    config.ttlSeconds = 0;
    await load(config, target);
    db.fingerprint.mockResolvedValue('fp-2');
    db.extract.mockResolvedValue({ ...fixture(), fingerprint: 'fp-2' });
    const again = await load(config, target);
    expect(again.freshness).toBe('refreshed');
    expect(db.extract).toHaveBeenCalledTimes(2);
  });

  it('serves the cache marked stale when the database is down', async () => {
    config.ttlSeconds = 0;
    await load(config, target);
    db.connect.mockRejectedValue(new Error('ECONNREFUSED'));
    const down = await load(config, target);
    expect(down.freshness).toBe('stale');
    expect(down.warning).toContain('ECONNREFUSED');
  });

  it('fails clearly when the database is down and nothing is cached', async () => {
    db.connect.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(load(config, target)).rejects.toThrow(/no cache exists/);
  });

  it('force always re-extracts', async () => {
    await load(config, target);
    await load(config, target, true);
    expect(db.extract).toHaveBeenCalledTimes(2);
  });
});
