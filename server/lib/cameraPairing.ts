/**
 * Letting a phone onto a camera-remote room without handing it an account.
 *
 * On a LAN none of this existed: the relay accepted anyone who connected, which was fine when
 * "anyone" meant someone already inside the building. Online it means anyone at all, so the phone
 * now has to prove it was invited.
 *
 * Two short-lived things, both in Mongo with a TTL index so they clean themselves up:
 *
 *   A PAIRING CODE is what the QR carries. The laptop asks for one, it is good for a couple of
 *   minutes and for exactly one claim, because a QR code on a monitor is readable by everyone in
 *   the room and screens get photographed.
 *
 *   A REMOTE PASS is what the phone keeps afterwards. It is not a session: it carries no account,
 *   opens no project, spends no generation quota. All it says is "this device may join this one
 *   room", which is the whole of what a camera operator's phone needs to do.
 */

import crypto from 'node:crypto';
import { ObjectId } from 'mongodb';
import { getDb } from './db';

/** Long enough not to be guessable, short enough to read off a screen and type if the QR fails. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const CODE_LENGTH = 8;
const CODE_TTL_MS = 3 * 60 * 1000;
const PASS_TTL_MS = 12 * 60 * 60 * 1000;

export const REMOTE_PASS_COOKIE = 'aura_remote_pass';

export interface PairingCode {
  code: string;
  room: string;
  projectId?: string;
  expiresAt: Date;
}

export interface RemotePass {
  token: string;
  room: string;
  projectId?: string;
  expiresAt: Date;
}

function newCode(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

async function collections() {
  const db = await getDb();
  const codes = db.collection('camera_pairing_codes');
  const passes = db.collection('camera_remote_passes');
  // Cheap and idempotent; Mongo drops the rows itself once they lapse.
  await Promise.all([
    codes.createIndex({ code: 1 }, { unique: true }),
    codes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    passes.createIndex({ token: 1 }, { unique: true }),
    passes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]).catch(() => {});
  return { codes, passes };
}

/** The laptop asks for this and shows it as a QR. */
export async function createPairingCode(
  userId: ObjectId,
  room: string,
  projectId?: string
): Promise<PairingCode> {
  const { codes } = await collections();
  const code = newCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  await codes.insertOne({ code, room, projectId, userId, claimed: false, createdAt: new Date(), expiresAt });
  return { code, room, projectId, expiresAt };
}

/**
 * The phone trades the code for a pass. Single use: the find and the mark happen in one atomic
 * update, so two devices scanning the same screen cannot both get in.
 */
export async function claimPairingCode(code: string): Promise<RemotePass | null> {
  if (!code || typeof code !== 'string') return null;
  const { codes, passes } = await collections();

  const claimed = await codes.findOneAndUpdate(
    { code: code.trim().toUpperCase(), claimed: false, expiresAt: { $gt: new Date() } },
    { $set: { claimed: true, claimedAt: new Date() } },
    { returnDocument: 'after' }
  );
  const doc: any = (claimed as any)?.value ?? claimed;
  if (!doc) return null;

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + PASS_TTL_MS);
  await passes.insertOne({
    token,
    room: doc.room,
    projectId: doc.projectId,
    issuedBy: doc.userId,
    createdAt: new Date(),
    expiresAt,
  });
  return { token, room: doc.room, projectId: doc.projectId, expiresAt };
}

/** What the relay calls to decide whether a phone may join the room it is asking for. */
export async function passForToken(token: string | undefined): Promise<RemotePass | null> {
  if (!token) return null;
  try {
    const { passes } = await collections();
    const doc: any = await passes.findOne({ token });
    if (!doc) return null;
    if (doc.expiresAt && doc.expiresAt < new Date()) {
      await passes.deleteOne({ token });
      return null;
    }
    return { token, room: doc.room, projectId: doc.projectId, expiresAt: doc.expiresAt };
  } catch (err) {
    console.warn('[cameraPairing] pass lookup failed:', err);
    return null;
  }
}

export function remotePassCookie(token: string, expiresAt: Date, secure: boolean): string {
  return [
    `${REMOTE_PASS_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
    `Expires=${expiresAt.toUTCString()}`,
  ]
    .filter(Boolean)
    .join('; ');
}
