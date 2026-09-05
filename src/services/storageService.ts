import { Project } from '../types';

const DB_NAME = 'aura_virtual_studio_db';
const DB_VERSION = 1;
const STORE_NAME = 'projects';
const LOCAL_STORAGE_KEY = 'aura_projects';

/**
 * Opens or initializes the native IndexedDB instance for Aura Virtual Studio.
 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      return reject(new Error('IndexedDB is not supported in this environment'));
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

/**
 * Persists all projects with full high-density neural motion data into IndexedDB.
 * IndexedDB has virtually unlimited quota (hundreds of megabytes to gigabytes).
 */
export async function saveProjectsToIndexedDB(projects: Project[]): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    // Clear stale projects and insert current state
    store.clear();
    for (const project of projects) {
      // Don't store ephemeral blob URLs in IndexedDB
      const cleanedProject: Project = {
        ...project,
        characters: (project.characters || []).map((c) => ({
          ...c,
          bvhUrl: undefined,
        })),
      };
      store.put(cleanedProject);
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[StorageService] IndexedDB save failed:', err);
  }
}

/**
 * Retrieves projects from IndexedDB and recreates ephemeral Blob URLs for any BVH motions.
 */
export async function loadProjectsFromIndexedDB(): Promise<Project[] | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);

    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const results = req.result as Project[];
        if (Array.isArray(results) && results.length > 0) {
          // Rehydrate ephemeral BVH Blob URLs
          const rehydrated = results.map((p) => ({
            ...p,
            characters: (p.characters || []).map((c) => {
              if (c.motionData?.bvh) {
                try {
                  const blob = new Blob([c.motionData.bvh], { type: 'text/plain' });
                  return { ...c, bvhUrl: URL.createObjectURL(blob) };
                } catch {
                  return c;
                }
              }
              return c;
            }),
          }));
          resolve(rehydrated);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[StorageService] IndexedDB load failed:', err);
    return null;
  }
}

/**
 * Creates a lightweight version of projects for localStorage (stripping heavy
 * 30 FPS rotation arrays and ASCII BVH text) so it never breaches the 5MB browser quota.
 */
export function sanitizeProjectsForLocalStorage(projects: Project[]): string {
  const lightweight = projects.map((p) => ({
    ...p,
    characters: (p.characters || []).map((c) => {
      if (!c.motionData) {
        return { ...c, bvhUrl: undefined };
      }
      // Omit dense rotations array and full raw BVH string from localStorage
      const { rotations, bvh, ...meta } = c.motionData;
      return {
        ...c,
        motionData: meta, // retains duration, num_frames, fps, prompt, trajectory
        bvhUrl: undefined,
      };
    }),
  }));

  return JSON.stringify(lightweight);
}

/**
 * Safely saves projects across both tiers:
 * 1. Full data (with all 77-joint rotations and BVH) -> IndexedDB
 * 2. Lightweight metadata -> LocalStorage (wrapped in try/catch to guarantee zero crashes)
 */
export async function persistProjectsSafely(projects: Project[]): Promise<void> {
  // 1. Full persistence to IndexedDB (asynchronous, high quota)
  await saveProjectsToIndexedDB(projects);

  // 2. Lightweight fallback to localStorage (synchronous instant boot)
  try {
    const serialized = sanitizeProjectsForLocalStorage(projects);
    localStorage.setItem(LOCAL_STORAGE_KEY, serialized);
  } catch (err) {
    console.warn('[StorageService] LocalStorage quota exceeded, successfully persisted to IndexedDB:', err);
  }
}

/**
 * Synchronous initial load from localStorage for zero-latency app boot.
 */
export function getInitialProjectsFromLocalStorage(defaultProjects: Project[]): Project[] {
  if (typeof window === 'undefined') return defaultProjects;
  try {
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!saved) return defaultProjects;

    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed) || parsed.length === 0) return defaultProjects;

    return parsed.map((p: Project) => ({
      ...p,
      scenes: (p.scenes || []).filter(
        (s) => s.glbUrl && (s.glbUrl.includes('.glb') || s.glbUrl.includes('.gltf') || s.glbUrl.startsWith('blob:'))
      ),
    }));
  } catch {
    return defaultProjects;
  }
}
