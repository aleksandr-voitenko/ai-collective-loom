import assert from 'node:assert/strict';
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
const require=createRequire(import.meta.url);
const convert=require('v8-to-istanbul');
const {TraceMap,eachMapping}=require('@jridgewell/trace-mapping');
const {mergeScriptCovs}=require('@bcoe/v8-coverage');
const keys = (value, expected) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'Unexpected coverage fields');
};
export function readCaptures(directory, run, assets) {
  assert.equal(run.state, 'completed'); assert.equal(run.status, 'passed');
  assert.ok(run.planned > 0); assert.equal(run.planned, run.ended); assert.equal(run.omitted, 0);
  assert.equal(run.tests.length, run.ended);
  assert.ok(run.tests.every(test => test.status === 'passed'));
  const expected = run.tests.map(({test}) => `${test.id}-${test.repeat}-${test.retry}.json`).sort();
  assert.deepEqual(readdirSync(directory).sort(), expected, 'Missing, duplicated or stale browser test coverage');
  const captures = [];
  for (const name of expected) {
    const path = join(directory, name), stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32 * 1024 * 1024, 'Invalid browser coverage file');
    const capture = JSON.parse(readFileSync(path, 'utf8'));
    keys(capture, ['schema','id','issues','pages']); assert.equal(capture.schema, 'loom-coverage-1');
    assert.equal(name, capture.id + '.json'); assert.deepEqual(capture.issues, []);
    assert.ok(Array.isArray(capture.pages) && capture.pages.length <= 16);
    for (const page of capture.pages) {
      keys(page, ['kind','captures','closed','entries']);
      assert.ok(['default','persistent','explicit'].includes(page.kind)); assert.equal(page.closed, true);
      assert.ok(Number.isSafeInteger(page.captures) && page.captures > 0);
      assert.ok(Array.isArray(page.entries));
      for (const entry of page.entries) {
        keys(entry, ['asset','sha256','functions']); const asset = assets.get(entry.asset);
        assert.ok(asset, 'Unknown browser asset'); assert.equal(entry.sha256, asset.sha256);
        assert.ok(Array.isArray(entry.functions));
        for (const fn of entry.functions) {
          keys(fn, ['functionName','isBlockCoverage','ranges']); assert.equal(fn.functionName, '');
          assert.equal(typeof fn.isBlockCoverage, 'boolean'); assert.ok(Array.isArray(fn.ranges) && fn.ranges.length);
          for (const range of fn.ranges) {
            keys(range, ['startOffset','endOffset','count']);
            assert.ok(Object.values(range).every(n => Number.isSafeInteger(n) && n >= 0));
            assert.ok(range.startOffset <= range.endOffset && range.endOffset <= asset.length);
          }
        }
      }
    }
    captures.push(capture);
  }
  return captures;
}
export async function remap(assetPath, entries) {
  const source=readFileSync(assetPath,'utf8'),digest=createHash('sha256').update(source).digest('hex');
  const sourceMap=JSON.parse(readFileSync(assetPath+'.map','utf8'));
  for(const entry of entries)assert.equal(entry.sha256,digest);
  const mappedLines=new Map();
  eachMapping(new TraceMap(sourceMap),mapping=>{
    if(mapping.source===null||mapping.originalLine===null)return;
    const path=resolve(dirname(assetPath),mapping.source);
    const lines=mappedLines.get(path)??new Set();lines.add(mapping.originalLine);mappedLines.set(path,lines);
  });
  const converter=convert(assetPath,0,{source,sourceMap:{sourcemap:sourceMap}});
  await converter.load();
  const merged=mergeScriptCovs(entries.map((entry,index)=>({scriptId:String(index),url:assetPath,functions:entry.functions})));
  assert.ok(merged);converter.applyCoverage(merged.functions);
  const files=converter.toIstanbul();
  // v8-to-istanbul initializes all original-source lines as covered, including
  // code removed by bundling. Only generated mappings provide browser evidence.
  for(const [path,file]of Object.entries(files)){
    const lines=mappedLines.get(path)??new Set();
    for(const [id,statement]of Object.entries(file.statementMap)){
      if(!lines.has(statement.start.line)){delete file.statementMap[id];delete file.s[id];}
    }
  }
  return {files,sourceMap,mappedLines};
}
