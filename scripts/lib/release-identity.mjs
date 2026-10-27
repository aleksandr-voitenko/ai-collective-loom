import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

/** Exact inputs to the maintained application build; no timestamps or host paths. */
export function applicationInputs(root) {
  const files = {};
  const digest = (p) =>
    createHash('sha256')
      .update(readFileSync(join(root, p)))
      .digest('hex');
  function visit(directory) {
    for (const name of readdirSync(join(root, directory)).sort()) {
      const path = directory + '/' + name,
        stat = lstatSync(join(root, path));
      if (stat.isSymbolicLink())
        throw new Error('Application build input must not be a symlink.');
      if (stat.isDirectory()) visit(path);
      else if (/\.(ts|tsx|css)$/.test(path)) files[path] = digest(path);
    }
  }
  visit('src');
  for (const path of [
    'package.json',
    'package-lock.json',
    'tsconfig.base.json',
    'tsconfig.server.json',
    'tsconfig.web.json',
    'vite.config.ts',
    'src/web/index.html',
    '.nvmrc',
  ])
    files[path] = digest(path);
  return {
    format: 'loom-application-build-1',
    node: process.version,
    files,
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
  };
}
