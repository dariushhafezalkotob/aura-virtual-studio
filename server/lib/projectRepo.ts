import { ObjectId } from 'mongodb';
import { getDb } from './db';
import { externalizeProjects, rehydrateProjects } from './projectStore';
import { accessibleProjectsFilter } from './crew';

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
  // Yours, plus any you have been added to as crew.
  const docs = await db
    .collection(COLLECTION)
    .find(accessibleProjectsFilter(userId))
    .sort({ savedAt: -1 })
    .toArray();

  // Strip Mongo's own fields; the app has never seen them and should not start now.
  const projects = docs.map(({ _id, ownerId, savedAt, members, ...project }) => ({
    ...project,
    // The browser shows a small badge on projects that belong to someone else.
    sharedWithMe: !ownerId?.equals?.(userId),
  }));
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
  const existing = await collection.find(accessibleProjectsFilter(userId)).toArray();
  const previous = existing.map(({ _id, ownerId, savedAt, members, ...project }) => project);
  const ownerById = new Map(existing.map((doc) => [doc.id, doc.ownerId]));

  // Blobs are filed under whoever owns the project, not whoever saved it, so a shared project
  // keeps all of its takes in one place no matter which crew member recorded them.
  const toStore: any[] = [];
  for (const raw of projects) {
    // `sharedWithMe` is added on the way out for the UI; it must not be stored.
    const { sharedWithMe, ...project } = raw || {};
    const owner = ownerById.get(project.id) || userId;
    const [stored] = externalizeProjects([project], dataDir, previous, blobScopeFor(owner));
    toStore.push({ project: stored, owner });
  }

  const savedAt = new Date();
  if (toStore.length > 0) {
    await collection.bulkWrite(
      toStore.map(({ project, owner }) => ({
        updateOne: {
          // Matching on id alone would let one account overwrite another's project.
          filter: { id: project.id, ...accessibleProjectsFilter(userId) },
          update: {
            $set: { ...project, savedAt },
            $setOnInsert: { ownerId: owner },
          },
          upsert: true,
        },
      }))
    );
  }

  // Only ever delete projects this user OWNS. A crew member's browser holds just the projects
  // they can see, so deleting everything missing from their payload would wipe work they were
  // never shown.
  const keptIds = toStore.map(({ project }) => project.id);
  const removal = await collection.deleteMany({ ownerId: userId, id: { $nin: keptIds } });

  return { saved: toStore.length, removed: removal.deletedCount || 0 };
}

export async function countProjectsForUser(userId: ObjectId): Promise<number> {
  const db = await getDb();
  return db.collection(COLLECTION).countDocuments({ ownerId: userId });
}
