import { spawnSync } from 'node:child_process';
import { createHash, randomUUID, X509Certificate, createPrivateKey } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const policy = 'local-pilot-1';
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const fail = (reason) => {
  throw new Error('Pilot refused: ' + reason + '.');
};
export const inside = (parent, path) => {
  const r = relative(parent, path);
  return !r || (r !== '..' && !r.startsWith('../') && !isAbsolute(r));
};
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 900000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  // Provider errors can contain passwords, SQL, paths or authored data.
  if (result.error || result.status !== 0)
    fail(command + ' operation failed; inspect status before retrying');
  return result.stdout?.trim() ?? '';
}
export const docker = (args, options) => run('docker', args, options);
export function privatePath(path, { fresh = false, instance = false, testOwner } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[,\x00-\x1f\x7f]/.test(path))
    fail('explicit absolute private path required');
  path = resolve(path);
  if (realpathSync(dirname(path)) !== dirname(path)) fail('symlinked parent');
  if (
    inside(realpathSync(root), path) ||
    inside(path, realpathSync(root)) ||
    path === homedir()
  )
    fail('unsafe or overlapping path');
  if (
    instance &&
    !testOwner &&
    [realpathSync(tmpdir()), '/private/tmp', '/tmp', '/var/tmp', '/private/var/tmp'].some((p) =>
      inside(p, path),
    )
  )
    fail('retained instance must be outside temporary directories');
  if (testOwner && !/^[a-f0-9-]{36}$/.test(testOwner)) fail('invalid test owner');
  for (
    let parent = instance ? dirname(path) : '/';
    parent !== dirname(parent);
    parent = dirname(parent)
  )
    if (existsSync(join(parent, 'instance.json'))) fail('nested instance');
    else if (!testOwner && lstatSync(parent).mode & 0o022)
      fail('instance parent is writable by another user');
  if (fresh && existsSync(path))
    fail('destination exists; initialization never replaces material');
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077)
      fail('owner-only non-symlink path required');
  }
  return path;
}
export function readPrivateText(path, limit) {
  privatePath(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > limit) fail('bounded regular private file required');
  return readFileSync(path, 'utf8');
}
export function readJson(path, limit = 16 * 1024 * 1024) {
  privatePath(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > limit) fail('invalid private file');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('damaged JSON configuration');
  }
}
export function writePrivate(path, bytes) {
  writeFileSync(path, bytes, { mode: 0o600, flag: 'wx', flush: true });
}
export const json = (path, value) => writePrivate(path, JSON.stringify(value) + '\n');
export function replace(path, value) {
  const temporary = path + '.' + randomUUID();
  json(temporary, value);
  renameSync(temporary, path);
}
export function readInstance(path) {
  path = privatePath(path);
  const d = readJson(join(path, 'instance.json'));
  if (
    d.format !== 'loom-local-pilot-1' ||
    !/^loom-pilot-[a-f0-9-]{36}$/.test(d.id) ||
    !/^[a-f0-9]{64}$/.test(d.owner) ||
    d.path !== path ||
    d.uid !== process.getuid() ||
    d.policy !== policy ||
    !['retained', 'acceptance'].includes(d.kind) ||
    (d.kind === 'retained' && d.testOwner !== undefined) ||
    (d.kind === 'acceptance' && !/^[a-f0-9-]{36}$/.test(d.testOwner ?? ''))
  )
    fail('unowned or damaged instance');
  privatePath(path, { instance: true, testOwner: d.testOwner });
  return d;
}
export function lock(d, action) {
  const path = join(d.path, 'operation.lock');
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch {
    fail('lifecycle command locked; use recover-lock after the controller exits');
  }
  json(join(path, 'owner.json'), { pid: process.pid, owner: d.owner, action });
  return () => rmSync(path, { recursive: true });
}
export function recoverLock(d) {
  const path = join(d.path, 'operation.lock'),
    record = readJson(join(path, 'owner.json'));
  if (record.owner !== d.owner || !Number.isSafeInteger(record.pid))
    fail('ambiguous lock ownership');
  try {
    process.kill(record.pid, 0);
    fail('controller may still be running');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  // The caller also proves that no labeled maintenance container remains.
  rmSync(path, { recursive: true });
}
export function validateTls(c, { allowExpiredLeaf = false } = {}) {
  try {
    const ca = new X509Certificate(c.tls.ca),
      leaf = new X509Certificate(c.tls.cert);
    const now = Date.now();
    if (
      !ca.ca ||
      !ca.checkPrivateKey(createPrivateKey(c.tls.caKey)) ||
      !leaf.checkPrivateKey(createPrivateKey(c.tls.key)) ||
      !leaf.verify(ca.publicKey) ||
      leaf.checkHost('localhost') !== 'localhost' ||
      now < Date.parse(ca.validFrom) ||
      now >= Date.parse(ca.validTo) ||
      now < Date.parse(leaf.validFrom) ||
      (!allowExpiredLeaf && now >= Date.parse(leaf.validTo))
    )
      throw new Error();
  } catch {
    fail(
      'TLS names, expiry, trust anchor or key pairing invalid; use explicit renew-certificate for an expired leaf',
    );
  }
}
export function certificate(directory, existing) {
  const scratch = join(directory, 'tls-' + randomUUID());
  mkdirSync(scratch, { mode: 0o700 });
  try {
    if (existing) {
      writePrivate(join(scratch, 'ca.pem'), existing.ca);
      writePrivate(join(scratch, 'ca.key'), existing.caKey);
    } else
      run('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:3072',
        '-nodes',
        '-keyout',
        join(scratch, 'ca.key'),
        '-out',
        join(scratch, 'ca.pem'),
        '-days',
        '3650',
        '-subj',
        '/CN=Loom private local pilot CA',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'keyUsage=critical,keyCertSign,cRLSign',
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
      '/CN=localhost',
    ]);
    writePrivate(
      join(scratch, 'extensions'),
      'subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',
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
      '365',
      '-extfile',
      join(scratch, 'extensions'),
      '-out',
      join(scratch, 'leaf.pem'),
    ]);
    const tls = Object.fromEntries(
      [
        ['ca', 'ca.pem'],
        ['caKey', 'ca.key'],
        ['key', 'leaf.key'],
        ['cert', 'leaf.pem'],
      ].map(([k, p]) => [k, readFileSync(join(scratch, p), 'utf8')]),
    );
    validateTls({ tls });
    return tls;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
