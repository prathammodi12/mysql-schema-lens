import { describe as group, expect, it } from 'vitest';

import { render } from '../src/format.js';
import { relations } from '../src/infer.js';
import * as q from '../src/queries.js';
import { Schema } from '../src/queries.js';
import { fixture } from './fixture.js';

const schema = () => new Schema(fixture());
const rel = (s: Schema, from: string, column: string) =>
  s.relations.find((r) => r.fromTable === from && r.fromColumns.includes(column));

group('relationship inference', () => {
  it('keeps declared foreign keys as fk', () => {
    expect(rel(schema(), 'app_purchase_order_item_tab', 'order_id')).toMatchObject({ toTable: 'app_purchase_order_tab', via: 'fk' });
  });

  it('reads table.column from a column comment', () => {
    // "master" alone is ambiguous (three *_master tables); the comment settles it.
    expect(rel(schema(), 'app_purchase_order_item_tab', 'master_id')).toMatchObject({ toTable: 'app_product_catalog_master_tab', via: 'comment' });
  });

  it('infers from names after stripping the shared prefix and suffix', () => {
    const s = schema();
    expect(rel(s, 'app_purchase_order_line_tab', 'order_item_id')).toMatchObject({ toTable: 'app_purchase_order_item_tab', via: 'name' });
    expect(rel(s, 'app_shipment_tab', 'order_item_id')?.toTable).toBe('app_purchase_order_item_tab');
    expect(rel(s, 'app_media_folders', 'parent_folder_id')?.toTable).toBe('app_media_folders');
  });

  it('drops leading words and expands aliases: buyer_dept_id -> department', () => {
    const s = schema();
    expect(rel(s, 'app_purchase_order_tab', 'buyer_dept_id')?.toTable).toBe('app_department_master_tab');
    expect(rel(s, 'app_purchase_order_line_tab', 'owner_dept_id')?.toTable).toBe('app_department_master_tab');
    expect(rel(s, 'app_product_catalog_master_tab', 'department_id')?.toTable).toBe('app_department_master_tab');
  });

  it('gives no answer when a name is ambiguous, rather than a wrong one', () => {
    const snapshot = fixture();
    snapshot.tables[4].columns[2].comment = '';
    expect(relations(snapshot).find((r) => r.fromColumns.includes('master_id'))).toBeUndefined();
  });

  it('rejects a link between incompatible types (varchar user_id is not an int id)', () => {
    const snapshot = fixture();
    snapshot.tables.push({ ...snapshot.tables[8], name: 'app_external_user_tab' });
    snapshot.tables[5].columns.push({ ...snapshot.tables[5].columns[3], name: 'user_id', columnType: 'varchar(50)', dataType: 'varchar' });
    expect(relations(snapshot).find((r) => r.fromColumns.includes('user_id'))).toBeUndefined();
    snapshot.tables[5].columns[4] = { ...snapshot.tables[5].columns[4], columnType: 'int', dataType: 'int' };
    expect(relations(snapshot).find((r) => r.fromColumns.includes('user_id'))?.toTable).toBe('app_external_user_tab');
  });

  it('links a table to itself only through parent_* columns', () => {
    const snapshot = fixture();
    // app_signature_tab.signature_id is an external id, not a self reference
    snapshot.tables.push({ ...snapshot.tables[8], name: 'app_signature_tab', columns: [snapshot.tables[8].columns[0], { ...snapshot.tables[8].columns[1], name: 'signature_id', columnType: 'int', dataType: 'int' }] });
    expect(relations(snapshot).find((r) => r.fromTable === 'app_signature_tab')).toBeUndefined();
  });

  it('does not loose-match what is left after dropping words (doc_reference_id is not *_reference)', () => {
    const snapshot = fixture();
    snapshot.tables.push({ ...snapshot.tables[8], name: 'app_product_type_reference_tab' });
    snapshot.tables[6].columns.push({ ...snapshot.tables[6].columns[1], name: 'doc_reference_id' });
    expect(relations(snapshot).find((r) => r.fromColumns.includes('doc_reference_id'))).toBeUndefined();
  });

  it('ignores comments that say values match rather than reference a key', () => {
    const snapshot = fixture();
    snapshot.tables[6].columns.push({ ...snapshot.tables[6].columns[2], name: 'shipment_label', comment: 'matches app_department_master_tab.department_name' });
    expect(relations(snapshot).find((r) => r.fromColumns.includes('shipment_label'))).toBeUndefined();
  });

  it('never links a table primary key to itself', () => {
    expect(schema().relations.some((r) => r.fromColumns.includes('id') && r.via === 'name')).toBe(false);
  });
});

