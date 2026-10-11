import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SnapshotSummary, WorkspaceInfo, WorkspaceState } from '@caixa/shared';
import { parseWorkspaceState } from '@caixa/shared';
import { openDatabase, schemaVersion } from './database.js';
import { BusinessError } from './validation.js';

const maxSnapshotBytes = 128 * 1024 * 1024;
const maxWorkspaceBytes = 1024 * 1024;
const dataTables = ['owners', 'products', 'fairs', 'sales', 'sale_items', 'days', 'stock_adjustments', 'spreadsheet_records'] as const;
const allTables = [...dataTables, 'workspace'] as const;
const deleteOrder = ['workspace', 'spreadsheet_records', 'sale_items', 'days', 'stock_adjustments', 'sales', 'products', 'fairs', 'owners'] as const;
const insertOrder = ['owners', 'fairs', 'products', 'sales', 'sale_items', 'days', 'stock_adjustments', 'spreadsheet_records', 'workspace'] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sqliteHeader = Buffer.from('SQLite format 3\0', 'binary');

export interface PreparedSnapshot {
  path: string;
  workspace: WorkspaceInfo;
  summary: SnapshotSummary;
  dispose(): void;
}

function quoteIdentifier(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
function invalidArchive(message: string): BusinessError { return new BusinessError(400, `Arquivo .caixa inválido: ${message}`); }
function conflict(message: string): BusinessError { return new BusinessError(409, message); }
function isUuid(value: unknown): value is string { return typeof value === 'string' && uuidPattern.test(value); }
function validateSavedAt(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function schemaObjects(db: Database.Database): unknown[] {
  return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
}

function columnShapes(db: Database.Database): Record<string, unknown[]> {
  return Object.fromEntries(allTables.map(table => [table, db.pragma(`table_xinfo(${quoteIdentifier(table)})`)])) as Record<string, unknown[]>;
}

function verifyCanonicalSchema(db: Database.Database): void {
  if (db.pragma('user_version', { simple: true }) !== schemaVersion || schemaVersion !== 6) {
    throw invalidArchive('a versão do esquema não é a versão 6 esperada.');
  }
  let canonical: Database.Database | undefined;
  try {
    canonical = openDatabase(':memory:');
    if (canonical.pragma('user_version', { simple: true }) !== 6) throw new Error('schema canônico não está na versão 6');
    if (JSON.stringify(schemaObjects(db)) !== JSON.stringify(schemaObjects(canonical))) {
      throw invalidArchive('o esquema contém tabelas, índices, gatilhos ou visões desconhecidos.');
    }
    if (JSON.stringify(columnShapes(db)) !== JSON.stringify(columnShapes(canonical))) {
      throw invalidArchive('as colunas não correspondem ao esquema do aplicativo.');
    }
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    throw invalidArchive('não foi possível comparar com o esquema do aplicativo.');
  } finally { canonical?.close(); }
}

function validateStateContext(db: Database.Database, state: WorkspaceState): void {
  const fairExists = (fairId: number) => Boolean(db.prepare('SELECT 1 FROM fairs WHERE id=?').get(fairId));
  if (state.fairId !== null && !fairExists(state.fairId)) throw invalidArchive('a feira selecionada não existe no arquivo.');
  for (const key of Object.keys(state.drafts)) {
    if (key.startsWith('caixa-feira-draft-v2-')) {
      const fairId = Number(key.slice('caixa-feira-draft-v2-'.length));
      if (!fairExists(fairId)) throw invalidArchive(`a feira do rascunho ${fairId} não existe no arquivo.`);
    }
  }
}

export function readWorkspace(db: Database.Database): WorkspaceInfo | null {
  const table = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='workspace'").get();
  if (!table) return null;
  const row = db.prepare('SELECT id,generation,saved_at,state,import_id,backup_path FROM workspace WHERE id=1').get() as
    { id: number; generation: string; saved_at: string; state: string; import_id: string | null; backup_path: string | null } | undefined;
  if (!row) return null;
  if (row.id !== 1 || !isUuid(row.generation) || !validateSavedAt(row.saved_at)
    || row.import_id !== null && !isUuid(row.import_id)
    || row.backup_path !== null && (typeof row.backup_path !== 'string' || !row.backup_path.length || row.backup_path.length > 4096)
    || typeof row.state !== 'string' || Buffer.byteLength(row.state, 'utf8') > maxWorkspaceBytes) {
    throw conflict('O estado salvo do aplicativo está inválido.');
  }
  let state: WorkspaceState;
  try { state = parseWorkspaceState(JSON.parse(row.state) as unknown); }
  catch { throw conflict('O estado salvo do aplicativo está inválido.'); }
  try { validateStateContext(db, state); }
  catch (error) {
    if (error instanceof BusinessError) throw conflict('O estado salvo aponta para uma feira inexistente.');
    throw error;
  }
  return { generation: row.generation, savedAt: row.saved_at, state, importId: row.import_id, backupPath: row.backup_path };
}

function encodeSqlValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return ['blob', value.toString('base64')];
  if (value === null) return ['null'];
  if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)];
  if (typeof value === 'string') return ['text', value];
  throw new Error('A base contém um tipo SQLite não reconhecido.');
}

