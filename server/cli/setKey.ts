/**
 * Sets an API key in /etc/aura.env and restarts the service.
 *
 *   ssh -t root@<SERVER> "cd /srv/aura && node dist-server/set-key.mjs gemini"
 *   ssh -t root@<SERVER> "cd /srv/aura && node dist-server/set-key.mjs hf"
 *
 * The key is typed at a prompt with no echo, never appears on a command line, never enters
 * shell history, and is never printed back. Editing the file by hand works too, but an editor
 * over ssh is easy to exit without saving - which is exactly what kept happening.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { execSync } from 'node:child_process';

const KEYS: Record<string, { envVar: string; label: string }> = {
  gemini: { envVar: 'GEMINI_API_KEY', label: 'Gemini API key' },
  hf: { envVar: 'HF_TOKEN', label: 'Hugging Face token' },
};

const which = process.argv[2];
const envFile = process.env.AURA_ENV_FILE || '/etc/aura.env';

function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let data = '';
      process.stdin.on('data', (chunk) => (data += chunk));
      process.stdin.on('end', () => resolve(data.trim()));
    });
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    (rl as any)._writeToOutput = (chunk: string) => {
      if (chunk.includes(prompt)) (rl as any).output.write(chunk);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  const target = KEYS[which];
  if (!target) {
    console.log('Usage: set-key gemini|hf');
    process.exit(1);
  }

  if (!fs.existsSync(envFile)) {
    console.error(`${envFile} does not exist.`);
    process.exit(1);
  }

  const value = await readSecret(`${target.label}: `);
  if (!value) {
    console.error('Nothing entered; leaving the file alone.');
    process.exit(1);
  }
  if (/\s/.test(value)) {
    console.error('That contains a space, which is almost certainly a copy-paste mistake.');
    process.exit(1);
  }

  const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
  const index = lines.findIndex((l) => l.startsWith(`${target.envVar}=`));
  if (index >= 0) lines[index] = `${target.envVar}=${value}`;
  else lines.push(`${target.envVar}=${value}`);

  fs.writeFileSync(envFile, lines.join('\n'), { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
  console.log(`${target.envVar} written to ${envFile} (${value.length} characters).`);

  try {
    execSync('systemctl restart aura', { stdio: 'ignore' });
    // The environment file is only read at startup, so the restart is the half people forget.
    console.log('Service restarted.');
  } catch {
    console.log('Could not restart automatically - run: systemctl restart aura');
  }
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
