/** Everything extracted from information_schema for one database. */
export interface Snapshot {
  profile: string;
  database: string;
  serverVersion: string;
  extractedAt: string;
  fingerprint: string;
  tables: Table[];
  routines: Routine[];
  triggers: Trigger[];
}

export interface Table {
  name: string;
  kind: 'table' | 'view';
  engine: string | null;
  /** InnoDB's estimate, not an exact count. */
  approxRows: number | null;
  comment: string;
  columns: Column[];
  primaryKey: string[];
  indexes: Index[];
  foreignKeys: ForeignKey[];
  checks: CheckConstraint[];
  viewDefinition?: string;
}

export interface Column {
  name: string;
  position: number;
  /** Full type as declared, e.g. varchar(100), enum('a','b'), int unsigned. */
  columnType: string;
  /** Base type, e.g. varchar, int, enum. */
  dataType: string;
  nullable: boolean;
  default: string | null;
  /** PRI, UNI, MUL or empty. */
  key: string;
  extra: string;
  comment: string;
}

export interface Index {
  name: string;
  unique: boolean;
  columns: string[];
  type: string;
}

export interface ForeignKey {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface CheckConstraint {
  name: string;
  clause: string;
}

export interface Routine {
  name: string;
  type: 'FUNCTION' | 'PROCEDURE';
  returns: string | null;
  params: string[];
  comment: string;
}

export interface Trigger {
  name: string;
  table: string;
  timing: string;
  event: string;
}

/** How a relationship was found. fk is declared; comment and name are inferred. */
export type RelationVia = 'fk' | 'comment' | 'name';

export interface Relation {
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  via: RelationVia;
  /** Constraint name for fk, the evidence otherwise. */
  detail: string;
}

export type Format = 'compact' | 'json' | 'md';
