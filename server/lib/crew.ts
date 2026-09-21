import { ObjectId } from 'mongodb';
import { getDb } from './db';
import { createUser, labelFor, User } from './users';

/**
 * Who is on a project.
 *
 * The owner creates seats directly - a username, a password and a role - rather than emailing
 * invitations, because a film crew is a handful of people who are usually in the same room.
 *
 * Roles are recorded but not yet enforced: anyone on a project can work on all of it. Turning
 * enforcement on later means reading these same values, not restructuring anything.
 */

export const CREW_ROLES = ['producer', 'stage', 'animator', 'camera', 'viewer'] as const;
export type CrewRole = (typeof CREW_ROLES)[number];

export interface CrewMember {
  userId: ObjectId;
  roles: CrewRole[];
  addedAt: Date;
}

export interface CrewMemberView {
  userId: string;
  name: string;
  username?: string;
  roles: CrewRole[];
  isOwner: boolean;
}

export function normalizeRoles(roles: unknown): CrewRole[] {
  const list = Array.isArray(roles) ? roles : [roles];
  const valid = list.filter((r): r is CrewRole => CREW_ROLES.includes(r as CrewRole));
  // Someone with no role at all could not be described on screen; default to the safest one.
  return valid.length > 0 ? Array.from(new Set(valid)) : ['viewer'];
}

/** Mongo filter for "projects this user may open": theirs, or ones they are crew on. */
export function accessibleProjectsFilter(userId: ObjectId) {
  return { $or: [{ ownerId: userId }, { 'members.userId': userId }] };
}

export async function canOpenProject(userId: ObjectId, projectId: string): Promise<boolean> {
  const db = await getDb();
  const found = await db
    .collection('projects')
    .countDocuments({ id: projectId, ...accessibleProjectsFilter(userId) }, { limit: 1 });
  return found > 0;
}

export async function isProjectOwner(userId: ObjectId, projectId: string): Promise<boolean> {
  const db = await getDb();
  const found = await db.collection('projects').countDocuments({ id: projectId, ownerId: userId }, { limit: 1 });
  return found > 0;
}

export async function listCrew(projectId: string): Promise<CrewMemberView[]> {
  const db = await getDb();
  const project = await db.collection('projects').findOne({ id: projectId });
  if (!project) return [];

  const members: CrewMember[] = project.members || [];
  const ids = [project.ownerId, ...members.map((m) => m.userId)].filter(Boolean);
  const users = (await db
    .collection('users')
    .find({ _id: { $in: ids } })
    .toArray()) as unknown as User[];

  const byId = new Map(users.map((u) => [u._id.toHexString(), u]));

  const rows: CrewMemberView[] = [];
  const owner = byId.get(project.ownerId?.toHexString?.());
  if (owner) {
    rows.push({
      userId: owner._id.toHexString(),
      name: labelFor(owner),
      username: owner.username,
      roles: ['producer'],
      isOwner: true,
    });
  }

  for (const member of members) {
    const user = byId.get(member.userId.toHexString());
    if (!user) continue;
    rows.push({
      userId: user._id.toHexString(),
      name: labelFor(user),
      username: user.username,
      roles: member.roles,
      isOwner: false,
    });
  }

  return rows;
}

/**
 * Creates a sign-in for someone and puts them on this project. The username is what they type
 * to sign in; the email is generated from it so the account shape stays the same as the owner's.
 */
export async function addCrewSeat(
  projectId: string,
  input: { username: string; password: string; displayName?: string; roles?: unknown }
): Promise<CrewMemberView> {
  const username = String(input.username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw new Error('Username must be 3-32 characters: letters, numbers, dot, dash or underscore.');
  }

  const db = await getDb();
  const roles = normalizeRoles(input.roles);

  // Reuse the account when this username already exists, so the same person can be added to
  // a second project without needing a second password.
  let user = (await db.collection('users').findOne({ username })) as unknown as User | null;

  if (!user) {
    const created = await createUser(`${username}@crew.local`, String(input.password || ''), 'user', {
      username,
      displayName: input.displayName,
    });
    user = (await db.collection('users').findOne({ _id: new ObjectId(created.id) })) as unknown as User;
  }

  const already = await db
    .collection('projects')
    .countDocuments({ id: projectId, 'members.userId': user._id }, { limit: 1 });

  if (already) {
    await db
      .collection('projects')
      .updateOne({ id: projectId, 'members.userId': user._id }, { $set: { 'members.$.roles': roles } });
  } else {
    await db
      .collection('projects')
      .updateOne(
        { id: projectId },
        { $push: { members: { userId: user._id, roles, addedAt: new Date() } } as any }
      );
  }

  return {
    userId: user._id.toHexString(),
    name: labelFor(user),
    username: user.username,
    roles,
    isOwner: false,
  };
}

export async function removeCrewSeat(projectId: string, userId: string): Promise<void> {
  const db = await getDb();
  await db
    .collection('projects')
    .updateOne({ id: projectId }, { $pull: { members: { userId: new ObjectId(userId) } } as any });
}
