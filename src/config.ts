import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

import type { Format } from './types.js';

const ProfileSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().positive().default(3306),
    user: z.string().min(1),
    database: z.string().min(1),
    /** Environment variable holding the password. Passwords never go in the config file. */
    passwordEnv: z.string().min(1).default('DBCTX_MYSQL_PASSWORD'),
    comment: z.string().optional(),
  })
  .strict();

const ConfigSchema = z
  .object({
    default: z.string().min(1),
    ttlSeconds: z.number().int().nonnegative().default(5),
    defaultFormat: z.enum(['compact', 'json', 'md']).default('compact'),
    cacheDir: z.string().optional(),
    /** Extra stem -> table-word aliases for name-based relationship inference, e.g. { "dept": "department" }. */
    inferAliases: z.record(z.string()).default({}),
    profiles: z.record(ProfileSchema),
  })
  .strict();

export type Profile = z.infer<typeof ProfileSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export interface ResolvedProfile {
  name: string;
  profile: Profile;
  password: string | undefined;
}

/** DBCTX_CONFIG wins; otherwise ./dbctx.config.json, then ~/.schema-lens/dbctx.config.json. */
export function configPath(): string {
  if (process.env.DBCTX_CONFIG) {
    return resolve(process.env.DBCTX_CONFIG);
  }
  const local = resolve('dbctx.config.json');
  return existsSync(local) ? local : join(homedir(), '.schema-lens', 'dbctx.config.json');
}

export function loadConfig(path = configPath()): Config {
  if (!existsSync(path)) {
    throw new Error(`No config found at ${path}. Set DBCTX_CONFIG or create dbctx.config.json (see dbctx.config.json.example).`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid config ${path}: ${issues}`);
  }
  if (!parsed.data.profiles[parsed.data.default]) {
    throw new Error(`Config ${path}: default profile '${parsed.data.default}' is not in profiles.`);
  }
  return parsed.data;
}

export function resolveProfile(config: Config, name?: string): ResolvedProfile {
  const chosen = name ?? config.default;
  const profile = config.profiles[chosen];
  if (!profile) {
    throw new Error(`Unknown profile '${chosen}'. Known: ${Object.keys(config.profiles).join(', ')}`);
  }
  return { name: chosen, profile, password: process.env[profile.passwordEnv] };
}

export function cacheDir(config: Config): string {
  return config.cacheDir ? resolve(config.cacheDir) : join(homedir(), '.schema-lens', 'cache');
}

export function defaultFormat(config: Config): Format {
  return config.defaultFormat;
}
