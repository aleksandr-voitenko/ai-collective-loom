// The distributed boundary contains only plan-bound identities, hashes and numeric
// measurements. Raw V8 documents, source text, map names and URLs never cross it.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { TraceMap, decodedMappings } from '@jridgewell/trace-mapping';
import { collectNodeCoverage, digest } from './inputs.mjs';
const require = createRequire(import.meta.url), convert = require('v8-to-istanbul');
export const portableLimit = 64 * 1024 * 1024;
export function keys(value, expected) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object');
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'Unexpected evidence fields');
}
const integer = (n, maximum = 1_000_000_000_000) => assert.ok(Number.isSafeInteger(n) && n >= 0 && n <= maximum, 'Invalid numeric evidence');
const list = (value, maximum) => assert.ok(Array.isArray(value) && value.length <= maximum, 'Evidence collection exceeds its bound');
export function readEvidence(path, maximum = portableLimit) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum, 'Invalid evidence file');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function writeEvidence(path, data) {
  const bytes = JSON.stringify(data) + '\n';
  assert.ok(Buffer.byteLength(bytes) <= portableLimit, 'Evidence exceeds byte bound');
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
}
export function buildInventory(repo) {
  const result = {};
  function visit(path) {
    for (const name of readdirSync(join(repo, path)).sort()) {
      const child = path + '/' + name, stat = lstatSync(join(repo, child));
      assert.ok(!stat.isSymbolicLink(), 'Build contains a link');
      if (stat.isDirectory()) visit(child);
      else { assert.ok(stat.isFile()); result[child] = digest(readFileSync(join(repo, child))); }
    }
  }
  visit('dist');
  return result;
}
export function scriptNames(plan) {
  return [...plan.inputs.sources, ...Object.keys(plan.build).filter(p => /^dist\/(server|contracts)\/.*\.js$/.test(p)), '@vite-config'];
}
const location = (lines, value, generatedExtent = 0) => {
  integer(value[0]); integer(value[1]);
  assert.ok(value[0] < lines.length && value[1] <= Math.max(lines[value[0]].length, generatedExtent), 'Mapping is outside source');
};
export function encodeFunctions(functions) {
  return functions.map(fn => [fn.isBlockCoverage, fn.ranges.map(r => [r.startOffset, r.endOffset, r.count])]);
}
export function decodeFunctions(value, length) {
  list(value, 100_000); assert.ok(value.length, 'Missing function measurements');
  let count = 0;
  return value.map(fn => {
    assert.ok(Array.isArray(fn) && fn.length === 2 && typeof fn[0] === 'boolean');
    list(fn[1], 1_000_000); assert.ok(fn[1].length > 0);
    const stack = [];
    const ranges = fn[1].map((r, index) => {
      assert.ok(Array.isArray(r) && r.length === 3); integer(r[0], length); integer(r[1], length); integer(r[2]);
      assert.ok(r[0] <= r[1]);
      while (stack.length && r[0] >= stack.at(-1)[1]) stack.pop();
      if (index) assert.ok(stack.length && r[0] >= stack.at(-1)[0] && r[1] <= stack.at(-1)[1], 'Invalid range tree');
      stack.push(r); assert.ok(++count <= 1_000_000, 'Too many ranges');
      return { startOffset: r[0], endOffset: r[1], count: r[2] };
    });
    return { functionName: '', isBlockCoverage: fn[0], ranges };
  });
}
export async function exportNode(repo, plan, directories, normalized) {
  const { report, eligible } = await collectNodeCoverage(repo, plan.inputs.sources, directories, normalized, false);
  const names = scriptNames(plan), stages = directories.map(() => ({ scripts: [], processes: [] }));
  const dictionaries = directories.map(() => new Map());
  // Preserve each process. c8 merges these incrementally; premerging a shard can
  // change block/function coverage flags and therefore the branch population.
  for (const filename of readdirSync(normalized).sort()) {
    const match = /^(\d+)-coverage-(\d+)-(\d+)-(\d+)\.json$/.exec(filename);
    assert.ok(match, 'Unexpected Node capture filename');
    const [stageIndex, ...order] = match.slice(1).map(Number), stage = stages[stageIndex];
    assert.ok(stage, 'Unexpected Node stage');
    const data = readEvidence(join(normalized, filename)), entries = [];
    for (const script of data.result) {
      const path = fileURLToPath(script.url), name = relative(repo, path);
      const scriptIndex = names.indexOf(name.startsWith('node_modules/.vite-temp/vite.config.ts.') ? '@vite-config' : name);
      assert.ok(scriptIndex >= 0, 'Unknown measured script');
      let index = dictionaries[stageIndex].get(name);
      if (index === undefined) {
        const supplied = report._getSourceMap({ ...script, url: path }), converter = convert(path, report.wrapperLength, supplied, source => !eligible.has(source));
        await converter.load();
        let projection = null;
        const map = converter.rawSourceMap?.sourcemap;
        if (map) {
          const sources = map.sources.map((name, i) => {
            const original = name.startsWith('file:') ? fileURLToPath(name) : resolve(dirname(path), map.sourceRoot || '', name);
            const sourceIndex = plan.inputs.sources.indexOf(relative(repo, original));
            assert.ok(sourceIndex >= 0, 'Map contains an unknown source');
            assert.equal(digest(map.sourcesContent?.[i] ?? readFileSync(original)), plan.inputs.hashes[plan.inputs.sources[sourceIndex]], 'Map source changed');
            return sourceIndex;
          });
          const source = (supplied?.source || readFileSync(path, 'utf8')).trimEnd();
          projection = { identity: digest(JSON.stringify({ map, lineLengths: supplied?.source?.split('\n').map(line => line.length) ?? null }).split(repo).join('<repo>')), sources, lengths: source.split('\n').map(line => line.length),
            mappings: decodedMappings(new TraceMap(map)).map(line => line.map(segment => segment.slice(0, 4))) };
        }
        index = stage.scripts.length; dictionaries[stageIndex].set(name, index);
        stage.scripts.push({ script: scriptIndex, instance: names[scriptIndex] === '@vite-config' ? digest(name) : null, projection });
      }
      entries.push({ script: index, functions: encodeFunctions(script.functions) });
    }
    stage.processes.push({ order, entries });
  }
  validateNode(repo, plan, stages);
  return stages;
}
export function validateNode(repo, plan, stages) {
  list(stages, 128); assert.ok(stages.length);
  for (const stage of stages) {
    keys(stage, ['scripts', 'processes']);
    const records = stage.scripts;
    list(records, 4096); assert.ok(records.length);
    const lengths = [];
    const names = scriptNames(plan), seen = new Set(), sourceLines = new Map();
    const linesFor = index => { if (!sourceLines.has(index)) sourceLines.set(index, readFileSync(join(repo, plan.inputs.sources[index]), 'utf8').split('\n')); return sourceLines.get(index); };
    for (const record of records) {
      keys(record, ['script', 'instance', 'projection']); integer(record.script, names.length - 1);
      const name = names[record.script], p = record.projection;
      if (name === '@vite-config') assert.match(record.instance, /^[a-f0-9]{64}$/); else assert.equal(record.instance, null);
      const key = record.script + ':' + record.instance;
      assert.ok(!seen.has(key), 'Duplicate script'); seen.add(key);
      let length;
      if (p === null) {
        assert.ok(plan.inputs.sources.includes(name), 'Generated script needs a projection');
        length = readFileSync(join(repo, name), 'utf8').length;
      } else {
        keys(p, ['identity', 'sources', 'lengths', 'mappings']); assert.match(p.identity, /^[a-f0-9]{64}$/); list(p.sources, plan.inputs.sources.length); assert.ok(p.sources.length);
        for (const source of p.sources) integer(source, plan.inputs.sources.length - 1);
        if (name === '@vite-config') assert.deepEqual(p.sources.map(i => plan.inputs.sources[i]), ['vite.config.ts']);
        list(p.lengths, 1_000_000); assert.ok(p.lengths.length);
        for (const n of p.lengths) integer(n, 16 * 1024 * 1024);
        length = p.lengths.reduce((n, size) => n + size + 1, 0); integer(length, 16 * 1024 * 1024);
        list(p.mappings, p.lengths.length + 1);
        let segments = 0;
        // Vite's config bundler maps its injected path variables beyond the
        // authored first line. Preserve those pinned numeric mappings (bounded by
        // generated extent); final reported ranges still must fit authored source.
        p.mappings.forEach((line, i) => {
          list(line, 1_000_000); let previous = -1;
          for (const s of line) {
            assert.ok(Array.isArray(s) && (s.length === 1 || s.length === 4));
            integer(s[0], p.lengths[i] ?? 0); assert.ok(s[0] >= previous); previous = s[0];
            if (s.length === 4) { integer(s[1], p.sources.length - 1); location(linesFor(p.sources[s[1]]), s.slice(2), name === '@vite-config' ? length : 0); }
            assert.ok(++segments <= 1_000_000);
          }
        });
      }
      // V8 can include the final newline which CovSource trims before remapping.
      lengths.push(length + 1);
    }
    list(stage.processes, 10_000); assert.ok(stage.processes.length);
    const processes = new Set(), used = new Set();
    for (const process of stage.processes) {
      keys(process, ['order', 'entries']);
      list(process.order, 3); assert.equal(process.order.length, 3);
      for (const n of process.order) integer(n, Number.MAX_SAFE_INTEGER);
      const order = process.order.join('-'); assert.ok(!processes.has(order), 'Duplicate Node process'); processes.add(order);
      list(process.entries, 4096); assert.ok(process.entries.length);
      for (const entry of process.entries) {
        keys(entry, ['script', 'functions']); integer(entry.script, records.length - 1); used.add(entry.script);
        decodeFunctions(entry.functions, lengths[entry.script]);
      }
    }
    assert.equal(used.size, records.length, 'Unreferenced Node script');
  }
}
// Each outer item is one original stage. Multiple browser workers contribute to
// its single stage; process filenames retain c8's original lexical merge order.
export function importNode(repo, plan, stages, directory) {
  mkdirSync(directory, { recursive: true });
  assert.equal(readdirSync(directory).length, 0, 'Stale imported evidence');
  const names = scriptNames(plan), signatures = new Map();
  return stages.map((groups, stageIndex) => {
    const raw = join(directory, String(stageIndex)); mkdirSync(raw);
    groups.forEach((stage, groupIndex) => {
      validateNode(repo, plan, [stage]);
      const metadata = stage.scripts.map(record => {
        const name = names[record.script], p = record.projection, hash = digest(JSON.stringify(p)), key = name + ':' + record.instance;
        assert.ok(!signatures.has(key) || signatures.get(key) === hash, 'Inconsistent generated mapping across jobs'); signatures.set(key, hash);
        const path = name === '@vite-config' ? join(repo, 'node_modules/.vite-temp/vite.config.ts.portable-' + record.instance + '.mjs') : join(repo, name), url = pathToFileURL(path).href;
        const length = p ? p.lengths.reduce((n, size) => n + size + 1, 0) : readFileSync(path, 'utf8').length;
        const cache = p ? { lineLengths: p.lengths, data: { version: 3, names: [],
          sources: p.sources.map(i => join(repo, plan.inputs.sources[i])),
          sourcesContent: p.sources.map(i => readFileSync(join(repo, plan.inputs.sources[i]), 'utf8')), mappings: p.mappings } } : null;
        return { url, length, cache };
      });
      for (const process of stage.processes) {
        const cache = {}, result = process.entries.map((entry, i) => {
          const item = metadata[entry.script]; if (item.cache) cache[item.url] = item.cache;
          return { scriptId: String(i), url: item.url, functions: decodeFunctions(entry.functions, item.length + 1) };
        });
        // The group suffix keeps equal PID/time/thread tuples from independent
        // runners distinct, without collapsing either process's measurements.
        writeEvidence(join(raw, 'coverage-' + process.order.join('-') + '.json-' + groupIndex + '.json'), { result, 'source-map-cache': cache });
      }
    });
    return raw;
  });
}
export function compactBrowser(entries, assets) {
  const names = [...assets.keys()];
  return entries.map(entry => ({ asset: names.indexOf(entry.asset), functions: encodeFunctions(entry.functions) }));
}
export function expandBrowser(records, assets) {
  list(records, 100_000); const names = [...assets.keys()];
  return records.map(record => {
    keys(record, ['asset', 'functions']); integer(record.asset, names.length - 1);
    const asset = names[record.asset], info = assets.get(asset);
    return { asset, sha256: info.sha256, functions: decodeFunctions(record.functions, info.length) };
  });
}
