import { relations } from './infer.js';
import type { Column, Relation, Snapshot, Table } from './types.js';

/** A snapshot with its relationships worked out once, and the lookups every tool shares. */
export class Schema {
  readonly relations: Relation[];

  constructor(readonly snapshot: Snapshot, aliases: Record<string, string> = {}) {
    this.relations = relations(snapshot, aliases);
  }

  /** Exact, case-insensitive, or a unique substring ("purchase_order_item"); otherwise an error with suggestions. */
  table(name: string): Table {
    const lower = name.toLowerCase();
    const tables = this.snapshot.tables;
    const exact = tables.find((t) => t.name === name) ?? tables.find((t) => t.name.toLowerCase() === lower);
    if (exact) return exact;
    const partial = tables.filter((t) => t.name.toLowerCase().includes(lower));
    if (partial.length === 1) return partial[0];
    const hint = partial.length > 1 ? `Matches: ${partial.slice(0, 10).map((t) => t.name).join(', ')}` : 'No similar table.';
    throw new Error(`Table '${name}' not found${partial.length > 1 ? ' uniquely' : ''}. ${hint}`);
  }

  edges(includeInferred: boolean): Relation[] {
    return includeInferred ? this.relations : this.relations.filter((r) => r.via === 'fk');
  }

  outgoing(table: string, includeInferred = true): Relation[] {
    return this.edges(includeInferred).filter((r) => r.fromTable === table);
  }

  incoming(table: string, includeInferred = true): Relation[] {
    return this.edges(includeInferred).filter((r) => r.toTable === table && r.fromTable !== table);
  }
}

