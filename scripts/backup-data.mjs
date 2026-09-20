// Snapshots data/ into backups/aura-data-<timestamp>.tar.gz and keeps the newest 10.
//
// data/ is not in git - it is 300 MB+ of generated models and changes on every
// generation - so this is what stands in for a commit when you want a restore point.
//
//   npm run backup:data
//
// Restore: tar -xzf backups/aura-data-<timestamp>.tar.gz   (from the project root)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dataDir = path.join(root, 'data');
const backupsDir = path.join(root, 'backups');
const KEEP = 10;

if (!fs.existsSync(dataDir)) {
  console.error('No data/ directory here - run this from the project root.');
  process.exit(1);
}

fs.mkdirSync(backupsDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outFile = path.join(backupsDir, `aura-data-${stamp}.tar.gz`);

// Exclude the pre-split backups: they are themselves old copies of projects.json.
execFileSync(
  'tar',
  ['-czf', outFile, '--exclude', 'projects.before-split.*.json', '--exclude', '.DS_Store', '-C', root, 'data'],
  { stdio: 'inherit' }
);

const sizeMb = (fs.statSync(outFile).size / 1048576).toFixed(1);
console.log(`Saved ${path.relative(root, outFile)} (${sizeMb} MB)`);

const old = fs
  .readdirSync(backupsDir)
  .filter((f) => f.startsWith('aura-data-') && f.endsWith('.tar.gz'))
  .sort()
  .slice(0, -KEEP);

for (const f of old) {
  fs.unlinkSync(path.join(backupsDir, f));
  console.log(`Removed old backup ${f}`);
}
