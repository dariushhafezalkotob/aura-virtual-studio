import { ObjectId } from 'mongodb';
import { getDb } from './db';

/**
 * A project's look library: named camera / lens / film / grade recipes the crew collects while
 * researching, and later applies when turning previs into realistic frames.
 *
 * Looks belong to a project (a film), the same way crew seats do, so everyone on the film shares
 * one library and nobody outside it sees it.
 */

export interface LookFields {
  name: string;
  source: string;
  camera: string;
  lens: string;
  filmStock: string;
  format: string;
  aspectRatio: string;
  lighting: string;
  colorNotes: string;
  palette: string[];
  referenceUrl: string;
  lookPrompt: string;
}

export interface LookView extends LookFields {
  id: string;
  createdAt: string;
  updatedAt: string;
}

const TEXT_LIMITS: Record<Exclude<keyof LookFields, 'palette'>, number> = {
  name: 120,
  source: 200,
  camera: 200,
  lens: 200,
  filmStock: 200,
  format: 200,
  aspectRatio: 80,
  lighting: 400,
  colorNotes: 400,
  referenceUrl: 300,
  lookPrompt: 6000,
};

/** Accepts what the browser sent and keeps only known fields, trimmed and capped. */
export function cleanLookFields(input: any): LookFields {
  const out: any = {};
  for (const [key, max] of Object.entries(TEXT_LIMITS)) {
    out[key] = String(input?.[key] ?? '').trim().slice(0, max);
  }
  if (!out.name) throw new Error('Give the look a name.');

  // A reference picture must be one of our own stored assets, never an arbitrary URL.
  if (out.referenceUrl && !/^\/api\/assets\/[A-Za-z0-9._-]+$/.test(out.referenceUrl)) {
    throw new Error('The reference picture must be uploaded to Pantilt.');
  }

  const palette = Array.isArray(input?.palette) ? input.palette : [];
  out.palette = palette
    .map((c: unknown) => String(c).trim().toUpperCase())
    .filter((c: string) => /^#[0-9A-F]{6}$/.test(c))
    .slice(0, 24);

  return out as LookFields;
}

function toView(doc: any): LookView {
  const { _id, projectId, createdBy, ...rest } = doc;
  return {
    ...(rest as LookFields),
    id: _id.toHexString(),
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

export async function listLooks(projectId: string): Promise<LookView[]> {
  const db = await getDb();
  const docs = await db.collection('looks').find({ projectId }).sort({ updatedAt: -1 }).toArray();
  return docs.map(toView);
}

export async function getLook(projectId: string, lookId: string): Promise<LookView | null> {
  if (!ObjectId.isValid(lookId)) return null;
  const db = await getDb();
  const doc = await db.collection('looks').findOne({ _id: new ObjectId(lookId), projectId });
  return doc ? toView(doc) : null;
}

export async function createLook(projectId: string, userId: ObjectId, input: any): Promise<LookView> {
  const fields = cleanLookFields(input);
  const now = new Date();
  const db = await getDb();
  const doc = { ...fields, projectId, createdBy: userId, createdAt: now, updatedAt: now };
  const { insertedId } = await db.collection('looks').insertOne(doc);
  return toView({ ...doc, _id: insertedId });
}

export async function updateLook(projectId: string, lookId: string, input: any): Promise<LookView | null> {
  if (!ObjectId.isValid(lookId)) return null;
  const fields = cleanLookFields(input);
  const db = await getDb();
  const doc = await db
    .collection('looks')
    .findOneAndUpdate(
      { _id: new ObjectId(lookId), projectId },
      { $set: { ...fields, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
  return doc ? toView(doc) : null;
}

export async function deleteLook(projectId: string, lookId: string): Promise<boolean> {
  if (!ObjectId.isValid(lookId)) return false;
  const db = await getDb();
  const { deletedCount } = await db.collection('looks').deleteOne({ _id: new ObjectId(lookId), projectId });
  return deletedCount > 0;
}
