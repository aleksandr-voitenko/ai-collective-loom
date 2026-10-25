import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  symlinkSync,
  realpathSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { privatePath, start } from '../../scripts/lib/recovery.mjs';
import { recoveryBundle } from '../../scripts/lib/recovery-bundle.mjs';

function bundleFixture(payload) {
  const directory = mkdtempSync(join(realpathSync('/tmp'), 'loom-recovery-boundary-'));
  const path = directory + '/backup',
    scratch = directory + '/scratch',
    inspection = directory + '/inspection';
  for (const selected of [path, scratch, inspection]) mkdirSync(selected, { mode: 0o700 });
  const archive = directory + '/input.tar';
  const result = spawnSync('python3', [
    '-c',
    `import io,sys,tarfile
with tarfile.open(sys.argv[1],'w',format=tarfile.USTAR_FORMAT) as archive:
 member=tarfile.TarInfo('synthetic'); member.size=int(sys.argv[2]); member.mode=0o600
 archive.addfile(member,io.BytesIO(b'x'*member.size))
`,
    archive,
    String(payload),
  ]);
  assert.equal(result.status, 0);
  const config = directory + '/config.json';
  writeFileSync(config, '{"synthetic":true}\n', { mode: 0o600 });
  return {
    directory,
    path,
    scratch,
    inspection,
    sources: { postgres: archive, seaweed: archive, config },
    manifest: { format: 'loom-cold-backup-1', backupId: 'synthetic-size-boundary' },
    key: randomBytes(32).toString('base64url') + '\n',
  };
}

const boundaryBytes = 30 * 1024;
for (const [name, payload] of [
  ['tar overhead', boundaryBytes],
  ['encryption overhead', boundaryBytes - 2048],
])
  test('capture refuses ' + name + ' beyond the shared ceiling without completion', () => {
    const f = bundleFixture(payload);
    try {
      const bundle = recoveryBundle({ maxArchiveBytes: boundaryBytes });
      assert.equal(statSync(f.sources.postgres).size > boundaryBytes, name === 'tar overhead');
      assert.throws(
        () => bundle.write(f.path, f.manifest, f.sources, f.key, f.scratch),
        /bound|python3 operation failed/,
      );
      assert.equal(existsSync(f.path + '/COMPLETED.json'), false);
      if (name === 'encryption overhead')
        assert.ok(statSync(f.path + '/postgres.gpg').size > boundaryBytes);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

test('below-ceiling completed capture is readable under the identical tar and encryption policy', () => {
  const f = bundleFixture(16 * 1024);
  try {
    const bundle = recoveryBundle({ maxArchiveBytes: boundaryBytes });
    bundle.write(f.path, f.manifest, f.sources, f.key, f.scratch);
    assert.ok(existsSync(f.path + '/COMPLETED.json'));
    const captured = bundle.read(f.path, f.key, f.inspection);
    assert.equal(captured.manifest.backupId, f.manifest.backupId);
    assert.deepEqual(captured.config, { synthetic: true });
    for (const name of ['postgres', 'seaweed']) {
      assert.ok(statSync(f.path + '/' + name + '.gpg').size <= boundaryBytes);
      assert.deepEqual(
        readFileSync(f.inspection + '/read-' + name + '.tar'),
        readFileSync(f.sources[name]),
      );
    }
    writeFileSync(f.path + '/postgres.gpg', Buffer.alloc(boundaryBytes + 1), { mode: 0o600 });
    assert.throws(
      () => bundle.read(f.path, f.key, f.inspection),
      /representation exceeds its bound/,
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('an internal bundle ceiling cannot raise or disable the configured defense', () => {
  const configured = JSON.parse(readFileSync('config/recovery.json')).maxArchiveBytes;
  for (const value of [0, -1, Infinity, NaN, 1.5, configured + 1])
    assert.throws(() => recoveryBundle({ maxArchiveBytes: value }), /invalid backup size ceiling/);
});

test('a concurrent controller cannot restart a locked instance', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'loom-recovery-lock-'));
  try {
    writeFileSync(dir + '/operation.lock', '', { mode: 0o600 });
    await assert.rejects(start({ path: dir }), /locked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery rejects nonprivate, repository and symlink selections', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'loom-recovery-paths-'));
  try {
    assert.equal(privatePath(dir), dir);
    assert.throws(() => privatePath(process.cwd()));
    assert.throws(() => privatePath('relative'));
    writeFileSync(dir + '/public', 'synthetic', { mode: 0o644 });
    chmodSync(dir + '/public', 0o644);
    assert.throws(() => privatePath(dir + '/public'));
    symlinkSync(dir + '/public', dir + '/link');
    assert.throws(() => privatePath(dir + '/link'));
    assert.throws(() => privatePath(dir, { newPath: true }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const attack of [
  '../escape',
  '/absolute',
  'symlink',
  'hardlink',
  'duplicate',
  'device',
  'special-mode',
  'nested/../alias',
])
  test('archive validation refuses ' + attack, () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'loom-recovery-archive-'));
    try {
      const fixture = `import io,tarfile,sys
with tarfile.open(sys.argv[1],'w') as t:
 a=tarfile.TarInfo(sys.argv[2]); a.size=1
 if a.name=='symlink': a.type=tarfile.SYMTYPE; a.linkname='/tmp/escape'; a.size=0
 if a.name=='hardlink': a.type=tarfile.LNKTYPE; a.linkname='target'; a.size=0
 if a.name=='device': a.type=tarfile.CHRTYPE; a.size=0
 if a.name=='special-mode': a.mode=0o4755
 t.addfile(a,io.BytesIO(b'x') if a.isfile() else None)
 if a.name=='duplicate': t.addfile(a,io.BytesIO(b'x'))
`;
      assert.equal(spawnSync('python3', ['-c', fixture, dir + '/input', attack]).status, 0);
      const result = spawnSync(
        'python3',
        ['scripts/lib/recovery-archive.py', dir + '/input', dir + '/output'],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 1);
      assert.equal(existsSync(dir + '/output'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
