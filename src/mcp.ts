import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { run, type Args } from './commands.js';
import { loadConfig } from './config.js';
import { VERSION } from './version.js';

const common = {
  profile: z.string().optional().describe('Profile from dbctx.config.json; the default profile when omitted.'),
  format: z.enum(['compact', 'json', 'md']).optional().describe('Output format; compact (default) is the densest.'),
};
const inferred = z.boolean().optional().describe('Include relationships inferred from column comments and names (default true).');

interface ToolDef {
  name: string;
  description: string;
  input: z.ZodRawShape;
}

const TOOLS: ToolDef[] = [
  { name: 'tables', description: 'List tables and views with approximate row counts and comments. Start here to find the right table name.',
    input: { filter: z.string().optional().describe('Substring, or a pattern with * (e.g. "*order*").') } },
  { name: 'describe', description: 'Full detail for one or more tables in one call: columns (type, key, null, default, comment), indexes, FKs, check constraints, what each column references and what references the table (declared and inferred), triggers.',
    input: { tables: z.array(z.string()).min(1).describe('Table names; exact, case-insensitive, or a unique substring.') } },
  { name: 'columns', description: 'Column list for a single table.', input: { table: z.string() } },
  { name: 'constraints', description: 'Primary key, unique indexes, foreign keys with ON DELETE/UPDATE rules, check constraints, and inferred references for a table.',
    input: { table: z.string() } },
  { name: 'related', description: 'Tables linked to a table, breadth-first in both directions up to `depth` hops.',
    input: { table: z.string(), depth: z.number().int().min(1).max(5).optional(), includeInferred: inferred } },
  { name: 'find-column', description: 'Find columns by name across all tables (substring, or * wildcards).', input: { pattern: z.string() } },
  { name: 'find-common-columns', description: 'Columns shared by every given table, with each table\'s type for them.',
    input: { tables: z.array(z.string()).min(2) } },
  { name: 'join-path', description: 'Shortest chain of relationships between two tables, with the JOIN clauses to use.',
    input: { from: z.string(), to: z.string(), includeInferred: inferred } },
  { name: 'enums', description: 'ENUM and SET columns with their allowed values.', input: { name: z.string().optional().describe('Filter by column or table name.') } },
  { name: 'search-schema', description: 'Search table names, column names, comments, routines and triggers for a keyword.', input: { keyword: z.string() } },
  { name: 'find-by-type', description: 'All columns of a data type, e.g. datetime, json, tinyint, decimal.', input: { type: z.string() } },
  { name: 'check-index', description: 'Whether an index can serve a lookup on these columns (they must be its leading columns), and which indexes partly match.',
    input: { table: z.string(), columns: z.array(z.string()).min(1) } },
  { name: 'find-orphans', description: 'Tables with no relationship to any other table.', input: { includeInferred: inferred } },
  { name: 'routines', description: 'Stored functions and procedures with parameters and return type.', input: { name: z.string().optional() } },
  { name: 'triggers', description: 'Triggers, optionally for one table.', input: { table: z.string().optional() } },
  { name: 'status', description: 'Cache age, database reachability, and whether the cached schema is current.', input: {} },
  { name: 'refresh', description: 'Re-read the schema now (after a migration). Normally unnecessary: every call checks a fingerprint once the ttl passes.', input: {} },
];

export async function serve(defaultProfile?: string): Promise<void> {
  loadConfig(); // fail at start-up, not on the first tool call
  const server = new McpServer({ name: 'mysql-schema-lens', version: VERSION });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: { ...tool.input, ...common } },
      async (input: Record<string, unknown>) => {
        const { profile, format, ...args } = input as Args & { profile?: string; format?: 'compact' | 'json' | 'md' };
        try {
          const text = await run(tool.name, args, { profile: profile ?? defaultProfile, format });
          return { content: [{ type: 'text' as const, text }] };
        } catch (e) {
          return { content: [{ type: 'text' as const, text: (e as Error).message }], isError: true };
        }
      },
    );
  }

  await server.connect(new StdioServerTransport());
}
