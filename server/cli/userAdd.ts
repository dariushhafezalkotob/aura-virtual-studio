/**
 * Account management from the command line. There is no public signup: accounts exist
 * because someone with server access created them.
 *
 *   user-add add    <email> [--owner]   create an account (asks for the password)
 *   user-add passwd <email>             change a password
 *   user-add role   <email> owner|user  promote or demote
 *   user-add delete <email>             remove an account
 *   user-add list                       list accounts
 *
 * The password is never taken from the command line: a shell records it in history, and
 * characters like ! and $ get mangled before the program ever sees them. It is typed at a
 * prompt (use `ssh -t`) or piped in:  echo 'secret' | user-add passwd me@example.com
 *
 * On the server, load the environment first so it finds the database:
 *   cd /srv/aura && set -a && . /etc/aura.env && set +a && node dist-server/user-add.mjs list
 */
import readline from 'node:readline';
import { ObjectId } from 'mongodb';
import { createUser, setPassword, listUsers } from '../lib/users';
import { getDb, closeDb } from '../lib/db';

const [command, email, extra] = process.argv.slice(2);
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));

function usage(): never {
  console.log(`Usage:
  user-add add    <email> [--owner]   create an account (asks for the password)
  user-add passwd <email>             change a password
  user-add role   <email> owner|user  promote or demote
  user-add delete <email>             remove an account
  user-add list                       list accounts`);
  process.exit(1);
}

/** Reads a password without echoing it, or from a pipe when there is no terminal. */
function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let data = '';
      process.stdin.on('data', (chunk) => (data += chunk));
      process.stdin.on('end', () => resolve(data.trim()));
    });
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Suppress the echo so the password never appears on screen or in a scrollback buffer.
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

async function askTwice(): Promise<string> {
  const first = await readPassword('Password: ');
  if (!process.stdin.isTTY) return first;
  const again = await readPassword('Again: ');
  if (first !== again) {
    console.error('Those did not match.');
    process.exit(1);
  }
  return first;
}

async function main() {
  switch (command) {
    case 'add': {
      if (!email) usage();
      const password = await askTwice();
      const role = flags.includes('--owner') ? 'owner' : 'user';
      const user = await createUser(email, password, role);
      console.log(`Created ${user.email} (${user.role}).`);
      break;
    }
    case 'passwd': {
      if (!email) usage();
      const password = await askTwice();
      const ok = await setPassword(email, password);
      console.log(ok ? `Password changed for ${email}.` : `No account for ${email}.`);
      if (!ok) process.exitCode = 1;
      break;
    }
    case 'role': {
      if (!email || (extra !== 'owner' && extra !== 'user')) usage();
      const db = await getDb();
      const result = await db
        .collection('users')
        .updateOne({ email: email.trim().toLowerCase() }, { $set: { role: extra } });
      console.log(result.matchedCount ? `${email} is now ${extra}.` : `No account for ${email}.`);
      if (!result.matchedCount) process.exitCode = 1;
      break;
    }
    case 'delete': {
      if (!email) usage();
      const db = await getDb();
      const user = await db.collection('users').findOne({ email: email.trim().toLowerCase() });
      if (!user) {
        console.log(`No account for ${email}.`);
        process.exitCode = 1;
        break;
      }
      await db.collection('sessions').deleteMany({ userId: user._id as ObjectId });
      await db.collection('users').deleteOne({ _id: user._id });
      console.log(`Deleted ${email} and signed out every session it had.`);
      break;
    }
    case 'list': {
      const users = await listUsers();
      if (users.length === 0) {
        console.log('No accounts yet.');
      } else {
        for (const u of users) {
          const name = u.username ? `${u.email} (@${u.username})` : u.email;
          console.log(`${name.padEnd(40)} ${u.role}`);
        }
      }
      break;
    }
    default:
      usage();
  }
}

main()
  .catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
