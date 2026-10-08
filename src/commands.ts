import { loadConfig, resolveProfile, type Config } from './config.js';
import { render } from './format.js';
import * as q from './queries.js';
import { Schema } from './queries.js';
import { load, status } from './store.js';
import type { Format } from './types.js';

export interface Args {
  filter?: string;
  tables?: string[];
  table?: string;
  depth?: number;
  includeInferred?: boolean;
  pattern?: string;
  from?: string;
  to?: string;
  name?: string;
  keyword?: string;
  type?: string;
  columns?: string[];
}

type Handler = (schema: Schema, args: Args) => unknown;

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0) || value === '') {
    throw new Error(`Missing ${what}.`);
  }
  return value;
};

/** Every schema question, keyed by its CLI command / MCP tool name. */
export const HANDLERS: Record<string, Handler> = {
  tables: (s, a) => q.listTables(s, a.filter),
  describe: (s, a) => q.describe(s, need(a.tables, 'tables')),
  columns: (s, a) => q.columns(s, need(a.table, 'table')),
  constraints: (s, a) => q.constraints(s, need(a.table, 'table')),
  related: (s, a) => q.related(s, need(a.table, 'table'), a.depth ?? 1, a.includeInferred ?? true),
  'find-column': (s, a) => q.findColumn(s, need(a.pattern, 'pattern')),
  'find-common-columns': (s, a) => q.findCommonColumns(s, need(a.tables, 'tables')),
  'join-path': (s, a) => q.joinPath(s, need(a.from, 'from'), need(a.to, 'to'), a.includeInferred ?? true),
  enums: (s, a) => q.enums(s, a.name),
  'search-schema': (s, a) => q.searchSchema(s, need(a.keyword, 'keyword')),
  'find-by-type': (s, a) => q.findByType(s, need(a.type, 'type')),
  'check-index': (s, a) => q.checkIndex(s, need(a.table, 'table'), need(a.columns, 'columns')),
  'find-orphans': (s, a) => q.findOrphans(s, a.includeInferred ?? true),
  routines: (s, a) => q.routines(s, a.name),
  triggers: (s, a) => q.triggers(s, a.table),
};

export interface RunOptions {
  profile?: string;
  format?: Format;
  config?: Config;
}

/** Runs one command and returns text ready to print or to return from an MCP tool. */
export async function run(command: string, args: Args, options: RunOptions = {}): Promise<string> {
  const config = options.config ?? loadConfig();
  const target = resolveProfile(config, options.profile);
  const format = options.format ?? config.defaultFormat;

  if (command === 'status') {
    return render('status', await status(config, target), format);
  }
  if (command === 'refresh' || command === 'init') {
    const loaded = await load(config, target, true);
    const schema = new Schema(loaded.snapshot, config.inferAliases);
    return render('refresh', {
      profile: target.name,
      database: loaded.snapshot.database,
      serverVersion: loaded.snapshot.serverVersion,
      extractedAt: loaded.snapshot.extractedAt,
      tables: loaded.snapshot.tables.filter((t) => t.kind === 'table').length,
      views: loaded.snapshot.tables.filter((t) => t.kind === 'view').length,
      routines: loaded.snapshot.routines.length,
      triggers: loaded.snapshot.triggers.length,
      relationships: q.relationSummary(schema),
    }, format);
  }

  const handler = HANDLERS[command];
  if (!handler) {
    throw new Error(`Unknown command '${command}'. Commands: init, refresh, status, ${Object.keys(HANDLERS).join(', ')}`);
  }
  const loaded = await load(config, target);
  const schema = new Schema(loaded.snapshot, config.inferAliases);
  const text = render(command, handler(schema, args), format);
  return loaded.warning ? `WARNING: ${loaded.warning}\n\n${text}` : text;
}