export function snapshotFingerprint(db: Database.Database): string {
  const content = dataTables.map(table => {
    const rows = db.prepare(`SELECT rowid AS "__caixa_rowid",* FROM ${quoteIdentifier(table)} ORDER BY rowid`).all() as Record<string, unknown>[];
    return [table, rows.map(row => Object.keys(row).map(key => [key, encodeSqlValue(row[key])]))];
  });
  return createHash('sha256').update(JSON.stringify([schemaVersion, content]), 'utf8').digest('hex');
}

export function captureSnapshot(db: Database.Database, rawState: WorkspaceState): { bytes: Buffer; workspace: WorkspaceInfo } {
  const state = parseWorkspaceState(rawState);
  const transaction = db.transaction(() => {
    validateStateContext(db, state);
    const previous = readWorkspace(db);
    const workspace: WorkspaceInfo = {
      generation: previous?.generation ?? randomUUID(),
      savedAt: new Date().toISOString(),
      state,
      importId: previous?.importId ?? null,
      backupPath: previous?.backupPath ?? null
    };
    db.prepare(`INSERT INTO workspace(id,generation,saved_at,state,import_id,backup_path) VALUES(1,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,saved_at=excluded.saved_at,state=excluded.state,
        import_id=excluded.import_id,backup_path=excluded.backup_path`)
      .run(workspace.generation, workspace.savedAt, JSON.stringify(workspace.state), workspace.importId, workspace.backupPath);
    const bytes = db.serialize();
    if (bytes.byteLength > maxSnapshotBytes) throw new BusinessError(400, 'O banco ultrapassa o limite de 128 MiB para um arquivo .caixa.');
    return { bytes, workspace };
  });
  return transaction.immediate();
}

function workspaceFromDatabase(db: Database.Database): WorkspaceInfo {
  let workspace: WorkspaceInfo | null;
  try { workspace = readWorkspace(db); }
  catch { throw invalidArchive('o estado de trabalho está inválido.'); }
  if (!workspace) throw invalidArchive('não contém o estado de trabalho do aplicativo.');
  return workspace;
}

function rowCount(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get() as { count: number }).count;
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeDurableExclusive(path: string, bytes: Buffer): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* keep original error */ } }
    throw error;
  }
}

function copySnapshotRows(db: Database.Database): void {
  db.pragma('defer_foreign_keys = ON');
  for (const table of deleteOrder) db.exec(`DELETE FROM main.${quoteIdentifier(table)}`);
  for (const table of insertOrder) {
    const columns = db.pragma(`table_info(${quoteIdentifier(table)})`) as { name: string; type: string; pk: number }[];
    const names = columns.map(column => column.name);
    const integerPrimaryKey = columns.length > 0 && columns.filter(column => column.pk > 0).length === 1
      && columns.find(column => column.pk > 0)?.type.toUpperCase() === 'INTEGER';
    const fields = [...(integerPrimaryKey ? [] : ['rowid']), ...names].map(quoteIdentifier).join(',');
    db.exec(`INSERT INTO main.${quoteIdentifier(table)}(${fields}) SELECT ${fields} FROM imported.${quoteIdentifier(table)} ORDER BY rowid`);
  }
}

function validateDatabaseContents(db: Database.Database): void {
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw invalidArchive('a verificação de integridade SQLite falhou.');
  if ((db.pragma('foreign_key_check') as unknown[]).length) throw invalidArchive('há referências entre tabelas inválidas.');
  if (rowCount(db, 'fairs') === 0) throw invalidArchive('não há nenhuma feira para abrir o caixa.');
}

