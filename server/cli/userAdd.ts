/**
 * Account management from the command line. There is no public signup: accounts exist
 * because someone with server access created them.
 *
 *   node dist-server/user-add.mjs add    <email> <password> [--owner]
 *   node dist-server/user-add.mjs passwd <email> <password>
 *   node dist-server/user-add.mjs list
 *
 * On the server, load the environment first so it finds the database:
 *   cd /srv/aura && set -a && . /etc/aura.env && set +a && node dist-server/user-add.mjs list
 */
import { createUser, setPassword, listUsers } from '../lib/users';
import { closeDb } from '../lib/db';

const [command, email, password, ...flags] = process.argv.slice(2);

function usage(): never {
  console.log(`Usage:
  user-add add    <email> <password> [--owner]   create an account
  user-add passwd <email> <password>            change a password
  user-add list                                 list accounts`);
  process.exit(1);
}

async function main() {
  switch (command) {
    case 'add': {
      if (!email || !password) usage();
      const role = flags.includes('--owner') ? 'owner' : 'user';
      const user = await createUser(email, password, role);
      console.log(`Created ${user.email} (${user.role}).`);
      break;
    }
    case 'passwd': {
      if (!email || !password) usage();
      const ok = await setPassword(email, password);
      console.log(ok ? `Password changed for ${email}.` : `No account for ${email}.`);
      if (!ok) process.exitCode = 1;
      break;
    }
    case 'list': {
      const users = await listUsers();
      if (users.length === 0) {
        console.log('No accounts yet.');
      } else {
        for (const u of users) console.log(`${u.email.padEnd(34)} ${u.role}`);
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
