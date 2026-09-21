import { ObjectId } from 'mongodb';
import { getDb } from './db';
import { env } from './env';
import type { User } from './users';

/**
 * A daily cap on generations.
 *
 * Once the API keys live on the server, every generation spends the studio owner's Hugging Face
 * quota and Gemini billing - so "how many can one account start per day" is a money question, not
 * a politeness one. Owners are uncapped; everyone else gets AURA_DAILY_GENERATIONS (default 20)
 * unless their account carries its own dailyLimit.
 */

/** Routes that cost GPU time or API credits. */
const METERED_ROUTES = [
  '/api/generate-3d',
  '/api/generate-image',
  '/api/generate-motion',
  '/api/generate-360-from-image',
  '/api/reconstruct-hunyuan-world',
];

export function isMeteredRoute(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split('?')[0];
  return METERED_ROUTES.some((route) => path.startsWith(route));
}

export function dailyLimitFor(user: User): number {
  if (user.role === 'owner') return Infinity;
  if (typeof user.dailyLimit === 'number') return user.dailyLimit;
  const configured = Number(env.AURA_DAILY_GENERATIONS);
  return Number.isFinite(configured) && configured > 0 ? configured : 20;
}

/** UTC day, so the reset time is the same for everyone regardless of where they are. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface QuotaResult {
  allowed: boolean;
  used: number;
  limit: number;
}

/**
 * Counts one generation against the user's day, atomically - two requests started at the same
 * moment cannot both slip through on the same last remaining slot.
 */
export async function consumeGeneration(userId: ObjectId, limit: number): Promise<QuotaResult> {
  if (!Number.isFinite(limit)) return { allowed: true, used: 0, limit };

  const db = await getDb();
  const day = today();
  const doc = await db
    .collection('usage')
    .findOneAndUpdate(
      { userId, day },
      { $inc: { count: 1 }, $setOnInsert: { userId, day } },
      { upsert: true, returnDocument: 'after' }
    );

  const used = doc?.count ?? 1;
  if (used > limit) {
    // Over the line: give the slot back so the count reflects what actually ran.
    await db.collection('usage').updateOne({ userId, day }, { $inc: { count: -1 } });
    return { allowed: false, used: limit, limit };
  }
  return { allowed: true, used, limit };
}

/** Gives a slot back when the generation failed on our side - a 500 should not cost the user. */
export async function refundGeneration(userId: ObjectId): Promise<void> {
  const db = await getDb();
  const day = today();
  await db.collection('usage').updateOne({ userId, day, count: { $gt: 0 } }, { $inc: { count: -1 } });
}

export async function usageToday(userId: ObjectId): Promise<number> {
  const db = await getDb();
  const doc = await db.collection('usage').findOne({ userId, day: today() });
  return doc?.count ?? 0;
}
