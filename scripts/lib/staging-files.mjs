import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
export {
  root,
  hash,
  run,
  docker,
  inside,
  privatePath,
  readJson,
  readPrivateText,
  json,
  replace,
  lock,
  recoverLock,
  writePrivate,
} from './pilot-files.mjs';
import { privatePath, readJson, run, writePrivate } from './pilot-files.mjs';
export const policy = 'vps-staging-1';
export const fail = (reason) => {
  throw new Error('Staging refused: ' + reason + '.');
};
export function readInstance(path) {
  path = privatePath(path);
  const d = readJson(join(path, 'instance.json'));
  if (
    d.format !== 'loom-vps-staging-1' ||
    !/^loom-staging-[a-f0-9-]{36}$/.test(d.id) ||
    !/^[a-f0-9]{64}$/.test(d.owner) ||
    d.path !== path ||
    d.uid !== process.getuid() ||
    d.policy !== policy ||
    (!['initializing', 'initialization-interrupted'].includes(d.state) &&
      d.everInitialized !== true) ||
    !['retained', 'acceptance'].includes(d.kind) ||
    (d.kind === 'retained' && d.testOwner !== undefined) ||
    (d.kind === 'acceptance' && !/^[a-f0-9-]{36}$/.test(d.testOwner ?? ''))
  )
    fail('unowned or damaged staging instance');
  privatePath(path, { instance: true, testOwner: d.testOwner });
  return d;
}
/** Only new quarantines and labeled acceptance resources use a private fixture CA. */
export function quarantineCertificate(directory, hostname) {
  const scratch = join(directory, 'certificate-' + randomUUID());
  mkdirSync(scratch, { mode: 0o700 });
  try {
    run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(scratch, 'ca.key'),
      '-out',
      join(scratch, 'ca.pem'),
      '-days',
      '365',
      '-subj',
      '/CN=Loom isolated quarantine CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    ]);
    run('openssl', [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(scratch, 'leaf.key'),
      '-out',
      join(scratch, 'leaf.csr'),
      '-subj',
      '/CN=' + hostname,
    ]);
    writePrivate(
      join(scratch, 'extensions'),
      `subjectAltName=DNS:${hostname}\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n`,
    );
    run('openssl', [
      'x509',
      '-req',
      '-in',
      join(scratch, 'leaf.csr'),
      '-CA',
      join(scratch, 'ca.pem'),
      '-CAkey',
      join(scratch, 'ca.key'),
      '-set_serial',
      '0x' + randomUUID().replaceAll('-', ''),
      '-days',
      '30',
      '-extfile',
      join(scratch, 'extensions'),
      '-out',
      join(scratch, 'leaf.pem'),
    ]);
    return Object.fromEntries(
      [
        ['ca', 'ca.pem'],
        ['caKey', 'ca.key'],
        ['key', 'leaf.key'],
        ['cert', 'leaf.pem'],
      ].map(([key, file]) => [key, readFileSync(join(scratch, file), 'utf8')]),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