group('lookups', () => {
  it('resolves table names exactly, case-insensitively, or by unique substring', () => {
    const s = schema();
    expect(s.table('APP_PURCHASE_ORDER_TAB').name).toBe('app_purchase_order_tab');
    expect(s.table('order_line').name).toBe('app_purchase_order_line_tab');
    expect(() => s.table('order')).toThrow(/not found uniquely/);
    expect(() => s.table('nothing_like_this')).toThrow(/not found/);
  });

  it('finds columns by substring and wildcard', () => {
    const s = schema();
    expect(q.findColumn(s, 'dept').map((c) => c.column).sort()).toEqual(['buyer_dept_id', 'owner_dept_id']);
    expect(q.findColumn(s, '*_no').map((c) => c.column).sort()).toEqual(['sku_no', 'tracking_no']);
  });

  it('parses enum values, including escaped quotes', () => {
    expect(q.enumValues("enum('ACTIVE','INACTIVE')")).toEqual(['ACTIVE', 'INACTIVE']);
    expect(q.enumValues("set('it''s','b')")).toEqual(["it's", 'b']);
    expect(q.enums(schema())).toEqual([{ table: 'app_product_type_master_tab', column: 'status', kind: 'enum', values: ['ACTIVE', 'INACTIVE'] }]);
  });

  it('builds the shortest join path with SQL, marking inferred hops', () => {
    const path = q.joinPath(schema(), 'app_shipment_tab', 'app_purchase_order_tab');
    expect(path.found).toBe(true);
    expect(path.steps.map((r) => r.via)).toEqual(['name', 'fk']);
    expect(path.joinSql).toContain('JOIN app_purchase_order_item_tab ON app_shipment_tab.order_item_id = app_purchase_order_item_tab.id  -- inferred (name)');
    expect(path.joinSql).toContain('JOIN app_purchase_order_tab ON app_purchase_order_item_tab.order_id = app_purchase_order_tab.id');
  });

  it('respects fk-only for join paths', () => {
    expect(q.joinPath(schema(), 'app_shipment_tab', 'app_purchase_order_tab', false).found).toBe(false);
  });

  it('checks index coverage by leading columns', () => {
    const s = schema();
    expect(q.checkIndex(s, 'app_purchase_order_tab', ['company']).coveringIndexes).toEqual(['idx_company_state']);
    expect(q.checkIndex(s, 'app_purchase_order_tab', ['state', 'company']).covered).toBe(true);
    const stateOnly = q.checkIndex(s, 'app_purchase_order_tab', ['state']);
    expect(stateOnly.covered).toBe(false);
    expect(() => q.checkIndex(s, 'app_purchase_order_tab', ['nope'])).toThrow(/no column/);
  });

  it('walks related tables in both directions to the requested depth', () => {
    const one = q.related(schema(), 'app_purchase_order_item_tab', 1).relations.map((r) => `${r.fromTable}->${r.toTable}`);
    expect(one).toEqual(expect.arrayContaining([
      'app_purchase_order_item_tab->app_purchase_order_tab',
      'app_purchase_order_item_tab->app_product_catalog_master_tab',
      'app_purchase_order_line_tab->app_purchase_order_item_tab',
      'app_shipment_tab->app_purchase_order_item_tab',
    ]));
    const two = q.related(schema(), 'app_purchase_order_item_tab', 2).relations;
    expect(two.some((r) => r.toTable === 'app_department_master_tab')).toBe(true);
  });

  it('lists orphans, and more of them when inferred links are ignored', () => {
    expect(q.findOrphans(schema()).map((t) => t.name)).toEqual(['app_product_type_master_tab', 'app_audit_log']);
    expect(q.findOrphans(schema(), false).length).toBeGreaterThan(2);
  });

  it('finds common columns and types', () => {
    expect(q.findCommonColumns(schema(), ['app_purchase_order_line_tab', 'app_shipment_tab']).map((c) => c.column))
      .toEqual(['id', 'order_item_id']);
  });

  it('searches names, comments, routines and triggers', () => {
    const hits = q.searchSchema(schema(), 'catalog_master');
    expect(hits.tables.map((t) => t.name)).toEqual(['app_product_catalog_master_tab']);
    expect(hits.columns.map((c) => c.column)).toEqual(['master_id']);
    expect(q.searchSchema(schema(), 'invoice').routines).toEqual([{ name: 'get_next_invoice_no', type: 'FUNCTION' }]);
  });
});

group('compact output', () => {
  it('shows one line per column with where it points', () => {
    const text = render('describe', q.describe(schema(), ['app_purchase_order_line_tab']), 'compact');
    expect(text).toContain('app_purchase_order_line_tab (table, ~10 rows)');
    expect(text).toContain('  id int PK auto_increment NOT NULL');
    expect(text).toContain('order_item_id int -> app_purchase_order_item_tab.id [inferred:name]');
  });

  it('lists who references a table and its triggers', () => {
    const text = render('describe', q.describe(schema(), ['app_shipment_tab']), 'compact');
    expect(text).toContain('triggers: trg_shipment_audit AFTER UPDATE');
    const item = render('describe', q.describe(schema(), ['app_purchase_order_item_tab']), 'compact');
    expect(item).toContain('referenced by: app_purchase_order_line_tab.order_item_id [inferred:name]');
    expect(item).toContain('order_id int idx NOT NULL -> app_purchase_order_tab.id');
    expect(item).toContain('fk rules: fk_item_order ON DELETE CASCADE ON UPDATE RESTRICT');
  });
});
