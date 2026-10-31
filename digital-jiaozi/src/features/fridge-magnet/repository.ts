import type { MagnetWork, Panel } from './types.ts';
export const magnetDbName = (sample = false) => 'digital-jiaozi:magnet:' + (sample ? 'sample' : 'personal');
const storageError = () => new Error('本机作品库保存失败，可能是空间不足或浏览器限制。请下载当前图片后再离开。');
export class MagnetRepository {
  private db: IDBDatabase;
  private constructor(db: IDBDatabase) { this.db = db; }
  static async open(sample = false) {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(magnetDbName(sample), 1);
      request.onupgradeneeded = () => request.result.createObjectStore('works', { keyPath: 'id' });
      request.onerror = () => reject(storageError()); request.onblocked = () => reject(storageError());
      request.onsuccess = () => resolve(request.result);
    });
    db.onversionchange = () => db.close();
    return new MagnetRepository(db);
  }
  close() { this.db.close(); }
  private transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      let output: T, reason: unknown;
      try {
        const tx = this.db.transaction('works', mode);
        tx.oncomplete = () => resolve(output);
        tx.onerror = tx.onabort = () => reject(reason || storageError());
        try { run(tx.objectStore('works'), value => { output = value; }); }
        catch (error) { reason = error; tx.abort(); }
      } catch { reject(storageError()); }
    });
  }
  list() { return this.transaction<MagnetWork[]>('readonly', (s, done) => { const r = s.getAll(); r.onsuccess = () => done(r.result.sort((a: MagnetWork, b: MagnetWork) => b.updatedAt.localeCompare(a.updatedAt))); }); }
  get(id: string) { return this.transaction<MagnetWork | undefined>('readonly', (s, done) => { const r = s.get(id); r.onsuccess = () => done(r.result); }); }
  save(work: MagnetWork) {
    return this.transaction<MagnetWork>('readwrite', (s, done) => {
      const r = s.get(work.id);
      r.onsuccess = () => {
        const old = r.result as MagnetWork | undefined;
        if (old && old.revision !== work.revision) { s.transaction.abort(); return; }
        const next = { ...work, revision: work.revision + 1, updatedAt: new Date().toISOString() };
        s.put(next); done(next);
      };
    });
  }
  begin(work: MagnetWork, requestId: string, explicitRetry = false) {
    // Compare-and-swap prevents two tabs from submitting the same saved version.
    if (work.task?.state === 'GENERATING' && !explicitRetry) return Promise.reject(new Error('此作品已有未确认的请求，请勿重复提交'));
    return this.save({ ...work, task: { id: requestId, state: 'GENERATING', startedAt: new Date().toISOString() } });
  }
  finish(id: string, requestId: string, result: Panel | { error: string; uncertain: boolean }) {
    return this.transaction<MagnetWork>('readwrite', (s, done) => {
      const r = s.get(id);
      r.onsuccess = () => {
        const old = r.result as MagnetWork | undefined;
        if (!old || old.task?.id !== requestId) { s.transaction.abort(); return; }
        const next: MagnetWork = { ...old, revision: old.revision + 1, updatedAt: new Date().toISOString(),
          task: { ...old.task, state: 'blob' in result ? 'READY' : result.uncertain ? 'UNKNOWN' : 'FAILED', error: 'error' in result ? result.error : undefined } };
        if ('blob' in result) { next.panel = result; next.panelCrop = { x: 0, y: 0, width: 1, height: 1 }; }
        s.put(next); done(next);
      };
    });
  }
}
export async function resetMagnetSample() {
  await new Promise<void>((resolve, reject) => {
    const r = indexedDB.deleteDatabase(magnetDbName(true));
    r.onsuccess = () => resolve(); r.onerror = r.onblocked = () => reject(new Error('请关闭其他示例页面后重置'));
  });
}
