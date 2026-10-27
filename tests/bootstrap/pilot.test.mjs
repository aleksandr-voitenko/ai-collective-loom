import { expiredLeaf } from '../helpers/pilot-certificate.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  privatePath,
  certificate,
  validateTls,
  lock,
  recoverLock,
  readJson,
  readPrivateText,
} from '../../scripts/lib/pilot-files.mjs';

test('pilot rejects temporary retained paths, symlinks, nested instances and public private material', (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'loom-pilot-paths-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => privatePath(join(root, 'retained'), { instance: true }), /temporary/);
  assert.equal(
    privatePath(join(root, 'fixture'), { instance: true, testOwner: randomUUID() }),
    join(root, 'fixture'),
  );
  mkdirSync(join(root, 'owned'), { mode: 0o700 });
  writeFileSync(join(root, 'owned/instance.json'), '{}', { mode: 0o600 });
  assert.throws(
    () => privatePath(join(root, 'owned/child'), { instance: true, testOwner: randomUUID() }),
    /nested/,
  );
  symlinkSync(join(root, 'owned'), join(root, 'alias'));
  assert.throws(
    () => privatePath(join(root, 'alias/child'), { testOwner: randomUUID() }),
    /symlink/,
  );
  writeFileSync(join(root, 'public'), '{}', { mode: 0o644 });
  // Establish the fault even when the caller's umask narrows file creation modes.
  chmodSync(join(root, 'public'), 0o644);
  assert.throws(() => readJson(join(root, 'public')), /owner-only/);
  assert.throws(() => readPrivateText(join(root, 'owned'), 1024), /regular/);
  writeFileSync(join(root, 'oversized'), 'x'.repeat(1025), { mode: 0o600 });
  assert.throws(() => readPrivateText(join(root, 'oversized'), 1024), /bounded/);
});
test('pilot TLS validates expiry, names and pairing while leaf renewal preserves the CA', (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'loom-pilot-tls-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tls = certificate(root);
  validateTls({ tls });
  const next = certificate(root, tls);
  assert.equal(next.ca, tls.ca);
  assert.equal(next.caKey, tls.caKey);
  assert.notEqual(next.cert, tls.cert);
  validateTls({ tls: next });
  assert.throws(() => validateTls({ tls: { ...tls, key: next.key } }), /pairing/);
  const expired = expiredLeaf(root, tls);
  assert.throws(() => validateTls({ tls: expired }), /expiry/);
  validateTls({ tls: expired }, { allowExpiredLeaf: true });
});
test('pilot conflicting and interrupted controllers do not silently take each other’s lock', (t) => {
  const path = mkdtempSync(join(realpathSync(tmpdir()), 'loom-pilot-lock-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const d = { path, owner: 'a'.repeat(64) },
    unlock = lock(d, 'start');
  assert.throws(() => lock(d, 'stop'), /locked/);
  assert.throws(() => recoverLock(d), /running/);
  unlock();
  mkdirSync(join(path, 'operation.lock'), { mode: 0o700 });
  writeFileSync(
    join(path, 'operation.lock/owner.json'),
    JSON.stringify({ owner: d.owner, pid: 2147483647, action: 'start' }),
    { mode: 0o600 },
  );
  recoverLock(d);
  const release = lock(d, 'stop');
  release();
});
