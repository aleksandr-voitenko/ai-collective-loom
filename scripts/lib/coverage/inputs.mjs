import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, lstatSync, existsSync } from 'node:fs';
import { join, relative, isAbsolute, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { git } from './policy.mjs';
import { mergeExact, canonicalizeLocations } from './merge.mjs';
const require = createRequire(import.meta.url), Report = require('c8/lib/report'), convert = require('v8-to-istanbul');
export const digest = value => createHash('sha256').update(value).digest('hex');
export function sourceFiles(repo) {
  return git(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0')
    .filter(path => /^(src\/.*\.tsx?|scripts\/.*\.(?:mjs|js|ts)|\.githooks\/.*\.mjs|vite\.config\.ts)$/.test(path)
      && !path.endsWith('.d.ts') && !path.endsWith('.test.mjs') && existsSync(join(repo, path)))
    .map(path => { assert.ok(lstatSync(join(repo, path)).isFile(), 'Source must be a regular file'); return path; })
    .sort();
}
export function manifest(repo) {
  const sources = sourceFiles(repo), hashes = {};
  for (const path of git(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
    if (!existsSync(join(repo, path))) continue; // A tracked deletion is not an input to the current build.
    const stat = lstatSync(join(repo, path));
    if (!stat.isFile()) continue;
    hashes[path] = digest(readFileSync(join(repo, path)));
  }
  assert.ok(sources.length && sources.some(path => path.startsWith('src/web/')));
  return { sources, hashes, head: git(repo, ['rev-parse', 'HEAD']).trim() };
}
export function verifyManifest(repo, before) {
  const after = manifest(repo);
  assert.deepEqual(after.sources, before.sources, 'Source denominator changed during collection');
  assert.deepEqual(Object.keys(after.hashes).sort(), Object.keys(before.hashes).sort(), 'Input file set changed during collection');
  for (const [path, hash] of Object.entries(before.hashes)) {
    assert.equal(after.hashes[path], hash, 'Input changed during collection: ' + path);
  }
}
export async function collectNodeCoverage(repo, sources, rawDirectories, normalized, all) {
  mkdirSync(normalized, { recursive: true });
  assert.equal(readdirSync(normalized).length, 0, 'Never mix stale coverage inputs');
  const eligible = new Set(sources.map(path => join(repo, path))), loaded = new Set(), mapped = new Set(), maps = new Map();
  function select(url) {
    let path;
    try { path = url.startsWith('file:') ? fileURLToPath(url) : isAbsolute(url) ? url : undefined; } catch { return; }
    return path && (eligible.has(path) || path.startsWith(join(repo, 'dist/server/')) || path.startsWith(join(repo, 'dist/contracts/'))
      || path.startsWith(join(repo, 'node_modules/.vite-temp/vite.config.ts.'))) ? path : undefined;
  }
  let selected = 0;
  for (const [index, directory] of rawDirectories.entries()) {
    const names = readdirSync(directory).filter(name => name.endsWith('.json'));
    assert.ok(names.length, 'A successful suite must flush Node coverage');
    for (const name of names) {
      const data = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      assert.ok(Array.isArray(data.result));
      const result = data.result.filter(entry => select(entry.url));
      if (!result.length) continue;
      const cache = {};
      for (const [url, value] of Object.entries(data['source-map-cache'] ?? {})) {
        const path = select(url); if (!path) continue;
        const key = pathToFileURL(path).href;
        if (value.data) {
          const hash = digest(JSON.stringify({ data: value.data, lineLengths: value.lineLengths }));
          assert.ok(!maps.has(key) || maps.get(key) === hash, 'One Node source has inconsistent generated maps');
          maps.set(key, hash); mapped.add(path);
        }
        cache[key] = value;
      }
      for (const entry of result) { const path = select(entry.url); loaded.add(path); entry.url = pathToFileURL(path).href; }
      writeFileSync(join(normalized, index + '-' + name), JSON.stringify({ result, 'source-map-cache': cache })); selected++;
    }
  }
  assert.ok(selected, 'No authored Node execution was collected');
  for (const path of loaded) if (eligible.has(path) && /\.tsx?$/.test(path)) assert.ok(mapped.has(path), 'Missing TypeScript source map: ' + relative(repo, path));
  const report = new Report({ reporter: [], reportsDirectory: normalized, tempDirectory: normalized,
    all, src: [repo], include: sources, exclude: ['node_modules/**', 'coverage/**', 'tests/**', '**/*.d.ts'],
    excludeAfterRemap: true, extension: ['.js', '.mjs', '.ts', '.tsx'], omitRelative: true, excludeNodeModules: true, mergeAsync: true });
  // c8's final Istanbul merge infers hits from enclosing ranges when tsx and tsc
  // map different generated scripts to one source. Use its pinned V8 normalization
  // and cold-file discovery, then exact-location merging for every compiler pair.
  const processCoverage = await report._getMergedProcessCovAsync();
  assert.ok(processCoverage?.result.length, 'No normalized Node coverage');
  return { report, processCoverage, eligible };
}

export async function nodeCoverage(repo, sources, rawDirectories, normalized, all) {
  const { report, processCoverage, eligible } = await collectNodeCoverage(repo, sources, rawDirectories, normalized, all);
  const inputs = [];
  for (const script of processCoverage.result) {
    const path = resolve(script.url);
    const converter = convert(path, report.wrapperLength, report._getSourceMap(script), source => !eligible.has(source));
    // Unlike c8's report loop, conversion errors must fail the measurement.
    await converter.load();
    const sourceMap = converter.rawSourceMap?.sourcemap;
    if (sourceMap?.sourcesContent) for (let i = 0; i < sourceMap.sources.length; i++) {
      const name = sourceMap.sources[i];
      const original = name.startsWith('file:') ? fileURLToPath(name) : resolve(dirname(path), sourceMap.sourceRoot || '', name);
      if (eligible.has(original) && sourceMap.sourcesContent[i] !== null) {
        assert.equal(digest(sourceMap.sourcesContent[i]), digest(readFileSync(original)), 'Node source map does not match source');
      }
    }
    converter.applyCoverage(script.functions);
    const input = converter.toIstanbul();
    for (const source of Object.keys(input)) assert.ok(eligible.has(source), 'Unexpected remapped source');
    canonicalizeLocations(input, source => readFileSync(source, 'utf8'));
    inputs.push(input);
  }
  return mergeExact(...inputs);
}
