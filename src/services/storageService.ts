import { Project } from '../types';

const DB_NAME = 'aura_virtual_studio_db';
const DB_VERSION = 1;
const STORE_NAME = 'projects';
const LOCAL_STORAGE_KEY = 'aura_projects';

/**
 * Rehydrates ephemeral Blob URLs for any BVH motion data in projects.
 */
function rehydrateProjects(projects: Project[]): Project[] {
  return projects.map((p) => ({
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
}

/**
 * Strips ephemeral Blob URLs before serializing projects to disk or database.
 */
function cleanProjectsForStorage(projects: Project[]): Project[] {
  return projects.map((project) => ({
    ...project,
    characters: (project.characters || []).map((c) => ({
      ...c,
      bvhUrl: undefined,
    })),
  }));
}

/**
 * Persists all projects directly to the local file system (./data/projects.json)
 * via the Vite local dev server API.
 */
export async function saveProjectsToDisk(projects: Project[]): Promise<boolean> {
  try {
    const cleaned = cleanProjectsForStorage(projects);
    const resp = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cleaned),
    });
    return resp.ok;
  } catch (err) {
    console.warn('[StorageService] Local disk write failed:', err);
    return false;
  }
}

/**
 * Loads projects from the local file system (./data/projects.json) via Vite dev server.
 */
export async function loadProjectsFromDisk(): Promise<Project[] | null> {
  try {
    const resp = await fetch('/api/projects');
    if (!resp.ok) return null;
    const data = await resp.json();
    if (Array.isArray(data) && data.length > 0) {
      return rehydrateProjects(data);
    }
    if (data.projects && Array.isArray(data.projects) && data.projects.length > 0) {
      return rehydrateProjects(data.projects);
    }
    return null;
  } catch (err) {
    console.warn('[StorageService] Local disk read failed:', err);
    return null;
  }
}

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
 */
export async function saveProjectsToIndexedDB(projects: Project[]): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    // Clear stale projects and insert current state
    store.clear();
    const cleaned = cleanProjectsForStorage(projects);
    for (const project of cleaned) {
      store.put(project);
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
          resolve(rehydrateProjects(results));
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
 * Safely saves projects across all three tiers:
 * 1. Local Disk File (./data/projects.json) -> 100% immune to browser resets
 * 2. Full data (with all 77-joint rotations and BVH) -> IndexedDB
 * 3. Lightweight metadata -> LocalStorage (wrapped in try/catch to guarantee zero crashes)
 */
export async function persistProjectsSafely(projects: Project[]): Promise<void> {
  // 1. Primary: Persist to local disk JSON file via Vite API
  saveProjectsToDisk(projects).catch(() => {});

  // 2. Secondary: High-capacity browser IndexedDB
  await saveProjectsToIndexedDB(projects);

  // 3. Fallback: Lightweight metadata in localStorage
  try {
    const serialized = sanitizeProjectsForLocalStorage(projects);
    localStorage.setItem(LOCAL_STORAGE_KEY, serialized);
  } catch (err) {
    console.warn('[StorageService] LocalStorage quota exceeded, safely saved to disk and IndexedDB:', err);
  }
}

/**
 * High-reliability multi-tier loader:
 * 1. Try local disk file (./data/projects.json)
 * 2. Try browser IndexedDB
 * 3. Fallback to localStorage / default initial projects
 */
export async function loadProjectsSafely(defaultProjects: Project[]): Promise<Project[]> {
  // Tier 1: Local Disk File
  const diskProjects = await loadProjectsFromDisk();
  if (diskProjects && diskProjects.length > 0) {
    console.log(`[StorageService] Loaded ${diskProjects.length} project(s) from local disk (data/projects.json)`);
    return diskProjects;
  }

  // Tier 2: IndexedDB
  const idbProjects = await loadProjectsFromIndexedDB();
  if (idbProjects && idbProjects.length > 0) {
    console.log(`[StorageService] Loaded ${idbProjects.length} project(s) from IndexedDB`);
    // Sync to disk so future loads are instant
    saveProjectsToDisk(idbProjects).catch(() => {});
    return idbProjects;
  }

  // Tier 3: LocalStorage
  const localProjects = getInitialProjectsFromLocalStorage(defaultProjects);
  if (localProjects && localProjects.length > 0) {
    console.log(`[StorageService] Loaded ${localProjects.length} project(s) from localStorage`);
    saveProjectsToDisk(localProjects).catch(() => {});
    return localProjects;
  }

  return defaultProjects;
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
