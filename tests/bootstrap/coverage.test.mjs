import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atLeast, validateBaseline, evaluateGates, changedLineCoverage, comparisonBase, git } from '../../scripts/lib/coverage/policy.mjs';
import { mergeExact, canonicalizeLocations } from '../../scripts/lib/coverage/merge.mjs';
import { readCaptures } from '../../scripts/lib/coverage/browser.mjs';
import { manifest, sourceFiles, verifyManifest, nodeCoverage } from '../../scripts/lib/coverage/inputs.mjs';
import { writeReports } from '../../scripts/lib/coverage/report.mjs';

const baseline = JSON.parse(readFileSync(new URL('../../config/coverage-baseline.json', import.meta.url), 'utf8'));
function scratch(t) { const path = mkdtempSync(join(tmpdir(), 'loom-coverage-test-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
const ratio = (covered, total) => ({ covered, total });

test('coverage gates enforce exact changed-line and branch thresholds independently', () => {
  const application = { lines: ratio(100,100), branches: ratio(85,100) };
  const gates = evaluateGates(application, ratio(9,10), baseline);
  assert.deepEqual(gates.map(({ name, passed }) => [name,passed]), [
    ['changed-lines',true],['branches',true],['baseline-lines',true],['baseline-branches',false],
  ]);
  assert.equal(evaluateGates({ ...application, branches: ratio(8499,10000) }, ratio(8999,10000), baseline)[0].passed, false);
  assert.equal(evaluateGates({ ...application, branches: ratio(8499,10000) }, ratio(9,10), baseline)[1].passed, false);
  const noChanges = evaluateGates(baseline, ratio(0,0), baseline);
  assert.ok(noChanges.every(g => g.passed)); assert.equal(noChanges[0].applicable, false);
});
test('no-decline compares full ratios and rejects lowering or weakening the baseline', () => {
  assert.equal(atLeast(baseline.lines, baseline.lines), true);
  assert.equal(atLeast(ratio(9686,10000), baseline.lines), false); // Both display as 96.86%.
  assert.throws(() => validateBaseline({ ...baseline, lines: ratio(9686,10000) }, baseline), /must not be lowered/);
  assert.throws(() => validateBaseline({ ...baseline, branches: ratio(baseline.branches.covered-1,baseline.branches.total) }, baseline), /must not be lowered/);
  for (const patch of [{ minimumBranches:84 },{ minimumChangedLines:89 },{ method:'different' },{ lines:ratio(0,0) },{ branches:ratio(2,1) }]) {
    assert.throws(() => validateBaseline({ ...baseline, ...patch }));
  }
  assert.throws(() => atLeast(ratio(NaN,10), ratio(1,2)));
  assert.throws(() => evaluateGates(baseline, ratio(1,0), baseline));
});
test('changed lines include unstaged, new and renamed sources, but exclude removed and unreportable lines', t => {
  const repo = scratch(t); mkdirSync(join(repo,'src/web'), { recursive:true });
  git(repo,['init','-q']); git(repo,['config','user.email','test@example.invalid']); git(repo,['config','user.name','Coverage test']);
  writeFileSync(join(repo,'src/web/old.ts'),'one\ntwo\nthree\n');
  writeFileSync(join(repo,'src/web/deleted.ts'),'gone\n');
  git(repo,['add','.']); git(repo,['commit','-qm','fixture']); const base = git(repo,['rev-parse','HEAD']).trim();
  assert.equal(comparisonBase(repo,base),base); assert.throws(() => comparisonBase(repo,'missing-ref'));
  writeFileSync(join(repo,'src/web/old.ts'),'one\nchanged\nthree\nadded\n');
  rmSync(join(repo,'src/web/deleted.ts')); writeFileSync(join(repo,'src/web/new file.ts'),'new\n');
  const files = { 'src/web/old.ts':{ lines:{ 1:1,2:1,3:0 } }, 'src/web/new file.ts':{ lines:{ 1:0 } }, 'scripts/tool.mjs':{ lines:{ 1:0 } } };
  assert.deepEqual(changedLineCoverage(repo,base,files), { total:2,covered:1,files:[{ file:'src/web/old.ts',total:1,covered:1 },{ file:'src/web/new file.ts',total:1,covered:0 }] });
  const inputs = manifest(repo); assert.deepEqual(inputs.sources,['src/web/new file.ts','src/web/old.ts']);
  verifyManifest(repo,inputs);
  writeFileSync(join(repo,'src/web/old.ts'),'different\n'); assert.throws(() => verifyManifest(repo,inputs),/Input changed/);
  symlinkSync(join(repo,'src/web/old.ts'),join(repo,'src/web/link.ts'));
  assert.throws(() => sourceFiles(repo), /regular file/);
});

function coverageFile(branches, all = false) {
  const loc = (start,end) => ({ start:{ line:1,column:start },end:{ line:1,column:end } });
  return { path:'/source.ts', ...(all ? { all:true } : {}), statementMap:{ 0:loc(0,20) }, s:{ 0:all?0:1 },
    branchMap:Object.fromEntries(branches.map(([start,end],id) => [id,{ type:'branch',loc:loc(start,end),locations:[loc(start,end)] }])),
    b:Object.fromEntries(branches.map(([, ,hits],id) => [id,[hits]])), fnMap:{}, f:{} };
}
test('exact merge never infers a nested compiler branch hit from an enclosing executed range', () => {
  const first = { '/source.ts':coverageFile([[0,20,2],[3,5,0]]) };
  const second = { '/source.ts':coverageFile([[6,9,0],[3,5,4]]) };
  const merged = mergeExact(first,second)['/source.ts'];
  assert.deepEqual(Object.values(merged.b),[[2],[4],[0]]);
  assert.deepEqual(first['/source.ts'].b,{ 0:[2],1:[0] });
  const cold = { '/source.ts':coverageFile([[0,20,0]],true) };
  assert.deepEqual(mergeExact(cold,second)['/source.ts'].b,{ 0:[0],1:[4] });
  assert.deepEqual(mergeExact(second,cold),mergeExact(second));
});
test('newline normalization keeps source offsets and hit counts', () => {
  const file = coverageFile([[0,1,7]]); const location = { start:{ line:2,column:-1 },end:{ line:2,column:1 } };
  file.branchMap[0].loc = structuredClone(location); file.branchMap[0].locations = [structuredClone(location)];
  const map = { '/source.ts':file }; canonicalizeLocations(map,()=>'a\nb\n');
  assert.deepEqual(file.branchMap[0].locations,[{ start:{ line:1,column:1 },end:{ line:2,column:1 } }]); assert.deepEqual(file.b,{ 0:[7] });
});

function captureFixture(t) {
  const directory = scratch(t), id = 'a'.repeat(64), name = id + '-0-0.json';
  const capture = { schema:'loom-coverage-1',id:id+'-0-0',issues:[],pages:[{ kind:'default',captures:1,closed:true,entries:[
    { asset:'app.js',sha256:'b'.repeat(64),functions:[{ functionName:'',isBlockCoverage:true,ranges:[{ startOffset:0,endOffset:10,count:1 }] }] },
  ] }] };
  const run = { state:'completed',status:'passed',planned:1,ended:1,omitted:0,tests:[{ status:'passed',test:{ id,repeat:0,retry:0 } }] };
  const assets = new Map([['app.js',{ sha256:'b'.repeat(64),length:10 }]]);
  const save = () => writeFileSync(join(directory,name),JSON.stringify(capture)); save();
  return { directory,name,capture,run,assets,save };
}
test('browser capture validation requires every successful test and rejects missing, stale or linked captures', t => {
  const f = captureFixture(t); assert.deepEqual(readCaptures(f.directory,f.run,f.assets),[f.capture]);
  for (const patch of [{ status:'failed' },{ planned:2 },{ omitted:1 },{ tests:[] }]) assert.throws(() => readCaptures(f.directory,{ ...f.run,...patch },f.assets));
  writeFileSync(join(f.directory,'stale.json'),'{}'); assert.throws(() => readCaptures(f.directory,f.run,f.assets),/stale/);
  rmSync(join(f.directory,'stale.json')); rmSync(join(f.directory,f.name)); assert.throws(() => readCaptures(f.directory,f.run,f.assets),/Missing/);
  const target = join(scratch(t),'capture.json'); writeFileSync(target,JSON.stringify(f.capture)); symlinkSync(target,join(f.directory,f.name));
  assert.throws(() => readCaptures(f.directory,f.run,f.assets),/Invalid browser coverage file/);
});
for (const [label,change] of [
  ['open page',c=>{ c.pages[0].closed=false; }], ['no snapshots',c=>{ c.pages[0].captures=0; }],
  ['collector error',c=>{ c.issues.push('missing_script_source'); }], ['unknown metadata',c=>{ c.origin='private'; }],
  ['script mismatch',c=>{ c.pages[0].entries[0].sha256='other'; }], ['unknown bundle',c=>{ c.pages[0].entries[0].asset='other.js'; }],
  ['function names',c=>{ c.pages[0].entries[0].functions[0].functionName='private'; }],
  ['out-of-range offsets',c=>{ c.pages[0].entries[0].functions[0].ranges[0].endOffset=11; }],
  ['invalid hits',c=>{ c.pages[0].entries[0].functions[0].ranges[0].count=-1; }],
]) test('browser capture rejects '+label,t=>{ const f=captureFixture(t); change(f.capture); f.save(); assert.throws(()=>readCaptures(f.directory,f.run,f.assets)); });
test('published coverage has escaped authored source and line/branch-only LCOV', t => {
  const repo=scratch(t),output=join(repo,'report'); mkdirSync(join(repo,'src'));
  writeFileSync(join(repo,'src/example.ts'),'<script>privateMarkup()</script>');
  const summary={ total:1,covered:1,pct:100 },file={ lines:{ 1:2 },branches:[{ loc:{ start:{ line:1,column:0 },end:{ line:1,column:1 } },hits:1 }],summary:{ lines:summary,branches:summary } };
  writeReports(repo,output,{ 'src/example.ts':file },{ groups:{ application:{ files:1,...file.summary } },status:'passed',browser:{ tests:1 },gates:[],limits:[] });
  const html=readFileSync(join(output,'files/src/example.ts.html'),'utf8');
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
  const lcov=readFileSync(join(output,'lcov.info'),'utf8'); assert.ok(lcov.includes('BRDA:1,0,0,1\n')); assert.ok(lcov.includes('DA:1,2\n')); assert.ok(!lcov.includes('FN:'));
});

// A successful report must not silently omit a source when c8 conversion fails.
test('Node coverage fails on a missing source map rather than dropping that file', async t => {
  const repo=scratch(t), raw=join(repo,'raw'); mkdirSync(raw);
  const source=join(repo,'tool.mjs'); writeFileSync(source,'const x = 1;\n//# sourceMappingURL=missing.map\n');
  writeFileSync(join(raw,'coverage.json'),JSON.stringify({ result:[{ scriptId:'1',url:source,functions:[{ functionName:'',isBlockCoverage:true,ranges:[{ startOffset:0,endOffset:12,count:1 }] }] }] }));
  await assert.rejects(()=>nodeCoverage(repo,['tool.mjs'],[raw],join(repo,'normalized'),false),/ENOENT|source map/);
});
test('Node coverage rejects absent TypeScript maps and stale normalization output', async t => {
  const repo=scratch(t), raw=join(repo,'raw'),normalized=join(repo,'normalized'); mkdirSync(raw);
  const source=join(repo,'source.ts'); writeFileSync(source,'const x: number = 1;\n');
  writeFileSync(join(raw,'coverage.json'),JSON.stringify({ result:[{ scriptId:'1',url:source,functions:[{ functionName:'',isBlockCoverage:true,ranges:[{ startOffset:0,endOffset:12,count:1 }] }] }] }));
  await assert.rejects(()=>nodeCoverage(repo,['source.ts'],[raw],normalized,false),/Missing TypeScript source map/);
  await assert.rejects(()=>nodeCoverage(repo,['source.ts'],[raw],normalized,false),/stale coverage/);
});

test('HTTP-only scenarios have a complete empty browser capture, not a missing capture', t => {
  const f=captureFixture(t); f.capture.pages=[]; f.save();
  assert.deepEqual(readCaptures(f.directory,f.run,f.assets),[f.capture]);
  rmSync(join(f.directory,f.name));
  assert.throws(()=>readCaptures(f.directory,f.run,f.assets),/Missing/);
});
