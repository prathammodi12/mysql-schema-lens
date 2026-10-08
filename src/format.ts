import type { Column, Format, Relation, Table } from './types.js';

type Described = Table & { references: Relation[]; referencedBy: Relation[]; triggers: Array<{ name: string; timing: string; event: string }> };

export function render(kind: string, value: unknown, format: Format): string {
  if (format === 'json') return JSON.stringify(value, null, 2);
  if (kind === 'describe') {
    const tables = value as Described[];
    return tables.map((t) => (format === 'md' ? describeMd(t) : describeCompact(t))).join('\n\n');
  }
  if (kind === 'columns') {
    const cols = value as Column[];
    return format === 'md' ? mdTable(cols.map(columnRow)) : cols.map(columnLine).join('\n');
  }
  return format === 'md' ? toMd(value) : toCompact(value);
}

/** int unsigned PK auto_increment NOT NULL default=0 — one dense line per column. */
function columnLine(c: Column): string {
  const parts = [c.name, c.columnType];
  if (c.key === 'PRI') parts.push('PK');
  else if (c.key === 'UNI') parts.push('UNIQUE');
  else if (c.key === 'MUL') parts.push('idx');
  if (c.extra) parts.push(c.extra.toLowerCase());
  if (!c.nullable) parts.push('NOT NULL');
  if (c.default !== null) parts.push(`default=${c.default}`);
  if (c.comment) parts.push(`# ${c.comment}`);
  return parts.join(' ');
}

function columnRow(c: Column): Record<string, unknown> {
  return { column: c.name, type: c.columnType, key: c.key, null: c.nullable ? 'YES' : 'NO', default: c.default, extra: c.extra, comment: c.comment };
}

const viaTag = (r: Relation) => (r.via === 'fk' ? '' : ` [inferred:${r.via}]`);

function describeCompact(t: Described): string {
  const out: string[] = [];
  const rows = t.approxRows === null ? '' : `, ~${t.approxRows} rows`;
  out.push(`${t.name} (${t.kind}${rows})${t.comment ? ` — ${t.comment}` : ''}`);
  const pointsTo = new Map(t.references.filter((r) => r.fromColumns.length === 1).map((r) => [r.fromColumns[0], r]));
  for (const c of t.columns) {
    const ref = pointsTo.get(c.name);
    out.push(`  ${columnLine(c)}${ref ? ` -> ${ref.toTable}.${ref.toColumns.join(',')}${viaTag(ref)}` : ''}`);
  }
  const indexes = t.indexes.filter((i) => i.name !== 'PRIMARY');
  if (indexes.length) out.push(`  indexes: ${indexes.map((i) => `${i.name}${i.unique ? ' UNIQUE' : ''}(${i.columns.join(',')})`).join('; ')}`);
  const multi = t.references.filter((r) => r.fromColumns.length > 1);
  if (multi.length) out.push(`  references: ${multi.map((r) => `(${r.fromColumns.join(',')}) -> ${r.toTable}(${r.toColumns.join(',')})${viaTag(r)}`).join('; ')}`);
  if (t.foreignKeys.length) out.push(`  fk rules: ${t.foreignKeys.map((f) => `${f.name} ON DELETE ${f.onDelete} ON UPDATE ${f.onUpdate}`).join('; ')}`);
  if (t.checks.length) out.push(`  checks: ${t.checks.map((c) => `${c.name}: ${c.clause}`).join('; ')}`);
  if (t.referencedBy.length) out.push(`  referenced by: ${t.referencedBy.map((r) => `${r.fromTable}.${r.fromColumns.join(',')}${viaTag(r)}`).join('; ')}`);
  if (t.triggers.length) out.push(`  triggers: ${t.triggers.map((g) => `${g.name} ${g.timing} ${g.event}`).join('; ')}`);
  if (t.viewDefinition) out.push(`  definition: ${t.viewDefinition}`);
  return out.join('\n');
}

function describeMd(t: Described): string {
  const parts = [`### ${t.name} (${t.kind})`, t.comment, mdTable(t.columns.map(columnRow))];
  if (t.indexes.length) parts.push('**Indexes**', mdTable(t.indexes.map((i) => ({ name: i.name, unique: i.unique, columns: i.columns.join(', ') }))));
  const rels = [...t.references, ...t.referencedBy];
  if (rels.length) parts.push('**Relationships**', mdTable(rels.map((r) => ({ from: `${r.fromTable}.${r.fromColumns.join(',')}`, to: `${r.toTable}.${r.toColumns.join(',')}`, via: r.via }))));
  return parts.filter(Boolean).join('\n\n');
}

/** Objects as indented key: value lines; arrays of flat objects as one line each. */
export function toCompact(value: unknown, indent = ''): string {
  if (value === null || value === undefined) return `${indent}-`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}(none)`;
    return value.map((v) => (isFlat(v) ? `${indent}${flatLine(v as Record<string, unknown>)}` : toCompact(v, indent))).join('\n');
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => (v !== null && typeof v === 'object' ? `${indent}${k}:\n${toCompact(v, `${indent}  `)}` : `${indent}${k}: ${scalar(v)}`))
      .join('\n');
  }
  return `${indent}${scalar(value)}`;
}

function isFlat(v: unknown): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.values(v as Record<string, unknown>).every((x) => x === null || typeof x !== 'object' || (Array.isArray(x) && x.every((y) => typeof y !== 'object')));
}

function flatLine(o: Record<string, unknown>): string {
  return Object.entries(o)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : scalar(v)}`)
    .join(' ');
}

function scalar(v: unknown): string {
  return v === null || v === undefined ? '-' : String(v);
}

function toMd(value: unknown): string {
  if (Array.isArray(value) && value.every(isFlat)) return value.length ? mdTable(value as Record<string, unknown>[]) : '_none_';
  return `\`\`\`\n${toCompact(value)}\n\`\`\``;
}

function mdTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '_none_';
  const headers = Object.keys(rows[0]);
  const cell = (v: unknown) => (Array.isArray(v) ? v.join(', ') : scalar(v)).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${headers.map((h) => cell(r[h])).join(' | ')} |`)].join('\n');
}
