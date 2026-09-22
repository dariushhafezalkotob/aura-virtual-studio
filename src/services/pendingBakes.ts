/**
 * Baked models that are in the scene but not yet on the server.
 *
 * A baked GLB carries a 2048 texture, so it is megabytes. On a slow uplink, uploading one the
 * moment it is added to the scene means staring at a spinner for minutes before you can carry on
 * working - so the upload is deferred until the stage is saved.
 *
 * Deferring it in memory alone would mean a refresh or a crash loses the bake, so the bytes are
 * parked in IndexedDB the moment the model is added. That write is local and instant regardless
 * of the connection. On the next load the blob URLs are recreated from here, and the next save
 * uploads whatever is still pending.
 *
 * This is deliberately its own database rather than a new store inside the projects one: bumping
 * that database's version to add a store would put every existing project through an upgrade for
 * a feature that has nothing to do with them.
 */

const DB_NAME = 'aura_pending_bakes';
const DB_VERSION = 1;
const STORE_NAME = 'bakes';

export interface PendingBake {
  /** The scene asset's id - this is what ties the stored bytes back to the object in the scene. */
  id: string;
  name: string;
  blob: Blob;
  createdAt: string;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      return reject(new Error('IndexedDB is not available'));
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finish(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Parks a baked GLB locally. Failure is never fatal: the model still works for this session. */
export async function savePendingBake(id: string, name: string, blob: Blob): Promise<boolean> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put({ id, name, blob, createdAt: new Date().toISOString() });
    await finish(tx);
    return true;
  } catch (err) {
    console.warn('[pendingBakes] could not park the baked model locally:', err);
    return false;
  }
}

export async function listPendingBakes(): Promise<PendingBake[]> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    return await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve((req.result as PendingBake[]) || []);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[pendingBakes] could not read parked models:', err);
    return [];
  }
}

export async function deletePendingBake(id: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    await finish(tx);
  } catch (err) {
    console.warn('[pendingBakes] could not clear a parked model:', err);
  }
}
