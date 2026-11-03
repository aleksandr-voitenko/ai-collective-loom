import { initialize, lifecycle, doctor } from './lib/staging.mjs';
import { fail } from './lib/staging-files.mjs';

process.umask(0o077);
try {
  const [action, ...args] = process.argv.slice(2),
    options = {};
  const allowed = new Set([
    'instance',
    'port',
    'origin',
    'subnet',
    'ipv6',
    'acknowledge',
    'nickname',
    'test-owner',
    'service',
    'backup',
    'key-file',
    'destination',
    'expectations',
    'confirm-instance',
    'confirm-data-loss',
    'replace-credential',
    'requests',
    'output',
  ]);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    if (
      !args[i]?.startsWith('--') ||
      !allowed.has(key) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--') ||
      key in options
    )
      fail('invalid or repeated option');
    options[key] = args[i + 1];
  }
  const actionOptions = {
    init: ['instance', 'origin', 'subnet', 'ipv6', 'acknowledge', 'nickname', 'test-owner'],
    doctor: ['instance'],
    start: ['instance'],
    stop: ['instance'],
    restart: ['instance'],
    recreate: ['instance'],
    status: ['instance'],
    logs: ['instance', 'service'],
    'worker-start': ['instance', 'service'],
    'worker-stop': ['instance', 'service'],
    'recover-initialization': ['instance', 'confirm-instance'],
    'recover-lock': ['instance'],
    witness: ['instance', 'requests', 'output'],
    backup: ['instance', 'backup', 'key-file'],
    inspect: ['instance', 'backup', 'key-file'],
    restore: ['instance', 'backup', 'key-file', 'destination', 'port', 'subnet'],
    verify: ['instance', 'expectations'],
    'recover-administrator': ['instance', 'confirm-instance', 'replace-credential'],
    upgrade: ['instance', 'confirm-instance', 'backup', 'key-file'],
    'resume-upgrade': ['instance', 'confirm-instance'],
    'destroy-test': ['instance', 'test-owner', 'confirm-instance', 'confirm-data-loss'],
  };
  if (
    !(action in actionOptions) ||
    Object.keys(options).some((k) => !actionOptions[action].includes(k))
  )
    fail('unsupported action or configuration change');
  let result;
  if (action === 'doctor' && !options.instance) result = doctor();
  else if (action === 'init')
    result = await initialize(options.instance, {
      ...options,
      testOwner: options['test-owner'],
    });
  else if (
    [
      'witness',
      'backup',
      'inspect',
      'restore',
      'verify',
      'recover-administrator',
      'upgrade',
      'resume-upgrade',
      'recover-initialization',
      'destroy-test',
    ].includes(action)
  ) {
    const { maintenance } = await import('./lib/staging-recovery.mjs');
    result = await maintenance(action, options);
  } else result = await lifecycle(options.instance, action, options);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  const message =
    error instanceof Error &&
    /^(Staging|Pilot|Recovery) refused: [A-Za-z0-9 ;:,.>_–()/-]+\.$/.test(error.message)
      ? error.message.replace(/^Pilot refused:/, 'Staging refused:')
      : 'Staging refused: operation failed; retained state was not automatically removed. Inspect private configuration and owned resources.';
  process.stderr.write(message + '\n');
  process.exitCode = 1;
}
