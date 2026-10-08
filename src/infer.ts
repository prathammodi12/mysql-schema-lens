import type { Column, Relation, Snapshot, Table } from './types.js';

/** Word stems people abbreviate in column names. Extend per database with config.inferAliases. */
export const DEFAULT_ALIASES: Record<string, string> = {
  dept: 'department',
  doc: 'document',
  req: 'request',
  usr: 'user',
  org: 'organization',
};

/**
 * Every relationship in the schema: declared foreign keys, then ones inferred
 * from a column comment that names table.column, then from a column name
 * (order_item_id -> ..._order_item_tab.id). Inferred ones say so in `via`.
 * A column gets at most one relationship, from the strongest evidence.
 */
export function relations(snapshot: Snapshot, extraAliases: Record<string, string> = {}): Relation[] {
  const aliases = { ...DEFAULT_ALIASES, ...extraAliases };
  const byLower = new Map(snapshot.tables.map((t) => [t.name.toLowerCase(), t]));
  const result: Relation[] = [];
  const covered = new Set<string>();
  const key = (table: string, column: string) => `${table.toLowerCase()}.${column.toLowerCase()}`;

  for (const table of snapshot.tables) {
    for (const fk of table.foreignKeys) {
      result.push({ fromTable: table.name, fromColumns: fk.columns, toTable: fk.refTable, toColumns: fk.refColumns, via: 'fk', detail: fk.name });
      fk.columns.forEach((c) => covered.add(key(table.name, c)));
    }
  }

  for (const table of snapshot.tables) {
    for (const column of table.columns) {
      if (covered.has(key(table.name, column.name))) continue;
      const ref = commentReference(column, byLower);
      if (ref && !(ref.table.name === table.name && ref.column === column.name)) {
        result.push({ fromTable: table.name, fromColumns: [column.name], toTable: ref.table.name, toColumns: [ref.column], via: 'comment', detail: `comment: ${column.comment}` });
        covered.add(key(table.name, column.name));
      }
    }
  }

  const cores = tableCores(snapshot.tables);
  for (const table of snapshot.tables) {
    if (table.kind === 'view') continue;
    for (const column of table.columns) {
      if (covered.has(key(table.name, column.name))) continue;
      if (table.primaryKey.length === 1 && table.primaryKey[0] === column.name) continue;
      const target = nameReference(column.name, cores, aliases, table);
      const targetId = target?.columns.find((c) => c.name.toLowerCase() === 'id');
      if (target && targetId && compatible(column, targetId)) {
        result.push({ fromTable: table.name, fromColumns: [column.name], toTable: target.name, toColumns: ['id'], via: 'name', detail: `name: ${column.name} ~ ${target.name}` });
        covered.add(key(table.name, column.name));
      }
    }
  }
  return result;
}

const KEY_LIKE = /(_id|_code|_no|_key)$/i;

/**
 * A comment such as "app_product_catalog_master_tab.id" pointing at an existing
 * table and column. Only a reference to a key, or from a key-like column: a
 * comment like "file name, matches app_detail_tab.name" says the values agree,
 * not that one points at the other.
 */
function commentReference(column: Column, byLower: Map<string, Table>): { table: Table; column: string } | null {
  if (!column.comment) return null;
  for (const match of column.comment.matchAll(/\b([A-Za-z0-9_$]+)\.([A-Za-z0-9_$]+)\b/g)) {
    const table = byLower.get(match[1].toLowerCase());
    const target = table?.columns.find((c) => c.name.toLowerCase() === match[2].toLowerCase());
    if (!table || !target) continue;
    const isKey = target.key === 'PRI' || target.key === 'UNI' || table.primaryKey.includes(target.name);
    if ((isKey || KEY_LIKE.test(column.name)) && compatible(column, target)) return { table, column: target.name };
  }
  return null;
}

const INTEGER = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint']);
const STRING = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'binary', 'varbinary']);

/** An integer column cannot hold a string key, nor the other way round. Other types are not judged. */
export function compatible(from: Column, to: Column): boolean {
  const a = from.dataType.toLowerCase();
  const b = to.dataType.toLowerCase();
  if (INTEGER.has(a) || INTEGER.has(b)) return INTEGER.has(a) && INTEGER.has(b);
  if (STRING.has(a) || STRING.has(b)) return STRING.has(a) && STRING.has(b);
  return true;
}

interface Core {
  table: Table;
  core: string;
}

/**
 * A table's name without the prefix most tables share (app_) and without a
 * storage suffix (_tab, _table, _tbl): app_purchase_order_item_tab -> purchase_order_item.
 * Only tables with an `id` column can be the target of an *_id column.
 */
export function tableCores(tables: Table[]): Core[] {
  const real = tables.filter((t) => t.kind === 'table');
  const prefixCounts = new Map<string, number>();
  for (const t of real) {
    const prefix = t.name.toLowerCase().split('_')[0];
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }
  const shared = [...prefixCounts.entries()].filter(([, n]) => real.length >= 3 && n / real.length >= 0.4).map(([p]) => `${p}_`);
  return real
    .filter((t) => t.columns.some((c) => c.name.toLowerCase() === 'id'))
    .map((table) => {
      let core = table.name.toLowerCase().replace(/_(tab|table|tbl)$/, '');
      const prefix = shared.find((p) => core.startsWith(p) && core.length > p.length);
      if (prefix) core = core.slice(prefix.length);
      return { table, core };
    });
}

/**
 * order_item_id -> the one table whose core is order_item(s), else the one
 * ending in _order_item. If neither is unique, drop the leading word and try
 * again (buyer_dept_id -> dept -> department), but then only an exact or
 * <word>_master match counts: a loose suffix match on what remains
 * (doc_reference_id -> *_reference) is too often wrong. A table points at
 * itself only through parent_* columns. Ambiguity gives no answer rather than a wrong one.
 */
export function nameReference(columnName: string, cores: Core[], aliases: Record<string, string>, owner?: Table): Table | null {
  const lower = columnName.toLowerCase();
  if (!lower.endsWith('_id') || lower === '_id') return null;
  const words = lower.slice(0, -3).split('_').filter(Boolean);
  const isParent = words[0] === 'parent' && words.length > 1;
  const candidates = cores.filter(({ table }) => !owner || table.name !== owner.name || isParent);
  const first = isParent ? 1 : 0;

  for (let start = first; start < words.length; start++) {
    const tried = words.slice(start);
    const loose = start === first;
    const stems = new Set([tried.join('_'), tried.map((w) => aliases[w] ?? w).join('_')]);
    for (const stem of stems) {
      if (stem.length < 2) continue;
      const exact = candidates.filter(({ core }) => core === stem || core === `${stem}s` || core === `${stem}es` || `${core}s` === stem
        || core === `${stem}_master`);
      if (exact.length === 1) return exact[0].table;
      if (exact.length > 1) return null;
      if (!loose) continue;
      const suffix = candidates.filter(({ core }) => core.endsWith(`_${stem}`) || core.endsWith(`_${stem}s`) || core.endsWith(`_${stem}_master`));
      if (suffix.length === 1) return suffix[0].table;
      if (suffix.length > 1) return null;
    }
  }
  return null;
}
