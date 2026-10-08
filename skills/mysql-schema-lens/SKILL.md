---
name: mysql-schema-lens
description: Answer MySQL schema questions (tables, columns, keys, indexes, relationships, join paths, enums, routines, triggers) from a cached snapshot via the mysql-schema-lens MCP tools or CLI, using as few calls as possible. Use whenever you need to know how a MySQL database is structured before writing SQL, an ORM model, a migration, a repository/DAO, or a report query, or when reviewing such code; prefer it over running SHOW/DESCRIBE/information_schema queries yourself.
---

# mysql-schema-lens

mysql-schema-lens keeps a snapshot of a MySQL database's `information_schema` on
disk and answers schema questions from it. Every call is cheap: it is served from
the local cache, and at most one small fingerprint query reaches the database to
confirm the cache is still current. It never reads table data.

Your goal with this tool: **get the full picture you need in one or two rounds of
calls, then write the code.** Don't trickle one question at a time.

## How to call it

**MCP (preferred).** The tools are registered under whatever server name the user
chose (commonly `dbctx`), e.g. `mcp__dbctx__describe`. Every tool accepts two
optional arguments besides its own:

- `profile`: which database profile from `dbctx.config.json`. Leave it out for the default.
- `format`: `compact` (default, densest, best for you), `md` (when you show the
  result to the user), `json` (only when you must parse fields precisely).

**CLI (fallback when no MCP server is configured).**

```bash
mysql-schema-lens <command> [args] [--name <profile>] [--format compact|json|md] [--fk-only]
# or: npx -y mysql-schema-lens <command> ...
```

The CLI takes the same commands as the MCP tools, listed below. List arguments go
in as separate words: `mysql-schema-lens describe orders order_items customers`.

## Batching rules (the important part)

1. **`describe` takes a list of tables. Use it.** One `describe` with 3–8 tables
   costs one call and gives you the columns, types, nullability, defaults,
   comments, indexes, FKs and their ON DELETE/UPDATE rules, check constraints,
   what each column points to, what points at the table, and triggers. Never call
   `columns`, `constraints` and `triggers` separately for a table you are about to
   `describe`; `describe` already includes them.
2. **Send independent calls together, in the same turn.** Calls that don't depend
   on each other's output (e.g. `describe [a, b]` + `join-path a c` +
   `enums status` + `check-index a [x, y]`) should go out as parallel tool calls
   in one message, not one after another.
3. **Discover broadly, then describe precisely.** One discovery call (`tables` with
   a wildcard, `search-schema`, or `related`) to find the names, then one batched
   `describe` of everything relevant. That is two rounds for almost any task.
4. **Let wildcards do the fan-out.** `tables "*invoice*"`, `find-column "*_status"`
   and `enums order` each return every match in one call. Don't loop over tables.
5. **Use `related` with `depth` for the neighbourhood.** `related orders depth=2`
   returns everything within two hops in one call. Don't walk the graph yourself
   with repeated `related` or `describe` calls.
6. **Use `join-path` instead of working out joins.** It returns the shortest chain
   and ready-to-paste `JOIN ... ON ...` SQL. For several pairs, issue the
   `join-path` calls in parallel.
7. **Don't re-ask within a task.** The schema doesn't change while you work unless
   you ran a migration. Reuse what you already fetched. Only call `refresh` after
   applying a migration (and even then, the next call would notice the change by
   itself once `ttlSeconds` passes).
8. **Table names are forgiving.** An exact name, a case-insensitive name or a unique
   substring all work (`purchase_order_item` finds `app_purchase_order_item_tab`).
   If a substring is ambiguous, the error lists the candidates: pick from that list
   rather than calling `tables` again.

## The tools

