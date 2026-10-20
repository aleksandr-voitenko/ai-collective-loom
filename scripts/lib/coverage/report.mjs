import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import coverage from 'istanbul-lib-coverage';
import { digest, nodeCoverage, verifyManifest } from './inputs.mjs';
import { remap, readCaptures } from './browser.mjs';
import { mergeExact, canonicalizeLocations } from './merge.mjs';
import { changedLineCoverage, evaluateGates, validateBaseline, git } from './policy.mjs';
const { createCoverageMap, createCoverageSummary } = coverage;

export async function combinedReport(repo, runRoot, record, output) {
  assert.equal(record.probe?.code, 0, 'Coverage probes must pass');
  verifyManifest(repo, record.inputs);
  assert.deepEqual(record.stages.map(s => s.name), record.expectedStages, 'Every suite is required');
  assert.ok(record.stages.every(s => s.code === 0), 'Failed suite cannot produce passing coverage');
  const sources = record.inputs.sources, eligible = new Set(sources);
  const node = await nodeCoverage(repo, sources, record.stages.filter(s => s.name !== 'chromium').map(s => s.raw), join(runRoot, 'normalized-node'), true);
  const browserNode = await nodeCoverage(repo, sources, [record.stages.at(-1).raw], join(runRoot, 'normalized-browser-node'), false);
  const assetsRoot = join(repo, 'dist/web/assets');
  const assets = new Map(readdirSync(assetsRoot).filter(name => name.endsWith('.js')).map(name => {
    const source = readFileSync(join(assetsRoot, name), 'utf8'); return [name, { sha256: digest(source), length: source.length }];
  }));
  assert.deepEqual(Object.fromEntries([...assets].map(([name, value]) => [name, value.sha256])), record.assets, 'Browser build changed during collection');
  const browserRun = JSON.parse(readFileSync(join(repo, 'browser-diagnostics/approved/run.json'), 'utf8'));
  const captures = readCaptures(join(runRoot, 'browser'), browserRun, assets);
  const pages = captures.flatMap(c => c.pages), entries = pages.flatMap(p => p.entries), browserMaps = [];
  const mappedSources = new Set();
  for (const asset of assets.keys()) {
    const selected = entries.filter(entry => entry.asset === asset); assert.ok(selected.length, 'An application bundle was not observed');
    const { files, sourceMap } = await remap(join(assetsRoot, asset), selected);
    for (let i = 0; i < sourceMap.sources.length; i++) {
      const path = resolve(assetsRoot, sourceMap.sources[i]), name = relative(repo, path);
      if (!eligible.has(name)) continue;
      assert.equal(digest(sourceMap.sourcesContent[i]), record.inputs.hashes[name], 'Browser source map does not match source');
      mappedSources.add(name);
    }
    browserMaps.push(Object.fromEntries(Object.entries(files).filter(([path]) => eligible.has(relative(repo, path)))));
  }
  const browser = mergeExact(...browserMaps);
  for (const input of [node, browserNode, browser]) canonicalizeLocations(input, path => readFileSync(path, 'utf8'));
  const map = createCoverageMap(mergeExact(node, browserNode, browser));
  assert.deepEqual(map.files().sort(), sources.map(name => join(repo, name)).sort());
  const files = {}, groups = {};
  for (const path of map.files()) {
    const file = map.fileCoverageFor(path), source = readFileSync(path, 'utf8').split('\n'), summary = file.toSummary().toJSON();
    const lines = file.getLineCoverage(), branches = Object.entries(file.branchMap).flatMap(([id, branch]) => branch.locations.map((loc, index) => ({ loc, hits: file.b[id][index] })));
    assert.ok(Object.keys(lines).every(line => Number(line) >= 1 && Number(line) <= source.length));
    assert.equal(branches.length, summary.branches.total);
    for (const { loc, hits } of branches) {
      assert.ok(Number.isSafeInteger(hits) && hits >= 0);
      for (const p of [loc.start, loc.end]) assert.ok(p.line >= 1 && p.line <= source.length && p.column >= 0 && p.column <= source[p.line-1].length, 'Invalid branch source coordinates');
    }
    files[relative(repo, path)] = { lines, branches, summary: { lines: summary.lines, branches: summary.branches } };
  }
  for (const [name, prefix] of [['application','src/'],['frontend','src/web/'],['backend','src/server/'],['contracts','src/contracts/'],['tooling',null],['all','']]) {
    const summary = createCoverageSummary(); let count = 0;
    for (const path of map.files()) if (prefix === null ? !relative(repo,path).startsWith('src/') : relative(repo,path).startsWith(prefix)) { count++; summary.merge(map.fileCoverageFor(path).toSummary()); }
    const s = summary.toJSON(); groups[name] = { files: count, lines: s.lines, branches: s.branches };
  }
  const baseline = JSON.parse(readFileSync(join(repo, 'config/coverage-baseline.json'), 'utf8'));
  let previous;
  const names = git(repo, ['ls-tree', '--name-only', record.base, '--', 'config/coverage-baseline.json']).trim();
  if (names) previous = JSON.parse(git(repo, ['show', record.base + ':config/coverage-baseline.json']));
  validateBaseline(baseline, previous);
  const changed = changedLineCoverage(repo, record.base, files), gates = evaluateGates(groups.application, changed, baseline);
  const summary = { schema: 'loom-combined-coverage-1', method: baseline.method, status: gates.every(g => g.passed) ? 'passed' : 'failed',
    head: record.inputs.head, base: record.base, groups, changed, gates, baseline,
    browser: { tests: captures.length, pages: pages.length, snapshots: pages.reduce((n,p)=>n+p.captures,0), mappedSources: mappedSources.size },
    stages: record.stages.map(({ name, code }) => ({ name, code })),
    limits: ['Branches are V8 source ranges; distinct compiler ranges remain separate. They do not enumerate all logical conditions or races.',
      'Only mapped browser source lines contribute. Tree-shaken code receives no inferred browser hits.',
      'Intentionally killed Node children can lose unflushed counters. Missing execution is never guessed.',
      'Function coverage is outside this line/branch report. Raw Node/browser coverage and diagnostics are never included in coverage artifacts.'] };
  writeReports(repo, output, files, summary);
  // Publishing source text takes time too; a concurrent edit must invalidate the
  // artifact rather than leave counters beside a different version of the file.
  verifyManifest(repo, record.inputs);
  return summary;
}

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const metric = value => `${value.pct.toFixed(2)}% (${value.covered}/${value.total})`;
export function writeReports(repo, output, files, summary) {
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(join(output, 'coverage.json'), JSON.stringify(files) + '\n');
  const style = 'body{font:16px/1.5 system-ui;max-width:1150px;margin:32px auto;padding:0 24px;color:#172b3a}table{border-collapse:collapse;width:100%;margin:20px 0}th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd}pre{margin:0}.scroll{overflow:auto}.hit{background:#eef8ef}.miss{background:#ffe7e6}.source{font:13px/1.5 monospace}.source td{padding:1px 8px;border:0}a{color:#005f88}';
  const html = (title, body) => '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escape(title) + '</title><style>' + style + '</style>' + body + '</html>';
  let lcov = '', fileRows = '';
  for (const [name, file] of Object.entries(files)) {
    lcov += 'TN:\nSF:' + name + '\n';
    for (const [line, hits] of Object.entries(file.lines)) lcov += `DA:${line},${hits}\n`;
    lcov += `LF:${file.summary.lines.total}\nLH:${file.summary.lines.covered}\n`;
    file.branches.forEach((b,i) => { lcov += `BRDA:${b.loc.start.line},${i},0,${b.hits}\n`; });
    lcov += `BRF:${file.summary.branches.total}\nBRH:${file.summary.branches.covered}\nend_of_record\n`;
    const target = join(output, 'files', name + '.html'); mkdirSync(dirname(target), { recursive: true });
    const rows = readFileSync(join(repo,name), 'utf8').split('\n').map((text,index) => {
      const hits = file.lines[index+1], css = hits === undefined ? '' : hits ? 'hit' : 'miss';
      return `<tr id="L${index+1}" class="${css}"><td>${index+1}</td><td>${hits??'—'}</td><td><pre>${escape(text)}</pre></td></tr>`;
    }).join('');
    const branchRows = file.branches.map(b => `<tr><td>${b.loc.start.line}:${b.loc.start.column}–${b.loc.end.line}:${b.loc.end.column}</td><td>${b.hits}</td></tr>`).join('');
    const back = '../'.repeat(relative(output, target).split('/').length-1) + 'index.html';
    writeFileSync(target, html(name, `<p><a href="${back}">Combined report</a></p><h1>${escape(name)}</h1><p>Lines: ${metric(file.summary.lines)} · Branches: ${metric(file.summary.branches)}</p><div class="scroll"><table class="source">${rows}</table></div><h2>Branch ranges</h2><table><tr><th>Source range</th><th>Hits</th></tr>${branchRows}</table>`));
    fileRows += `<tr><th><a href="files/${escape(name)}.html">${escape(name)}</a></th><td>${metric(file.summary.lines)}</td><td>${metric(file.summary.branches)}</td></tr>`;
  }
  writeFileSync(join(output, 'lcov.info'), lcov);
  const rows = Object.entries(summary.groups).map(([name,g]) => `<tr><th>${name} (${g.files} files)</th><td>${metric(g.lines)}</td><td>${metric(g.branches)}</td></tr>`).join('');
  writeFileSync(join(output, 'index.html'), html('Combined coverage', `<h1>Combined line and branch coverage</h1><p>Gates: <strong>${summary.status}</strong>. Node/JSDOM, PostgreSQL and ${summary.browser.tests} Chromium scenarios.</p><p><a href="summary.json">Summary and gate details</a> · <a href="lcov.info">LCOV</a> · <a href="coverage.json">Line and branch data</a></p><table><tr><th>Scope</th><th>Lines</th><th>Branches</th></tr>${rows}</table><h2>Gates</h2><ul>${summary.gates.map(g=>`<li>${g.name}: ${g.applicable ? g.passed?'passed':'failed' : 'no changed reportable lines'}</li>`).join('')}</ul><h2>Method and limits</h2><ul>${summary.limits.map(l=>'<li>'+escape(l)+'</li>').join('')}</ul><h2>Source files</h2><table><tr><th>File</th><th>Lines</th><th>Branches</th></tr>${fileRows}</table>`));
}
