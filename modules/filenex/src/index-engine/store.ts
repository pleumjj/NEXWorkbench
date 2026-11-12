import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Collection, FileRecord, FileType } from '../types';

/**
 * The FileNEX index: one local SQLite file (Node's built-in node:sqlite — no native dependency, no server).
 * Holds metadata only. Deleting it never touches the files it describes.
 */
export class FileStore {
  private readonly db: DatabaseSync;
  private cache: Map<string, FileRecord> | null = null;

  constructor(private readonly file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS filenex_files (
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, ext TEXT NOT NULL, parent TEXT NOT NULL,
        location_id TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER, modified INTEGER NOT NULL, type TEXT NOT NULL,
        hash TEXT, hash_mtime INTEGER, indexed_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS filenex_files_location ON filenex_files(location_id);
      CREATE INDEX IF NOT EXISTS filenex_files_size ON filenex_files(size);
      CREATE TABLE IF NOT EXISTS filenex_collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS filenex_collection_items (
        collection_id TEXT NOT NULL, file_id TEXT NOT NULL, added INTEGER NOT NULL, PRIMARY KEY (collection_id, file_id));
    `);
  }

  private static row(r: any): FileRecord {
    return {
      id: r.id, name: r.name, extension: r.ext, path: r.path, parentPath: r.parent, locationId: r.location_id, sizeBytes: Number(r.size),
      createdAt: r.created != null ? new Date(Number(r.created)).toISOString() : null, modifiedAt: new Date(Number(r.modified)).toISOString(),
      fileType: r.type as FileType, hash: r.hash ?? null, indexedAt: new Date(Number(r.indexed_at)).toISOString(),
    };
  }

  /** All records (cached in memory between changes — search runs over this). */
  all(): FileRecord[] { return [...this.map().values()]; }
  get(id: string): FileRecord | null { return this.map().get(id) ?? null; }
  count(locationId?: string): number {
    return locationId ? this.all().filter(f => f.locationId === locationId).length : this.map().size;
  }
  private map() {
    if (!this.cache) this.cache = new Map((this.db.prepare('SELECT * FROM filenex_files').all() as any[]).map(r => [r.id, FileStore.row(r)]));
    return this.cache;
  }

  /** Insert or update in one transaction. Hash is kept only if the file did not change. */
  upsert(records: FileRecord[]) {
    if (!records.length) return;
    const stmt = this.db.prepare(`INSERT INTO filenex_files (id, path, name, ext, parent, location_id, size, created, modified, type, hash, hash_mtime, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, ext=excluded.ext, parent=excluded.parent, location_id=excluded.location_id,
        hash = CASE WHEN filenex_files.size = excluded.size AND filenex_files.modified = excluded.modified THEN filenex_files.hash ELSE NULL END,
        size=excluded.size, created=excluded.created, modified=excluded.modified, type=excluded.type, indexed_at=excluded.indexed_at`);
    this.tx(() => {
      for (const f of records) stmt.run(f.id, f.path, f.name, f.extension, f.parentPath, f.locationId, f.sizeBytes, f.createdAt ? Date.parse(f.createdAt) : null, Date.parse(f.modifiedAt), f.fileType, Date.parse(f.indexedAt));
    });
    this.cache = null;
  }

  remove(ids: string[]) {
    if (!ids.length) return;
    const del = this.db.prepare('DELETE FROM filenex_files WHERE id = ?');
    this.tx(() => { for (const id of ids) del.run(id); });
    this.cache = null;
  }

  setHash(id: string, hash: string, modifiedMs: number) {
    this.db.prepare('UPDATE filenex_files SET hash = ?, hash_mtime = ? WHERE id = ? AND modified = ?').run(hash, modifiedMs, id, modifiedMs);
    const f = this.cache?.get(id);
    if (f && Date.parse(f.modifiedAt) === modifiedMs) f.hash = hash;
  }

  /**
   * Deletes FileNEX's file metadata. Collections (and their items — ids are stable path hashes, so they reattach after
   * a rescan) are kept unless `includeCollections`. Never touches real files.
   */
  clear(includeCollections = false) {
    this.tx(() => {
      this.db.exec('DELETE FROM filenex_files');
      if (includeCollections) this.db.exec('DELETE FROM filenex_collection_items; DELETE FROM filenex_collections;');
    });
    this.cache = null;
    try { this.db.exec('VACUUM'); } catch { /* best effort */ }
  }

  /* ── collections (logical; never move files) ── */
  collections(): Collection[] {
    const cols = this.db.prepare('SELECT * FROM filenex_collections ORDER BY created DESC').all() as any[];
    const items = this.db.prepare('SELECT collection_id, file_id FROM filenex_collection_items ORDER BY added').all() as any[];
    return cols.map(c => ({ id: c.id, name: c.name, createdAt: new Date(Number(c.created)).toISOString(), fileIds: items.filter(i => i.collection_id === c.id).map(i => i.file_id) }));
  }
  createCollection(id: string, name: string) { this.db.prepare('INSERT INTO filenex_collections (id, name, created) VALUES (?, ?, ?)').run(id, name, Date.now()); }
  renameCollection(id: string, name: string) { this.db.prepare('UPDATE filenex_collections SET name = ? WHERE id = ?').run(name, id); }
  deleteCollection(id: string) { this.tx(() => { this.db.prepare('DELETE FROM filenex_collection_items WHERE collection_id = ?').run(id); this.db.prepare('DELETE FROM filenex_collections WHERE id = ?').run(id); }); }
  addItem(collectionId: string, fileId: string) { this.db.prepare('INSERT OR IGNORE INTO filenex_collection_items (collection_id, file_id, added) VALUES (?, ?, ?)').run(collectionId, fileId, Date.now()); }
  removeItem(collectionId: string, fileId: string) { this.db.prepare('DELETE FROM filenex_collection_items WHERE collection_id = ? AND file_id = ?').run(collectionId, fileId); }

  sizeBytes(): number {
    if (this.file === ':memory:') return 0;
    return [this.file, `${this.file}-wal`].reduce((n, f) => { try { return n + statSync(f).size; } catch { return n; } }, 0);
  }
  close() { try { this.db.close(); } catch { /* already closed */ } }

  private tx(fn: () => void) {
    this.db.exec('BEGIN');
    try { fn(); this.db.exec('COMMIT'); } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}
