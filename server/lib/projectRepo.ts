import { ObjectId } from 'mongodb';
import { getDb } from './db';
import { externalizeProjects, rehydrateProjects } from './projectStore';

/**
 * Projects, one document per project, owned by a user.
 *
 * The document holds everything small - scenes, actors, constraints, dialogue, take metadata.
 * The heavy parts (camera keyframes, actor motion) stay as files referenced by {$blob}, exactly
 * as they were before accounts existed: a Mongo document caps at 16 MB and a single actor's
 * motion can be 6 MB, so inlining them would be a wall you hit eventually.
 */

const COLLECTION = 'projects';

/** Blobs live under the owner, so one user's files can never be served to another. */
export function blobScopeFor(userId: ObjectId): string {
  return `u_${userId.toHexString()}`;
}

export async function loadProjectsForUser(userId: ObjectId, dataDir: string): Promise<any[]> {
  const db = await getDb();
  const docs = await db
    .collection(COLLECTION)
    .find({ ownerId: userId })
    .sort({ savedAt: -1 })
    .toArray();

  // Strip Mongo's own fields; the app has never seen them and should not start now.
  const projects = docs.map(({ _id, ownerId, savedAt, ...project }) => project);
  return rehydrateProjects(projects, dataDir);
}

/**
 * Replaces this user's projects with what the browser sent. Projects missing from the payload
 * are deleted, which is how the app has always expressed "project removed".
 */
export async function saveProjectsForUser(
  userId: ObjectId,
  projects: any[],
  dataDir: string
): Promise<{ saved: number; removed: number }> {
  const db = await getDb();
  const collection = db.collection(COLLECTION);

  // What we already hold, so an "unchanged" marker can be resolved against it.
  const existing = await collection.find({ ownerId: userId }).toArray();
  const previous = existing.map(({ _id, ownerId, savedAt, ...project }) => project);

  const toStore = externalizeProjects(projects, dataDir, previous, blobScopeFor(userId));
  const savedAt = new Date();

  if (toStore.length > 0) {
    await collection.bulkWrite(
      toStore.map((project: any) => ({
        updateOne: {
          filter: { ownerId: userId, id: project.id },
          update: { $set: { ...project, ownerId: userId, savedAt } },
          upsert: true,
        },
      }))
    );
  }

  const keptIds = toStore.map((p: any) => p.id);
  const removal = await collection.deleteMany({ ownerId: userId, id: { $nin: keptIds } });

  return { saved: toStore.length, removed: removal.deletedCount || 0 };
}

export async function countProjectsForUser(userId: ObjectId): Promise<number> {
  const db = await getDb();
  return db.collection(COLLECTION).countDocuments({ ownerId: userId });
}
