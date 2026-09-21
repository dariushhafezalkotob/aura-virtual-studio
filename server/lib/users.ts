import crypto from 'node:crypto';
import { ObjectId } from 'mongodb';
import { getDb } from './db';

/**
 * Accounts and sessions.
 *
 * Passwords are hashed with scrypt from Node's own crypto - deliberately no bcrypt/argon2
 * dependency, which would mean a native module to compile on every machine this runs on.
 * scrypt is memory-hard and part of the platform, which is the right trade for this app.
 */

const SCRYPT_N = 32768; // ~50ms per hash on the server; raises the cost of a stolen-database attack
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 64;

export const SESSION_COOKIE = 'aura_session';
const SESSION_DAYS = 30;

export interface User {
  _id: ObjectId;
  email: string;
  passwordHash: string;
  role: 'owner' | 'user';
  /** Generations allowed per day. Undefined means the server-wide default applies. */
  dailyLimit?: number;
  createdAt: Date;
}

/** What the browser is allowed to know about the signed-in user. */
export interface PublicUser {
  id: string;
  email: string;
  role: 'owner' | 'user';
}

export function toPublicUser(user: User): PublicUser {
  return { id: user._id.toHexString(), email: user.email, role: user.role };
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  // 128 * N * r is 33.5 MB here, just over Node's 32 MB default, so maxmem has to be raised
  // or scrypt refuses to run at all.
  const hash = crypto.scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    maxmem: 256 * 1024 * 1024,
  });
  return ['scrypt', SCRYPT_N, SCRYPT_r, SCRYPT_p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;

    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      // scrypt needs headroom above N*r*128 or it throws instead of hashing.
      maxmem: 256 * 1024 * 1024,
    });
    // Constant-time: a plain === leaks how much of the hash matched, one byte at a time.
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function createUser(
  email: string,
  password: string,
  role: 'owner' | 'user' = 'user'
): Promise<PublicUser> {
  if (!email.includes('@')) throw new Error('That does not look like an email address.');
  if (password.length < 10) throw new Error('Password must be at least 10 characters.');

  const db = await getDb();
  const user: Omit<User, '_id'> = {
    email: normalizeEmail(email),
    passwordHash: hashPassword(password),
    role,
    createdAt: new Date(),
  };

  try {
    const result = await db.collection('users').insertOne(user as any);
    return toPublicUser({ ...user, _id: result.insertedId } as User);
  } catch (err: any) {
    if (err?.code === 11000) throw new Error(`There is already an account for ${email}.`);
    throw err;
  }
}

export async function setPassword(email: string, password: string): Promise<boolean> {
  if (password.length < 10) throw new Error('Password must be at least 10 characters.');
  const db = await getDb();
  const result = await db
    .collection('users')
    .updateOne({ email: normalizeEmail(email) }, { $set: { passwordHash: hashPassword(password) } });
  return result.matchedCount > 0;
}

export async function listUsers(): Promise<PublicUser[]> {
  const db = await getDb();
  const users = await db.collection('users').find({}).sort({ createdAt: 1 }).toArray();
  return users.map((u) => toPublicUser(u as unknown as User));
}

/** Returns the user when the password is right, null otherwise. Never says which half was wrong. */
export async function authenticate(email: string, password: string): Promise<User | null> {
  const db = await getDb();
  const user = (await db.collection('users').findOne({ email: normalizeEmail(email) })) as unknown as User | null;
  if (!user) {
    // Hash anyway, so a missing account does not answer faster than a wrong password.
    hashPassword(password);
    return null;
  }
  return verifyPassword(password, user.passwordHash) ? user : null;
}

export async function createSession(userId: ObjectId): Promise<{ token: string; expiresAt: Date }> {
  const db = await getDb();
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  // Mongo drops the row itself when expiresAt passes (TTL index in db.ts).
  await db.collection('sessions').insertOne({ token, userId, createdAt: new Date(), expiresAt });
  return { token, expiresAt };
}

export async function userForSession(token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const db = await getDb();
  const session = await db.collection('sessions').findOne({ token });
  if (!session) return null;
  if (session.expiresAt && session.expiresAt < new Date()) {
    await db.collection('sessions').deleteOne({ token });
    return null;
  }
  return (await db.collection('users').findOne({ _id: session.userId })) as unknown as User | null;
}

export async function destroySession(token: string | undefined) {
  if (!token) return;
  const db = await getDb();
  await db.collection('sessions').deleteOne({ token });
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  // Secure would make the cookie unusable over the plain-http test instance on 3100.
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
