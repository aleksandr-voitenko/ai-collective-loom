import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../../', import.meta.url));
const policy = JSON.parse(readFileSync(join(root, 'config/recovery.json')));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code) => {
  throw new Error('Recovery refused: ' + code + '.');
};
const jsonBytes = 16 * 1024 * 1024;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 900000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) fail(command + ' operation failed');
}

function json(path, value) {
  writeFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx', flush: true });
}

function checkedFile(path, limit) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    fail('backup representation exceeds its bound or is not a regular file');
}

function readJson(path) {
  checkedFile(path, jsonBytes);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail('malformed JSON');
  }
}

function crypt(mode, input, output, key, scratch) {
  const args = [
    '--no-options',
    '--homedir',
    scratch,
    '--batch',
    '--yes',
    '--no-symkey-cache',
    '--pinentry-mode',
    'loopback',
    '--passphrase-fd',
    '0',
    '--output',
    output,
  ];
  run(
    'gpg',
    mode === 'encrypt'
      ? [...args, '--symmetric', '--cipher-algo', 'AES256', '--compress-algo', 'none', input]
      : [...args, '--decrypt', input],
    { input: key },
  );
}

// The CLI always uses the configured ceiling. A caller may only tighten it; tests
// exercise real tar/encryption boundaries with one smaller policy on both sides.
export function recoveryBundle({
  maxArchiveBytes = policy.maxArchiveBytes,
  validateManifest = () => {},
} = {}) {
  if (
    !Number.isSafeInteger(maxArchiveBytes) ||
    maxArchiveBytes < 1 ||
    maxArchiveBytes > policy.maxArchiveBytes
  )
    fail('invalid backup size ceiling');

  function normalize(input, output) {
    checkedFile(input, maxArchiveBytes);
    run('python3', [
      join(root, 'scripts/lib/recovery-archive.py'),
      input,
      output,
      String(maxArchiveBytes),
    ]);
    checkedFile(output, maxArchiveBytes);
  }

  function admit(path, key, scratch, marker) {
    const encrypted = join(path, 'manifest.gpg');
    checkedFile(encrypted, maxArchiveBytes);
    if (marker.format !== policy.format || marker.manifestSha256 !== hash(readFileSync(encrypted)))
      fail('incomplete or corrupted manifest');
    const target = join(scratch, 'read-manifest.json');
    crypt('decrypt', encrypted, target, key, scratch);
    const manifest = readJson(target);
    validateManifest(manifest);
    if (
      JSON.stringify(Object.keys(manifest.components).sort()) !==
      JSON.stringify(['config', 'postgres', 'seaweed'])
    )
      fail('missing backup component');
    for (const name of ['config', 'postgres', 'seaweed']) {
      const component = manifest.components[name],
        file = join(path, name + '.gpg');
      checkedFile(file, maxArchiveBytes);
      if (component.file !== name + '.gpg' || hash(readFileSync(file)) !== component.sha256)
        fail('corrupted component');
      const plain = join(scratch, 'read-' + name + (name === 'config' ? '.json' : '.tar'));
      crypt('decrypt', file, plain, key, scratch);
      checkedFile(
        plain,
        name === 'config' ? Math.min(jsonBytes, maxArchiveBytes) : maxArchiveBytes,
      );
      if (hash(readFileSync(plain)) !== component.plainSha256) fail('component integrity');
      if (name !== 'config') normalize(plain, join(scratch, name + '-checked.tar'));
    }
    const config = readJson(join(scratch, 'read-config.json'));
    return { manifest, config };
  }

  function read(path, key, scratch) {
    return admit(path, key, scratch, readJson(join(path, 'COMPLETED.json')));
  }

  function write(path, manifest, sources, key, scratch, { fault } = {}) {
    manifest = { ...manifest, components: {} };
    for (const name of ['postgres', 'seaweed', 'config']) {
      let plain = sources[name];
      if (name !== 'config') {
        plain = join(scratch, name + '-checked.tar');
        normalize(sources[name], plain);
      }
      checkedFile(
        plain,
        name === 'config' ? Math.min(jsonBytes, maxArchiveBytes) : maxArchiveBytes,
      );
      const encrypted = join(path, name + '.gpg');
      crypt('encrypt', plain, encrypted, key, scratch);
      checkedFile(encrypted, maxArchiveBytes);
      manifest.components[name] = {
        file: name + '.gpg',
        sha256: hash(readFileSync(encrypted)),
        plainSha256: hash(readFileSync(plain)),
      };
    }
    const plain = join(scratch, 'manifest.json');
    json(plain, manifest);
    checkedFile(plain, jsonBytes);
    crypt('encrypt', plain, join(path, 'manifest.gpg'), key, scratch);
    checkedFile(join(path, 'manifest.gpg'), maxArchiveBytes);
    const marker = {
      format: policy.format,
      manifestSha256: hash(readFileSync(join(path, 'manifest.gpg'))),
    };
    // Completion certifies exactly the same admission/roundtrip as inspection.
    // This gate runs while the marker is still private controller state.
    admit(path, key, scratch, marker);
    if (hash(readFileSync(join(scratch, 'read-manifest.json'))) !== hash(readFileSync(plain)))
      fail('manifest capture integrity');
    if (fault === 'before-completion') fail('injected backup interruption');
    json(join(path, 'COMPLETED.json'), marker);
  }
  return { read, write };
}
