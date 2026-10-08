#!/usr/bin/env node
import { run, type Args } from './commands.js';
import { serve } from './mcp.js';
import type { Format } from './types.js';
import { VERSION } from './version.js';

const USAGE = `mysql-schema-lens <command> [args] [--name <profile>] [--format compact|json|md]

  init | refresh                 take a fresh snapshot
  status                         cache age, reachability, fingerprint state
  tables [filter]                list tables and views
  describe <table...>            columns, indexes, FKs, checks, relationships
  columns <table>                column list
  constraints <table>            PK / unique / FK / check
  related <table> [--depth n]    linked tables (FK + inferred)
  find-column <pattern>          columns by name (* wildcard)
  find-common-columns <table...> columns shared by tables
  join-path <from> <to>          shortest relationship path + JOIN SQL
  enums [name]                   ENUM / SET columns and values
  search-schema <keyword>        tables, columns, comments, routines, triggers
  find-by-type <type>            columns of a data type
  check-index <table> <col...>   is there an index for these columns
  find-orphans                   tables with no relationships
  routines [name]                stored functions / procedures
  triggers [table]               triggers
  mcp-serve                      run as an MCP server on stdio

  --fk-only   ignore inferred relationships (related, join-path, find-orphans)
  --version   print the version
Config: DBCTX_CONFIG, ./dbctx.config.json or ~/.schema-lens/dbctx.config.json`;

interface Parsed {
  command: string;
  positional: string[];
  profile?: string;
  format?: Format;
  depth?: number;
  fkOnly: boolean;
}

function parse(argv: string[]): Parsed {
  const parsed: Parsed = { command: '', positional: [], fkOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value.`);
      return v;
    };
    if (arg === '--name' || arg === '--profile') parsed.profile = value();
    else if (arg === '--format') {
      const f = value();
      if (f !== 'compact' && f !== 'json' && f !== 'md') throw new Error(`--format must be compact, json or md.`);
      parsed.format = f;
    } else if (arg === '--depth') parsed.depth = Number(value());
    else if (arg === '--fk-only') parsed.fkOnly = true;
    else if (arg === '--help' || arg === '-h') parsed.command = 'help';
    else if (arg === '--version' || arg === '-v') parsed.command = 'version';
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}.`);
    else if (!parsed.command) parsed.command = arg;
    else parsed.positional.push(arg);
  }
  return parsed;
}

function toArgs(p: Parsed): Args {
  const [first, second] = p.positional;
  const includeInferred = !p.fkOnly;
  switch (p.command) {
    case 'tables': return { filter: first };
    case 'describe': case 'find-common-columns': return { tables: p.positional };
    case 'columns': case 'constraints': case 'triggers': return { table: first };
    case 'related': return { table: first, depth: p.depth, includeInferred };
    case 'find-column': return { pattern: first };
    case 'join-path': return { from: first, to: second, includeInferred };
    case 'enums': case 'routines': return { name: first };
    case 'search-schema': return { keyword: first };
    case 'find-by-type': return { type: first };
    case 'check-index': return { table: first, columns: p.positional.slice(1) };
    case 'find-orphans': return { includeInferred };
    default: return {};
  }
}

async function main(): Promise<void> {
  const parsed = parse(process.argv.slice(2));
  if (!parsed.command || parsed.command === 'help') {
    console.log(USAGE);
    return;
  }
  if (parsed.command === 'version') {
    console.log(VERSION);
    return;
  }
  if (parsed.command === 'mcp-serve') {
    await serve(parsed.profile);
    return;
  }
  console.log(await run(parsed.command, toArgs(parsed), { profile: parsed.profile, format: parsed.format }));
}

main().catch((e: Error) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
