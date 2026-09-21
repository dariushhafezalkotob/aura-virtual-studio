import fs from 'node:fs';
import path from 'node:path';

/**
 * Keeps the bulk of a project out of projects.json.
 *
 * Camera-take keyframes and actor motion are big numeric arrays - 28 MB of takes in one project
 * here, 2-6 MB per actor - and they were stored inline, so every save rewrote all of it and two
 * open tabs could overwrite each other's work. They now live one file per take and per actor
 * under data/blobs/, and projects.json keeps a reference.
 *
 * Reads put the payloads back before the project leaves the server, so the app sees exactly the
 * shape it always has.
 */

/** Sent by the client in place of a payload the server already has on disk. */
export const UNCHANGED = '__aura_unchanged__';

interface BlobRef {
  $blob: string;
}

/**
 * Take thumbnails are captured as base64 PNG data URLs - 2.6 MB each, and a project here has
 * eighteen of them, which was most of its 32 MB. They are only ever used as an <img src>, so they
 * become real image files and the project keeps the URL. Unlike the payloads below this is a
 * one-way conversion: nothing has to put it back, and the browser gets to cache them.
 */
function externalizeDataUrlImage(value: any, dataDir: string, name: string): any {
  if (typeof value !== 'string' || !value.startsWith('data:image/')) return value;

  const match = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(value);
  if (!match) return value;

  const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  const filename = `${safeSegment(name)}.${safeSegment(ext)}`;
  const assetsDir = path.join(dataDir, 'assets');

  try {
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, filename), Buffer.from(match[2], 'base64'));
    return `/api/assets/${filename}`;
  } catch (err) {
    console.warn('[projectStore] Could not write thumbnail:', (err as any)?.message || err);
    return value;
  }
}

/** Fields that get their own file: [collection on the project, field on each item, filename kind]. */
const HEAVY_FIELDS: Array<{ collection: string; field: string; kind: string }> = [
  { collection: 'cameraTakes', field: 'keyframes', kind: 'take' },
  { collection: 'characters', field: 'motionData', kind: 'motion' },
];

function isBlobRef(v: any): v is BlobRef {
  return !!v && typeof v === 'object' && typeof v.$blob === 'string';
}

