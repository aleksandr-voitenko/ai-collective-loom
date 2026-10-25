import { requireRepositoryRuntime } from './check-runtime.mjs';
import {
  createInstance,
  readInstance,
  backup,
  inspectBackup,
  restore,
  verify,
  start,
  stop,
  destroy,
} from './lib/recovery.mjs';
requireRepositoryRuntime();
const [command, ...args] = process.argv.slice(2),
  options = {};
try {
  for (let i = 0; i < args.length; i += 2) {
    if (!/^--[a-z-]+$/.test(args[i]) || !args[i + 1] || options[args[i]])
      throw new Error('Invalid arguments');
    options[args[i]] = args[i + 1];
  }
  const required = (...keys) => {
    if (Object.keys(options).some((k) => !keys.includes(k)) || keys.some((k) => !options[k]))
      throw new Error('Explicit selections required');
  };
  let result;
  if (command === 'create') {
    required('--instance');
    const d = await createInstance(options['--instance']);
    result = { status: d.status, instance: d.path };
  } else if (command === 'backup') {
    required('--instance', '--backup', '--key-file');
    result = await backup(
      readInstance(options['--instance']),
      options['--backup'],
      options['--key-file'],
    );
  } else if (command === 'inspect') {
    required('--backup', '--key-file');
    result = inspectBackup(options['--backup'], options['--key-file']);
  } else if (command === 'restore') {
    required('--backup', '--destination', '--key-file');
    const d = await restore(options['--backup'], options['--destination'], options['--key-file']);
    result = { status: d.status, instance: d.path };
  } else if (command === 'verify') {
    required('--instance', '--expectations');
    result = await verify(readInstance(options['--instance']), options['--expectations']);
  } else if (['start', 'stop', 'destroy'].includes(command)) {
    required('--instance');
    const d = readInstance(options['--instance']);
    await { start, stop, destroy }[command](d);
    result = { status: command + ' completed' };
  } else throw new Error('Unknown recovery command');
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  // Fixed diagnostic only: never print untrusted paths, SQL, capabilities, keys or prose.
  process.stderr.write(
    'Recovery command failed; no recovery success is certified. Check explicit private paths, ownership, completed backup, key and same-release prerequisites.\n',
  );
  process.exitCode = 1;
}
