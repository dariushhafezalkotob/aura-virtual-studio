/**
 * Imports data/projects.json into the database, owned by one account.
 *
 *   node dist-server/import-projects.mjs <email> [path/to/projects.json]
 *
 * The file is only read. Blob references are carried across untouched, so the take and motion
 * files stay exactly where they are - nothing large is copied or rewritten.
 *
 * Running it twice replaces that account's copy of the same projects rather than duplicating.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb, closeDb } from '../lib/db';

const [email, fileArg] = process.argv.slice(2);
const file = path.resolve(fileArg || path.join(process.cwd(), 'data', 'projects.json'));

async function main() {
  if (!email) {
    console.log('Usage: import-projects <email> [path/to/projects.json]');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.log(`No such file: ${file}`);
    process.exit(1);
  }

  const db = await getDb();
  const user = await db.collection('users').findOne({ email: email.trim().toLowerCase() });
  if (!user) {
    console.log(`No account for ${email}. Create it first with user-add.`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const projects: any[] = Array.isArray(raw) ? raw : raw.projects || [];
  if (projects.length === 0) {
    console.log('Nothing to import.');
    return;
  }

  const savedAt = new Date();
  const result = await db.collection('projects').bulkWrite(
    projects.map((project) => ({
      updateOne: {
        filter: { ownerId: user._id, id: project.id },
        update: { $set: { ...project, ownerId: user._id, savedAt } },
        upsert: true,
      },
    }))
  );

  console.log(`Imported ${projects.length} project(s) for ${email}:`);
  for (const p of projects) {
    const takes = (p.cameraTakes || []).length;
    const actors = (p.characters || []).length;
    console.log(`  ${String(p.name || p.id).padEnd(18)} ${(p.scenes || []).length} scenes, ${actors} actors, ${takes} takes`);
  }
  console.log(`(${result.upsertedCount} new, ${result.modifiedCount} updated)`);
}

main()
  .catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
