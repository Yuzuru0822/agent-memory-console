import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SecretCodec } from '../private-store';
import { noLinks } from '../safety';

/** Only opaque IDs and record kinds are plaintext. Every payload, including events, is sealed. */
export class WorkbenchStore {
  private db: DatabaseSync;
  constructor(directory: string, private codec: SecretCodec) {
    noLinks(directory); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'workbench.sqlite');
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      noLinks(file + suffix);
      if (fs.existsSync(file + suffix) && fs.statSync(file + suffix).nlink !== 1) throw new Error('工作台数据库不允许硬链接');
    }
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = Number((this.db.prepare('PRAGMA user_version').get() as any).user_version);
    if (version > 1) { this.db.close(); throw new Error('工作台数据库来自较新版本，禁止降级写入'); }
    this.db.exec('CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,id)); PRAGMA user_version=1;');
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT payload FROM records WHERE kind=? AND id=?').get(kind, id);
    return row ? JSON.parse(this.codec.open(String(row.payload))) : undefined;
  }
  all<T>(kind: string): T[] {
    return this.db.prepare('SELECT payload FROM records WHERE kind=? ORDER BY rowid').all(kind).map(row => JSON.parse(this.codec.open(String(row.payload))));
  }
  put<T extends { id: string }>(kind: string, value: T): void {
    this.db.prepare('INSERT INTO records(kind,id,payload) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload').run(kind, value.id, this.codec.seal(JSON.stringify(value)));
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
