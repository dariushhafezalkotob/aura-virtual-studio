import { MongoClient, Db } from 'mongodb';
import { env } from './env';

/**
 * One MongoDB connection for the whole process.
 *
 * Development and production both run a real mongod on localhost, so there is only ever one
 * kind of backend to reason about. MONGODB_URI is what moves the app to a managed database
 * later; nothing else has to change.
 */
let client: MongoClient | null = null;
let db: Db | null = null;

export function mongoUri(): string {
  return env.MONGODB_URI || 'mongodb://127.0.0.1:27017/aura';
}

export async function getDb(): Promise<Db> {
  if (db) return db;

  const uri = mongoUri();
  client = new MongoClient(uri, {
    // Fail fast rather than hanging a request for 30s when the database is down.
    serverSelectionTimeoutMS: 5000,
  });
  await client.connect();
  db = client.db();

  await ensureIndexes(db);
  console.log(`[db] connected to ${uri.replace(/\/\/[^@]*@/, '//***@')}`);
  return db;
}

/** Called once per connection. Creating an index that already exists is a no-op. */
async function ensureIndexes(database: Db) {
  await database.collection('users').createIndex({ email: 1 }, { unique: true });
  await database.collection('sessions').createIndex({ token: 1 }, { unique: true });
  // Sessions clean themselves up: Mongo deletes them when expiresAt passes.
  await database.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await database.collection('projects').createIndex({ ownerId: 1, id: 1 }, { unique: true });
  await database.collection('projects').createIndex({ ownerId: 1, modified: -1 });
}

export async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

/** True when the database answers. Used by the health check and by startup logging. */
export async function dbReachable(): Promise<boolean> {
  try {
    const database = await getDb();
    await database.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}