export function prepareSnapshot(bytes: Buffer): PreparedSnapshot {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < sqliteHeader.byteLength || bytes.byteLength > maxSnapshotBytes
    || !bytes.subarray(0, sqliteHeader.byteLength).equals(sqliteHeader)) {
    throw invalidArchive('cabeçalho SQLite incorreto ou tamanho fora do limite de 128 MiB.');
  }
  const folder = mkdtempSync(join(tmpdir(), 'caixa-snapshot-'));
  const path = join(folder, 'snapshot.sqlite');
  let db: Database.Database | undefined;
  try {
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    db = new Database(path, { fileMustExist: true });
    db.pragma('foreign_keys = ON');
    verifyCanonicalSchema(db);
    validateDatabaseContents(db);
    const workspace = workspaceFromDatabase(db);
    validateStateContext(db, workspace.state);
    const summary: SnapshotSummary = {
      savedAt: workspace.savedAt,
      date: workspace.state.date,
      view: workspace.state.view,
      fairId: workspace.state.fairId,
      owners: rowCount(db, 'owners'),
      products: rowCount(db, 'products'),
      sales: rowCount(db, 'sales'),
      days: rowCount(db, 'days'),
      fairs: rowCount(db, 'fairs'),
      drafts: Object.keys(workspace.state.drafts).length
    };
    const journalMode = db.pragma('journal_mode = DELETE', { simple: true });
    if (journalMode !== 'delete') throw invalidArchive('não foi possível tornar a cópia independente de arquivos WAL.');
    db.close(); db = undefined;
    if (['-wal', '-shm', '-journal'].some(suffix => existsSync(`${path}${suffix}`))) {
      throw invalidArchive('a cópia temporária ainda depende de um arquivo auxiliar SQLite.');
    }
    return {
      path, workspace, summary,
      dispose() { rmSync(folder, { recursive: true, force: true }); }
    };
  } catch (error) {
    if (db?.open) { try { db.close(); } catch { /* cleanup below removes only the staging copy */ } }
    rmSync(folder, { recursive: true, force: true });
    if (error instanceof BusinessError) throw error;
    throw invalidArchive('não foi possível abrir e validar o banco SQLite.');
  }
}

export function restoreSnapshot(
  db: Database.Database,
  candidate: PreparedSnapshot,
  currentState: WorkspaceState,
  expectedFingerprint: string,
  backupRoot: string,
  operationId: string
): WorkspaceInfo {
  const state = parseWorkspaceState(currentState);
  if (!isUuid(operationId)) throw new BusinessError(400, 'Identificador da importação inválido.');
  const previousWorkspace = readWorkspace(db);
  if (previousWorkspace?.importId === operationId) return previousWorkspace;
  if (!/^[0-9a-f]{64}$/i.test(expectedFingerprint)) throw new BusinessError(400, 'A impressão digital do banco atual é inválida.');

  db.prepare('ATTACH DATABASE ? AS imported').run(candidate.path);
  let publishedBackup: string | null = null;
  let didCommit = false;
  try {
    const transaction = db.transaction(() => {
      if (snapshotFingerprint(db) !== expectedFingerprint) throw conflict('O caixa mudou desde a confirmação. Confira os dados e tente importar novamente.');
      validateStateContext(db, state);
      const backup = captureSnapshot(db, state);
      mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
      publishedBackup = join(backupRoot, `caixa-backup-${new Date().toISOString().replaceAll(':', '-')}-${operationId}.caixa`);
      writeDurableExclusive(publishedBackup, backup.bytes);

      copySnapshotRows(db);
      const importedState = candidate.workspace.state;
      validateStateContext(db, importedState);
      validateDatabaseContents(db);
      const workspace: WorkspaceInfo = {
        generation: randomUUID(),
        savedAt: new Date().toISOString(),
        state: importedState,
        importId: operationId,
        backupPath: publishedBackup
      };
      db.prepare(`UPDATE workspace SET generation=?,saved_at=?,state=?,import_id=?,backup_path=? WHERE id=1`)
        .run(workspace.generation, workspace.savedAt, JSON.stringify(workspace.state), workspace.importId, workspace.backupPath);
      return workspace;
    });
    const result = transaction.immediate();
    didCommit = true;
    return result;
  } catch (error) {
    if (!didCommit && publishedBackup) {
      try { rmSync(publishedBackup, { force: true }); fsyncDirectory(backupRoot); } catch { /* retain a complete backup if cleanup cannot be made durable */ }
    }
    throw error;
  } finally {
    try { db.exec('DETACH DATABASE imported'); } catch { /* SQLite may require detach after transaction cleanup */ }
  }
}

