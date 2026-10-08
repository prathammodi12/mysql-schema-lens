import mysql from 'mysql2/promise';
import type { Connection, RowDataPacket } from 'mysql2/promise';

import type { ResolvedProfile } from './config.js';
import type { Column, Routine, Snapshot, Table, Trigger } from './types.js';

/**
 * Reads the schema from information_schema only. Never touches table data and
 * never writes: the account it runs as needs nothing beyond what lets it see
 * the schema.
 */

export async function connect(target: ResolvedProfile): Promise<Connection> {
  const { profile } = target;
  return mysql.createConnection({
    host: profile.host,
    port: profile.port,
    user: profile.user,
    password: target.password,
    database: profile.database,
    connectTimeout: 5000,
    dateStrings: true,
  });
}

async function rows<T>(conn: Connection, sql: string, params: unknown[]): Promise<T[]> {
  const [result] = await conn.query<RowDataPacket[]>(sql, params);
  return result as unknown as T[];
}

/**
 * One cheap query whose result changes whenever a table, column, index, FK,
 * routine or trigger changes. CRC sums avoid GROUP_CONCAT's 1024-byte default limit.
 */
const FINGERPRINT_SQL = `
SELECT
  (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?) AS t,
  (SELECT IFNULL(SUM(CRC32(CONCAT_WS('|', TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, IS_NULLABLE,
      IFNULL(COLUMN_DEFAULT, '~'), COLUMN_KEY, EXTRA, COLUMN_COMMENT))), 0)
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?) AS c,
  (SELECT IFNULL(SUM(CRC32(CONCAT_WS('|', TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE))), 0)
     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?) AS i,
  (SELECT IFNULL(SUM(CRC32(CONCAT_WS('|', CONSTRAINT_NAME, TABLE_NAME, COLUMN_NAME, IFNULL(REFERENCED_TABLE_NAME, '~')))), 0)
     FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ?) AS k,
  (SELECT IFNULL(SUM(CRC32(CONCAT_WS('|', ROUTINE_NAME, ROUTINE_TYPE, LAST_ALTERED))), 0)
     FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?) AS r,
  (SELECT IFNULL(SUM(CRC32(CONCAT_WS('|', TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION))), 0)
     FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?) AS g,
  (SELECT IFNULL(SUM(CRC32(CONCAT_WS('|', TABLE_NAME, TABLE_COMMENT))), 0)
     FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?) AS m`;

export async function fingerprint(conn: Connection, database: string): Promise<string> {
  const [row] = await rows<Record<string, string | number>>(conn, FINGERPRINT_SQL, Array(7).fill(database));
  return ['t', 'c', 'i', 'k', 'r', 'g', 'm'].map((key) => String(row[key])).join('-');
}

interface TableRow { name: string; type: string; engine: string | null; approx_rows: number | null; comment: string }
interface ColumnRow { table_name: string; name: string; position: number; column_type: string; data_type: string;
  nullable: string; col_default: string | null; col_key: string; extra: string; comment: string }
interface IndexRow { table_name: string; name: string; non_unique: number; seq: number; column_name: string | null; index_type: string }
interface FkRow { name: string; table_name: string; column_name: string; ref_table: string; ref_column: string;
  position: number; on_update: string; on_delete: string }
interface CheckRow { table_name: string; name: string; clause: string }
interface ViewRow { name: string; definition: string }
interface RoutineRow { name: string; type: 'FUNCTION' | 'PROCEDURE'; returns: string | null; comment: string }
interface ParamRow { routine: string; mode: string | null; name: string | null; dtd: string; position: number }
interface TriggerRow { name: string; table_name: string; timing: string; event: string }

