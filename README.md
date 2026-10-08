# mysql-schema-lens

[![npm](https://img.shields.io/npm/v/mysql-schema-lens.svg)](https://www.npmjs.com/package/mysql-schema-lens)
[![license](https://img.shields.io/npm/l/mysql-schema-lens.svg)](LICENSE)

Local MySQL schema store for coding agents. It snapshots `information_schema`
once, caches it on disk, and answers schema questions from the cache, over MCP
or the command line. A MySQL counterpart of
[schema-lens](https://github.com/JaydeepRamanuj/schema-lens), which is PostgreSQL-only.

- **Fresh without being slow:** inside `ttlSeconds` the cache is used as is;
  after that one fingerprint query decides whether the schema changed and only
  then re-extracts.
- **Works offline:** with the database down, the cached schema is served with a warning.
- **Finds relationships that were never declared:** besides foreign keys it
  infers links from column comments that name `table.column`, and from column
  names (`order_item_id` -> `app_purchase_order_item_tab.id`, after stripping
  the shared table prefix and a `_tab` suffix). Inferred links are always marked.
- **Read-only:** it only runs `SELECT` on `information_schema`; it never reads table data.

## Install

Requires Node.js 18 or later.

```bash
npm install -g mysql-schema-lens
```

Or run it without installing: `npx mysql-schema-lens <command>`.

## Setup

Create `dbctx.config.json` from
[`dbctx.config.json.example`](dbctx.config.json.example) (also shipped in the
package), keep it out of git, and point `DBCTX_CONFIG` at it (or put it in the
working directory or `~/.schema-lens/`). Passwords never go in the file: each profile names the
environment variable that holds it (`passwordEnv`, default `DBCTX_MYSQL_PASSWORD`).

The account needs nothing beyond seeing the schema, e.g.:

```sql
CREATE USER 'schema_reader'@'%' IDENTIFIED BY '...';
GRANT SELECT, SHOW VIEW ON myapp.* TO 'schema_reader'@'%';
```

(`SHOW VIEW` is needed for view definitions; routine bodies are not read.)

## MCP

```json
"dbctx": {
  "command": "npx",
  "args": ["-y", "mysql-schema-lens", "mcp-serve"],
  "env": {
    "DBCTX_CONFIG": "<path>/dbctx.config.json",
    "DBCTX_MYSQL_PASSWORD": "<password>"
  }
}
```

Tools: `tables`, `describe`, `columns`, `constraints`, `related`, `find-column`,
`find-common-columns`, `join-path`, `enums`, `search-schema`, `find-by-type`,
`check-index`, `find-orphans`, `routines`, `triggers`, `status`, `refresh`.
Each takes an optional `profile` and `format` (`compact`, `json`, `md`).

With a global install, `"command": "mysql-schema-lens", "args": ["mcp-serve"]`
also works and skips the `npx` lookup on start-up.

## Agent skill

[`skills/mysql-schema-lens/SKILL.md`](skills/mysql-schema-lens/SKILL.md) teaches
a coding agent to use these tools efficiently: batching tables into one
`describe`, sending independent calls in parallel, and treating inferred
relationships with care. For Claude Code, copy the folder to
`~/.claude/skills/` (all projects) or `.claude/skills/` (one project). It also
ships in the npm package, under `node_modules/mysql-schema-lens/skills/`.

## CLI

```bash
mysql-schema-lens refresh
mysql-schema-lens describe app_purchase_order_item_tab
mysql-schema-lens join-path app_shipment_tab app_purchase_order_tab
mysql-schema-lens check-index app_purchase_order_tab company state
mysql-schema-lens --help
```

## Development

```bash
git clone https://github.com/prathammodi12/mysql-schema-lens.git
cd mysql-schema-lens
npm install
npm run build
npm run typecheck
npm test
node dist/cli.js --help
```

## License

[MIT](LICENSE) © Pratham Modi