const like = (pattern: string) => {
  if (!pattern.includes('*') && !pattern.includes('%')) {
    const lower = pattern.toLowerCase();
    return (s: string) => s.toLowerCase().includes(lower);
  }
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[*%]/g, '.*')}$`, 'i');
  return (s: string) => re.test(s);
};

export function listTables(schema: Schema, filter?: string) {
  const match = filter ? like(filter) : () => true;
  return schema.snapshot.tables
    .filter((t) => match(t.name))
    .map((t) => ({ name: t.name, kind: t.kind, approxRows: t.approxRows, columns: t.columns.length, comment: t.comment }));
}

export function describe(schema: Schema, names: string[]) {
  return names.map((name) => {
    const table = schema.table(name);
    return {
      ...table,
      references: schema.outgoing(table.name),
      referencedBy: schema.incoming(table.name),
      triggers: schema.snapshot.triggers.filter((t) => t.table === table.name),
    };
  });
}

export function columns(schema: Schema, name: string): Column[] {
  return schema.table(name).columns;
}

export function constraints(schema: Schema, name: string) {
  const table = schema.table(name);
  return {
    table: table.name,
    primaryKey: table.primaryKey,
    unique: table.indexes.filter((i) => i.unique && i.name !== 'PRIMARY').map((i) => ({ name: i.name, columns: i.columns })),
    foreignKeys: table.foreignKeys,
    checks: table.checks,
    inferredReferences: schema.outgoing(table.name).filter((r) => r.via !== 'fk'),
  };
}

/** Breadth-first over relationships in both directions, up to `depth` hops. */
export function related(schema: Schema, name: string, depth = 1, includeInferred = true) {
  const start = schema.table(name).name;
  const seen = new Map<string, number>([[start, 0]]);
  const found: Array<Relation & { depth: number }> = [];
  let frontier = [start];
  for (let level = 1; level <= Math.max(1, depth) && frontier.length > 0; level++) {
    const next: string[] = [];
    for (const table of frontier) {
      for (const r of schema.edges(includeInferred)) {
        if (r.fromTable !== table && r.toTable !== table) continue;
        const other = r.fromTable === table ? r.toTable : r.fromTable;
        found.push({ ...r, depth: level });
        if (!seen.has(other)) {
          seen.set(other, level);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  const unique = new Map(found.map((r) => [`${r.fromTable}.${r.fromColumns}>${r.toTable}`, r]));
  return { table: start, relations: [...unique.values()] };
}

export function findColumn(schema: Schema, pattern: string) {
  const match = like(pattern);
  return schema.snapshot.tables.flatMap((t) =>
    t.columns.filter((c) => match(c.name)).map((c) => ({ table: t.name, column: c.name, type: c.columnType, nullable: c.nullable, comment: c.comment })));
}

export function findCommonColumns(schema: Schema, names: string[]) {
  const tables = names.map((n) => schema.table(n));
  if (tables.length < 2) throw new Error('Give at least two tables.');
  const [first, ...rest] = tables;
  return first.columns
    .filter((c) => rest.every((t) => t.columns.some((x) => x.name.toLowerCase() === c.name.toLowerCase())))
    .map((c) => ({
      column: c.name,
      types: Object.fromEntries(tables.map((t) => [t.name, t.columns.find((x) => x.name.toLowerCase() === c.name.toLowerCase())!.columnType])),
    }));
}

/** Shortest chain of relationships between two tables, walking them in either direction. */
export function joinPath(schema: Schema, from: string, to: string, includeInferred = true) {
  const start = schema.table(from).name;
  const goal = schema.table(to).name;
  const previous = new Map<string, { table: string; via: Relation } | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0 && !previous.has(goal)) {
    const table = queue.shift()!;
    for (const r of schema.edges(includeInferred)) {
      if (r.fromTable !== table && r.toTable !== table) continue;
      const other = r.fromTable === table ? r.toTable : r.fromTable;
      if (!previous.has(other)) {
        previous.set(other, { table, via: r });
        queue.push(other);
      }
    }
  }
  if (!previous.has(goal)) {
    return { from: start, to: goal, found: false, steps: [] as Relation[], joinSql: null };
  }
  const steps: Relation[] = [];
  for (let at = goal; previous.get(at); at = previous.get(at)!.table) steps.unshift(previous.get(at)!.via);
  return { from: start, to: goal, found: true, steps, joinSql: joinSql(start, steps) };
}

function joinSql(start: string, steps: Relation[]): string {
  let current = start;
  const lines = [`FROM ${start}`];
  for (const s of steps) {
    const next = s.fromTable === current ? s.toTable : s.fromTable;
    const on = s.fromColumns.map((c, i) => `${s.fromTable}.${c} = ${s.toTable}.${s.toColumns[i] ?? 'id'}`).join(' AND ');
    lines.push(`JOIN ${next} ON ${on}${s.via === 'fk' ? '' : `  -- inferred (${s.via})`}`);
    current = next;
  }
  return lines.join('\n');
}

/** enum('a','b') -> ['a','b'], quotes and escaped quotes handled. */
export function enumValues(columnType: string): string[] {
  const body = columnType.match(/^(?:enum|set)\((.*)\)$/i)?.[1];
  if (!body) return [];
  return [...body.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
}

export function enums(schema: Schema, name?: string) {
  const match = name ? like(name) : () => true;
  return schema.snapshot.tables.flatMap((t) =>
    t.columns
      .filter((c) => (c.dataType === 'enum' || c.dataType === 'set') && (match(c.name) || match(t.name)))
      .map((c) => ({ table: t.name, column: c.name, kind: c.dataType, values: enumValues(c.columnType) })));
}

export function searchSchema(schema: Schema, keyword: string) {
  const match = like(keyword);
  const { tables, routines, triggers } = schema.snapshot;
  return {
    tables: tables.filter((t) => match(t.name) || match(t.comment)).map((t) => ({ name: t.name, comment: t.comment })),
    columns: tables.flatMap((t) => t.columns.filter((c) => match(c.name) || match(c.comment))
      .map((c) => ({ table: t.name, column: c.name, type: c.columnType, comment: c.comment }))),
    routines: routines.filter((r) => match(r.name) || match(r.comment)).map((r) => ({ name: r.name, type: r.type })),
    triggers: triggers.filter((g) => match(g.name) || match(g.table)).map((g) => ({ name: g.name, table: g.table })),
  };
}

export function findByType(schema: Schema, type: string) {
  const lower = type.toLowerCase();
  return schema.snapshot.tables.flatMap((t) =>
    t.columns.filter((c) => c.dataType.toLowerCase() === lower || c.columnType.toLowerCase().startsWith(lower))
      .map((c) => ({ table: t.name, column: c.name, type: c.columnType })));
}

/** Whether an index can serve a lookup on these columns: they must be its leading columns. */
export function checkIndex(schema: Schema, name: string, cols: string[]) {
  const table = schema.table(name);
  const wanted = cols.map((c) => c.toLowerCase());
  const missing = wanted.filter((c) => !table.columns.some((x) => x.name.toLowerCase() === c));
  if (missing.length) throw new Error(`${table.name} has no column(s): ${missing.join(', ')}`);
  const verdicts = table.indexes.map((i) => {
    const lead = i.columns.slice(0, wanted.length).map((c) => c.toLowerCase());
    const sameSet = lead.length === wanted.length && wanted.every((c) => lead.includes(c));
    const leadingPrefix = wanted.filter((c, n) => lead[n] === c).length;
    return { index: i.name, columns: i.columns, unique: i.unique, covers: sameSet, leadingColumnsMatched: leadingPrefix };
  });
  const covering = verdicts.filter((v) => v.covers);
  return {
    table: table.name,
    columns: cols,
    covered: covering.length > 0,
    coveringIndexes: covering.map((v) => v.index),
    partial: verdicts.filter((v) => !v.covers && v.leadingColumnsMatched > 0),
  };
}

export function findOrphans(schema: Schema, includeInferred = true) {
  const linked = new Set(schema.edges(includeInferred).flatMap((r) => [r.fromTable, r.toTable]));
  return schema.snapshot.tables.filter((t) => t.kind === 'table' && !linked.has(t.name))
    .map((t) => ({ name: t.name, approxRows: t.approxRows, comment: t.comment }));
}

export function routines(schema: Schema, name?: string) {
  const match = name ? like(name) : () => true;
  return schema.snapshot.routines.filter((r) => match(r.name));
}

export function triggers(schema: Schema, table?: string) {
  const name = table ? schema.table(table).name : undefined;
  return schema.snapshot.triggers.filter((t) => !name || t.table === name);
}

export function relationSummary(schema: Schema) {
  const count = (via: string) => schema.relations.filter((r) => r.via === via).length;
  return { declaredForeignKeys: count('fk'), inferredFromComments: count('comment'), inferredFromNames: count('name') };
}
