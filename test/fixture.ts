import type { Column, Snapshot, Table } from '../src/types.js';

const col = (name: string, columnType: string, extra: Partial<Column> = {}): Column => ({
  name,
  position: 0,
  columnType,
  dataType: columnType.replace(/\(.*$/, '').split(' ')[0],
  nullable: true,
  default: null,
  key: '',
  extra: '',
  comment: '',
  ...extra,
});

const table = (name: string, columns: Column[], extra: Partial<Table> = {}): Table => ({
  name,
  kind: 'table',
  engine: 'InnoDB',
  approxRows: 10,
  comment: '',
  columns: columns.map((c, i) => ({ ...c, position: i + 1 })),
  primaryKey: ['id'],
  indexes: [{ name: 'PRIMARY', unique: true, columns: ['id'], type: 'BTREE' }],
  foreignKeys: [],
  checks: [],
  ...extra,
});

const id = () => col('id', 'int', { key: 'PRI', extra: 'auto_increment', nullable: false });

/** Shaped like a typical legacy schema: app_ prefix, _tab suffix, few declared FKs, comments naming table.column. */
export function fixture(): Snapshot {
  return {
    profile: 'test',
    database: 'app',
    serverVersion: '8.0.46',
    extractedAt: '2026-10-08T00:00:00.000Z',
    fingerprint: 'fp-1',
    tables: [
      table('app_department_master_tab', [id(), col('department_name', 'varchar(100)')]),
      table('app_product_type_master_tab', [id(), col('code', 'varchar(5)'), col('status', "enum('ACTIVE','INACTIVE')")]),
      table('app_product_catalog_master_tab', [id(), col('sku_no', 'varchar(100)'), col('department_id', 'int')]),
      table('app_purchase_order_tab', [id(), col('company', 'varchar(50)'), col('buyer_dept_id', 'int'), col('state', 'varchar(50)')], {
        indexes: [
          { name: 'PRIMARY', unique: true, columns: ['id'], type: 'BTREE' },
          { name: 'idx_company_state', unique: false, columns: ['company', 'state'], type: 'BTREE' },
        ],
      }),
      table('app_purchase_order_item_tab', [
        id(),
        col('order_id', 'int', { nullable: false, key: 'MUL' }),
        col('master_id', 'int', { comment: 'app_product_catalog_master_tab.id' }),
        col('quantity', 'int', { default: '1' }),
      ], {
        foreignKeys: [{ name: 'fk_item_order', columns: ['order_id'], refTable: 'app_purchase_order_tab', refColumns: ['id'], onUpdate: 'RESTRICT', onDelete: 'CASCADE' }],
      }),
      table('app_purchase_order_line_tab', [id(), col('order_item_id', 'int'), col('owner_dept_id', 'int'), col('owner', 'varchar(100)')]),
      table('app_shipment_tab', [id(), col('order_item_id', 'int'), col('tracking_no', 'varchar(50)')]),
      table('app_media_folders', [id(), col('parent_folder_id', 'int'), col('folder_name', 'varchar(200)')]),
      table('app_audit_log', [id(), col('action', 'varchar(100)')]),
      table('v_open_orders', [col('id', 'int')], { kind: 'view', primaryKey: [], indexes: [], viewDefinition: 'select id from app_purchase_order_tab' }),
    ],
    routines: [{ name: 'get_next_invoice_no', type: 'FUNCTION', returns: 'int', params: [], comment: '' }],
    triggers: [{ name: 'trg_shipment_audit', table: 'app_shipment_tab', timing: 'AFTER', event: 'UPDATE' }],
  };
}