/** One path segment, safe for any project or take id the app may produce. */
function safeSegment(id: string): string {
  return String(id || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
}

function blobRelPath(projectId: string, kind: string, itemId: string, scope?: string): string {
  // `scope` keeps one account's blobs out of another's directory. Paths written before
  // accounts existed have no scope and keep working, because the stored ref is a full path.
  const parts = ['blobs'];
  if (scope) parts.push(safeSegment(scope));
  parts.push(safeSegment(projectId), `${kind}_${safeSegment(itemId)}.json`);
  return path.join(...parts);
}

/**
 * What the store currently holds for one field, so an UNCHANGED marker can be resolved against it.
 * Keyed "<projectId>/<collection>/<itemId>".
 */
function indexStored(previous: any[]): Map<string, any> {
  const index = new Map<string, any>();
  if (!Array.isArray(previous)) return index;

  for (const project of previous) {
    if (!project || typeof project !== 'object') continue;
    for (const { collection, field } of HEAVY_FIELDS) {
      for (const item of project[collection] || []) {
        if (item && typeof item === 'object' && item[field] !== undefined) {
          index.set(`${project.id}/${collection}/${item.id}`, item[field]);
        }
      }
    }
  }
  return index;
}

/**
 * Takes the project array the browser sent and writes every heavy payload to its own file,
 * leaving a reference behind.
 *
 * `previous` is what projects.json holds right now. An UNCHANGED marker is resolved against it,
 * which matters on the first save after the split: the client rightly says it has not touched a
 * take, but the payload is still sitting inline in projects.json rather than in a blob file.
 */
export function externalizeProjects(
  projects: any[],
  dataDir: string,
  previous: any[] = [],
  blobScope?: string
): any[] {
  if (!Array.isArray(projects)) return projects;
  const stored = indexStored(previous);

  return projects.map((project) => {
    if (!project || typeof project !== 'object') return project;
    const projectId = project.id || 'unknown';
    const out: any = { ...project };

    out.thumbnail = externalizeDataUrlImage(project.thumbnail, dataDir, `project_thumb_${projectId}`);

    if (Array.isArray(project.cameraTakes)) {
      out.cameraTakes = project.cameraTakes.map((take: any) =>
        take && typeof take === 'object'
          ? {
              ...take,
              thumbnail: externalizeDataUrlImage(
                take.thumbnail,
                dataDir,
                `take_thumb_${projectId}_${take.id}`
              ),
            }
          : take
      );
    }

    for (const { collection, field, kind } of HEAVY_FIELDS) {
      // Read from `out`, not `project`: the thumbnail pass above already rewrote cameraTakes.
      const items = out[collection];
      if (!Array.isArray(items)) continue;

      out[collection] = items.map((item: any) => {
        if (!item || typeof item !== 'object') return item;
        const value = item[field];

        // Already a reference (a save that never rehydrated): leave it exactly as it is.
        if (isBlobRef(value)) return item;

        const rel = blobRelPath(projectId, kind, item.id, blobScope);
        const abs = path.join(dataDir, rel);

        let payload = value;

        if (value === UNCHANGED) {
          const prior = stored.get(`${projectId}/${collection}/${item.id}`);

          // Already a blob and the file is still there: nothing to write.
          if (isBlobRef(prior) && fs.existsSync(path.join(dataDir, prior.$blob))) {
            return { ...item, [field]: prior };
          }

          // Still inline from before the split - write it out now rather than lose it.
          if (prior !== undefined && prior !== null && !isBlobRef(prior)) {
            payload = prior;
          } else {
            // Nothing on disk to stand behind the marker. Keep whatever reference existed, and
            // never silently drop the field.
            console.warn(`[projectStore] No stored payload for ${projectId}/${collection}/${item.id}.${field}`);
            return isBlobRef(prior) ? { ...item, [field]: prior } : item;
          }
        }

        if (payload === undefined || payload === null) return item;

        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const tmp = path.join(path.dirname(abs), `.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`);
        fs.writeFileSync(tmp, JSON.stringify(payload), 'utf-8');
        fs.renameSync(tmp, abs);

        return { ...item, [field]: { $blob: rel } };
      });
    }

    return out;
  });
}

/** Puts every referenced payload back, so callers get the same shape the app has always seen. */
export function rehydrateProjects(projects: any[], dataDir: string): any[] {
  if (!Array.isArray(projects)) return projects;

  return projects.map((project) => {
    if (!project || typeof project !== 'object') return project;
    const out: any = { ...project };

    for (const { collection, field } of HEAVY_FIELDS) {
      const items = project[collection];
      if (!Array.isArray(items)) continue;

      out[collection] = items.map((item: any) => {
        if (!item || typeof item !== 'object' || !isBlobRef(item[field])) return item;
        const abs = path.join(dataDir, item[field].$blob);
        try {
          return { ...item, [field]: JSON.parse(fs.readFileSync(abs, 'utf-8')) };
        } catch (err) {
          // A missing blob must not take the whole project list down with it.
          console.warn(`[projectStore] Could not read ${item[field].$blob}:`, (err as any)?.message || err);
          return { ...item, [field]: undefined };
        }
      });
    }

    return out;
  });
}

/**
 * Copies projects.json aside once, the first time this store externalizes anything, so the
 * pre-split file is still there if something about the new layout turns out to be wrong.
 */
export function backupProjectsOnce(projectsFilePath: string, dataDir: string) {
  const marker = path.join(dataDir, '.projects-split-backup');
  if (fs.existsSync(marker) || !fs.existsSync(projectsFilePath)) return;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(dataDir, `projects.before-split.${stamp}.json`);
    fs.copyFileSync(projectsFilePath, backup);
    fs.writeFileSync(marker, backup, 'utf-8');
    console.log(`[projectStore] Kept a copy of the pre-split projects.json at ${backup}`);
  } catch (err) {
    console.warn('[projectStore] Could not write the pre-split backup:', (err as any)?.message || err);
  }
}
