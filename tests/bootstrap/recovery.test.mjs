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
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { privatePath, start } from '../../scripts/lib/recovery.mjs';

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