export async function extract(conn: Connection, profileName: string, database: string): Promise<Snapshot> {
  const p = [database];
  const [versionRow] = await rows<{ v: string }>(conn, 'SELECT VERSION() AS v', []);
  const fp = await fingerprint(conn, database);

  const tableRows = await rows<TableRow>(conn, `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine,
      TABLE_ROWS AS approx_rows, TABLE_COMMENT AS comment
    FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, p);
  const columnRows = await rows<ColumnRow>(conn, `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS name,
      ORDINAL_POSITION AS position, COLUMN_TYPE AS column_type, DATA_TYPE AS data_type, IS_NULLABLE AS nullable,
      COLUMN_DEFAULT AS col_default, COLUMN_KEY AS col_key, EXTRA AS extra, COLUMN_COMMENT AS comment
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, p);
  const indexRows = await rows<IndexRow>(conn, `SELECT TABLE_NAME AS table_name, INDEX_NAME AS name,
      NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq, COLUMN_NAME AS column_name, INDEX_TYPE AS index_type
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, p);
  const fkRows = await rows<FkRow>(conn, `SELECT k.CONSTRAINT_NAME AS name, k.TABLE_NAME AS table_name,
      k.COLUMN_NAME AS column_name, k.REFERENCED_TABLE_NAME AS ref_table, k.REFERENCED_COLUMN_NAME AS ref_column,
      k.ORDINAL_POSITION AS position, r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete
    FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
    WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
    ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, p);
  const checkRows = await optional(() => rows<CheckRow>(conn, `SELECT tc.TABLE_NAME AS table_name,
      cc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause
    FROM information_schema.TABLE_CONSTRAINTS tc
    JOIN information_schema.CHECK_CONSTRAINTS cc
      ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
    WHERE tc.TABLE_SCHEMA = ? AND tc.CONSTRAINT_TYPE = 'CHECK'`, p));
  const viewRows = await rows<ViewRow>(conn, `SELECT TABLE_NAME AS name, VIEW_DEFINITION AS definition
    FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?`, p);
  const routineRows = await rows<RoutineRow>(conn, `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type,
      DTD_IDENTIFIER AS returns, ROUTINE_COMMENT AS comment
    FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`, p);
  const paramRows = await rows<ParamRow>(conn, `SELECT SPECIFIC_NAME AS routine, PARAMETER_MODE AS mode,
      PARAMETER_NAME AS name, DTD_IDENTIFIER AS dtd, ORDINAL_POSITION AS position
    FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA = ? AND ORDINAL_POSITION > 0
    ORDER BY SPECIFIC_NAME, ORDINAL_POSITION`, p);
  const triggerRows = await rows<TriggerRow>(conn, `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS table_name,
      ACTION_TIMING AS timing, EVENT_MANIPULATION AS event
    FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME`, p);

  return {
    profile: profileName,
    database,
    serverVersion: versionRow?.v ?? 'unknown',
    extractedAt: new Date().toISOString(),
    fingerprint: fp,
    tables: assembleTables(tableRows, columnRows, indexRows, fkRows, checkRows, viewRows),
    routines: assembleRoutines(routineRows, paramRows),
    triggers: triggerRows.map<Trigger>((t) => ({ name: t.name, table: t.table_name, timing: t.timing, event: t.event })),
  };
}

/** CHECK_CONSTRAINTS only exists from MySQL 8.0.16; older servers simply have none. */
async function optional<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    return await read();
  } catch {
    return [];
  }
}

function assembleTables(tableRows: TableRow[], columnRows: ColumnRow[], indexRows: IndexRow[], fkRows: FkRow[],
    checkRows: CheckRow[], viewRows: ViewRow[]): Table[] {
  const byName = new Map<string, Table>();
  for (const t of tableRows) {
    byName.set(t.name, {
      name: t.name,
      kind: t.type === 'VIEW' ? 'view' : 'table',
      engine: t.engine,
      approxRows: t.approx_rows === null ? null : Number(t.approx_rows),
      comment: t.type === 'VIEW' ? '' : t.comment ?? '',
      columns: [],
      primaryKey: [],
      indexes: [],
      foreignKeys: [],
      checks: [],
    });
  }
  for (const c of columnRows) {
    byName.get(c.table_name)?.columns.push(toColumn(c));
  }
  for (const i of indexRows) {
    const table = byName.get(i.table_name);
    if (!table || i.column_name === null) continue;
    let index = table.indexes.find((x) => x.name === i.name);
    if (!index) {
      index = { name: i.name, unique: Number(i.non_unique) === 0, columns: [], type: i.index_type };
      table.indexes.push(index);
    }
    index.columns.push(i.column_name);
  }
  for (const table of byName.values()) {
    table.primaryKey = table.indexes.find((x) => x.name === 'PRIMARY')?.columns ?? [];
  }
  for (const f of fkRows) {
    const table = byName.get(f.table_name);
    if (!table) continue;
    let fk = table.foreignKeys.find((x) => x.name === f.name);
    if (!fk) {
      fk = { name: f.name, columns: [], refTable: f.ref_table, refColumns: [], onUpdate: f.on_update, onDelete: f.on_delete };
      table.foreignKeys.push(fk);
    }
    fk.columns.push(f.column_name);
    fk.refColumns.push(f.ref_column);
  }
  for (const c of checkRows) {
    byName.get(c.table_name)?.checks.push({ name: c.name, clause: c.clause });
  }
  for (const v of viewRows) {
    const view = byName.get(v.name);
    if (view) view.viewDefinition = v.definition;
  }
  return [...byName.values()];
}

function toColumn(c: ColumnRow): Column {
  return {
    name: c.name,
    position: Number(c.position),
    columnType: c.column_type,
    dataType: c.data_type,
    nullable: c.nullable === 'YES',
    default: c.col_default,
    key: c.col_key ?? '',
    extra: c.extra ?? '',
    comment: c.comment ?? '',
  };
}

function assembleRoutines(routineRows: RoutineRow[], paramRows: ParamRow[]): Routine[] {
  return routineRows.map((r) => ({
    name: r.name,
    type: r.type,
    returns: r.type === 'FUNCTION' ? r.returns : null,
    params: paramRows
      .filter((x) => x.routine === r.name)
      .map((x) => [x.mode, x.name, x.dtd].filter(Boolean).join(' ')),
    comment: r.comment ?? '',
  }));
}