| Tool | Arguments | Use it for |
|---|---|---|
| `tables` | `filter?` (substring or `*` pattern) | Finding table/view names, approximate row counts, comments. The usual first call. |
| `describe` | `tables[]` (1+) | **Main workhorse.** Everything about several tables at once. |
| `columns` | `table` | Just the column list of one table, when you need nothing else. |
| `constraints` | `table` | PK, unique keys, FKs with rules, checks, inferred references for one table. |
| `related` | `table`, `depth?` (1–5, default 1), `includeInferred?` | All tables linked to a table, both directions, up to N hops. |
| `find-column` | `pattern` | Which tables have a column like `*customer_id`, `created_*`. |
| `find-common-columns` | `tables[]` (2+) | Columns every given table shares, with each table's type: union queries, shared audit columns, type mismatches. |
| `join-path` | `from`, `to`, `includeInferred?` | Shortest relationship chain between two tables plus the JOIN SQL. |
| `enums` | `name?` (column or table filter) | ENUM/SET columns and their allowed values. |
| `search-schema` | `keyword` | One search across table names, column names, comments, routines and triggers. Best when you know the business term but not the table. |
| `find-by-type` | `type` | All columns of a type (`json`, `datetime`, `decimal`, `tinyint`...). |
| `check-index` | `table`, `columns[]` | Whether an index has these columns as its leading columns (so it can serve a lookup on them), and which indexes partly match. |
| `find-orphans` | `includeInferred?` | Tables with no relationship to anything. |
| `routines` | `name?` | Stored procedures/functions: parameters and return type (not bodies). |
| `triggers` | `table?` | Triggers, optionally for one table. |
| `status` | none | Is the DB reachable, is the password env var set, how old is the cache. Use it to diagnose errors. |
| `refresh` | none | Force a full re-read. Only after a migration. |

## Recipes

**Write a query / repository method for a feature.**
Round 1 (parallel): `search-schema <business term>` + `tables "*<term>*"`.
Round 2 (parallel): `describe [all candidate tables]` + `join-path` for each pair
you need to connect + `enums <table>` if status/type columns are involved.
Then write the SQL using the exact column names, types and nullability you got back.

**Understand one area of the schema.**
`related <central table> depth=2` → `describe [the tables that matter]`.

**Write an ORM entity / DTO / migration for existing tables.**
One `describe [tables]` in `json` format if you need to map types precisely
(column type, nullable, default, auto_increment, key), otherwise `compact`.

**Check whether a query will use an index.**
For each table in the WHERE/JOIN, in parallel: `check-index <table> [filter columns in order]`.
`covered: false` with a `partial` match means only a prefix of your columns is
usable, so suggest an index or reorder the predicate columns.

**Review code that touches the database.**
Collect every table name the code mentions, then one `describe [all of them]`.
Compare column names, types, nullability and enum values against the code.

**Find where a value lives.**
`find-column "*email*"` or `search-schema email`. Both return every table at once.

## Reading the output

Compact `describe` prints one line per column:

```
orders (table, ~120000 rows) — Customer orders
  id int unsigned PK auto_increment NOT NULL
  customer_id int unsigned idx NOT NULL -> customers.id
  order_item_id int NOT NULL -> purchase_order_item_tab.id [inferred:name]
  status enum('new','paid','shipped') NOT NULL default=new # lifecycle state
  indexes: idx_customer(customer_id); uq_ref UNIQUE(ref_no)
  fk rules: fk_orders_customer ON DELETE RESTRICT ON UPDATE CASCADE
  referenced by: order_items.order_id; shipments.order_id [inferred:name]
  triggers: trg_orders_audit AFTER UPDATE
```

- `PK` / `UNIQUE` / `idx` = primary key, unique key, part of a non-unique index.
- `-> table.column` = what the column references.
- **`[inferred:comment]` / `[inferred:name]` means there is no FK constraint.** The link
  was guessed from a column comment naming `table.column`, or from the column name
  matching a table. These are usually right but not enforced by the database: say
  so when you rely on one, don't assume cascading deletes, and consider orphaned
  rows possible. Pass `includeInferred: false` (CLI `--fk-only`) when you need only
  declared FKs.
- In `join-path` SQL, inferred joins carry a `-- inferred (name)` comment.
- Row counts are `information_schema` estimates, good for "big vs small" only.

## Problems

- **Output starts with `WARNING: Database unreachable ...`**: the database is down
  or unreachable, and you are getting the last cached snapshot. It is still usable;
  mention to the user that it may be out of date.
- **`Cannot reach ... and no cache exists`**: nothing has been cached yet and the DB
  is unreachable. Run `status` and report what it says (`passwordSet: false` means
  the password environment variable is missing from the MCP server's `env`).
- **`No config found at ...`**: the user hasn't created `dbctx.config.json`. Point
  them at the README setup section; don't invent connection details.
- **`Unknown profile`**: the error lists the known profiles; retry with one of them.
- **A table you just created is missing**: call `refresh` once.

## Don'ts

- Don't run `SHOW TABLES`, `DESCRIBE`, or `information_schema` queries against the
  database yourself when this tool is available.
- Don't call `describe` once per table in sequence; pass them all in one list.
- Don't call `refresh` "to be safe". Freshness is handled automatically.
- Don't treat inferred relationships as enforced constraints.
- The tool can't read data, procedure bodies or view row contents. Don't promise
  answers that need them.
