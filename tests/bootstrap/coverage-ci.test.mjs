import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { partition, createPlan, planDigest, requireJobs, validateEvidence, readGroups, verifyPlan } from '../../scripts/lib/coverage/ci-plan.mjs';
import { readEvidence, writeEvidence, validateNode, importNode, encodeFunctions, decodeFunctions } from '../../scripts/lib/coverage/portable.mjs';
import { digest } from '../../scripts/lib/coverage/inputs.mjs';
import { metadata } from '../../scripts/lib/browser-diagnostics.mjs';

function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), 'loom-ci-contract-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, 'scripts')); writeFileSync(join(repo, 'scripts/example.mjs'), 'export const answer = 42;\n');
  const browser = { schema: 'loom-browser-plan-1', metadata: metadata(), tests: ['files','notes','reading','references'].map((name,i) =>
    ({ id: String(i).repeat(64), file: name + '.spec.ts', line: 1, column: 1, repeat: 0, retry: 0 })) };
  const plan = { schema: 'loom-ci-plan-1', inputs: { sources: ['scripts/example.mjs'], hashes: { 'scripts/example.mjs': digest(readFileSync(join(repo, 'scripts/example.mjs'))) }, head: 'a'.repeat(40) },
    build: {}, base: 'b'.repeat(40), browser, native: ['test:files:postgres'], groups: [
      { id: 'checks', stages: ['check'] }, { id: 'native-0', stages: ['test:files:postgres'] }, { id: 'browser-0', files: ['files.spec.ts'] }] };
  const node = [{ scripts: [{ script: 0, instance: null, projection: null }], processes: [{ order: [10, 1000, 0], entries: [{ script: 0, functions: [[true, [[0, 24, 2], [7, 12, 0]]]] }] }] }];
  const evidence = group => ({ schema: 'loom-ci-evidence-1', plan: planDigest(plan), group: group.id, stages: group.stages ?? [], node: structuredClone(node),
    browser: group.files ? { run: { schema: 'loom-browser-run-1', metadata: browser.metadata, state: 'completed', status: 'passed',
      planned: 1, ended: 1, omitted: 0, tests: [{ test: browser.tests[0], status: 'passed', duration_ms: 10 }] }, pages: 0, snapshots: 0, ranges: [{test: 0, entries: []}] } : null });
  return { repo, plan, node, evidence };
}

test('partition includes every discovered item once with deterministic bounded groups', () => {
  const items = ['a','b','c','d','new']; const groups = partition(items, item => item === 'a' ? 100 : 1);
  assert.equal(groups.length, 4); assert.deepEqual(groups.flat().sort(), items); assert.deepEqual(groups, partition(items, item => item === 'a' ? 100 : 1));
  assert.throws(() => partition(['only'], () => 1));
});

test('plan discovers new PostgreSQL scripts and complete browser files without a fixed suite allowlist', t => {
  const f = fixture(t); mkdirSync(join(f.repo,'src/web'),{recursive:true}); mkdirSync(join(f.repo,'dist'));
  writeFileSync(join(f.repo,'src/web/main.ts'),'export {};'); writeFileSync(join(f.repo,'dist/main.js'),'export {};');
  const scripts = Object.fromEntries(['app','files','recovery','brand-new','references'].map(name => ['test:'+name+':postgres','node test.mjs']));
  writeFileSync(join(f.repo,'package.json'),JSON.stringify({scripts}));
  for(const args of [['init','-q'],['config','user.email','fixture@example.invalid'],['config','user.name','Fixture'],['add','.'],['commit','-qm','fixture']]) {
    assert.equal(spawnSync('git',args,{cwd:f.repo,encoding:'utf8'}).status,0);
  }
  const plan = createPlan(f.repo,f.plan.browser,'HEAD');
  assert.deepEqual(plan.groups.filter(g=>g.id.startsWith('native')).flatMap(g=>g.stages).sort(),Object.keys(scripts).sort());
  assert.deepEqual(plan.groups.filter(g=>g.files).flatMap(g=>g.files).sort(),f.plan.browser.tests.map(t=>t.file).sort());
  assert.equal(plan.groups.length,9);
});

for (const fault of ['missing','duplicate','foreign','truncated','symlink','unknown-field']) test('complete evidence refuses '+fault, t => {
  const f=fixture(t),directory=join(f.repo,'incoming');mkdirSync(directory);
  writeEvidence(join(directory,'plan.json'),f.plan);
  for(const group of f.plan.groups)writeEvidence(join(directory,group.id+'.json'),f.evidence(group));
  assert.equal(readGroups(f.repo,f.plan,directory,new Map()).length,3);
  if(fault==='missing')rmSync(join(directory,'checks.json'));
  if(fault==='duplicate')writeEvidence(join(directory,'duplicate.json'),f.evidence(f.plan.groups[0]));
  if(fault==='foreign')writeFileSync(join(directory,'raw-profile.json'),'PRIVATE_CANARY');
  if(fault==='truncated')writeFileSync(join(directory,'checks.json'),'{');
  if(fault==='symlink'){rmSync(join(directory,'checks.json'));symlinkSync(join(directory,'native-0.json'),join(directory,'checks.json'));}
  if(fault==='unknown-field'){const value=f.evidence(f.plan.groups[0]);value.secret='PRIVATE_CANARY';writeFileSync(join(directory,'checks.json'),JSON.stringify(value));}
  assert.throws(()=>readGroups(f.repo,f.plan,directory,new Map()));
});
for(const fault of ['plan','group','stages','source','counter','range','projection','failed','omitted','test','duplicate-test','metadata','missing-measurement','duplicate-measurement','missing-node-stage'])test('group validation refuses '+fault,t=>{
  const f=fixture(t),group=f.plan.groups[2],value=f.evidence(group);
  if(fault==='plan')value.plan='c'.repeat(64);
  if(fault==='group')value.group='browser-1';
  if(fault==='stages')value.stages=['check'];
  if(fault==='source')value.node[0].scripts[0].script=900;
  if(fault==='counter')value.node[0].processes[0].entries[0].functions[0][1][0][2]=Infinity;
  if(fault==='range')value.node[0].processes[0].entries[0].functions[0][1][1]=[20,25,1];
  if(fault==='projection')value.node[0].scripts[0].projection={identity:'a'.repeat(64),sources:[0],lengths:[24],mappings:[[[0,0,999,0]]]};
  if(fault==='failed')value.browser.run.tests[0].status='failed';
  if(fault==='omitted')value.browser.run.omitted=1;
  if(fault==='test')value.browser.run.tests[0].test=f.plan.browser.tests[1];
  if(fault==='duplicate-test')value.browser.run.tests.push(value.browser.run.tests[0]);
  if(fault==='missing-measurement')value.browser.ranges=[];
  if(fault==='duplicate-measurement')value.browser.ranges.push(value.browser.ranges[0]);
  if(fault==='missing-node-stage')value.node=[];
  if(fault==='metadata')value.browser.run.metadata={...value.browser.run.metadata,attempt:99};
  assert.throws(()=>validateEvidence(f.repo,f.plan,group,value,new Map()));
});
test('numeric projections reject names, paths, excessive bytes and inconsistent mappings',t=>{
  const f=fixture(t),node=structuredClone(f.node);
  node[0].scripts[0].projection={identity:'a'.repeat(64),sources:[0],lengths:[24],mappings:[[[0,0,0,0]]]};
  validateNode(f.repo,f.plan,node);
  for(const patch of [{names:['SECRET_CANARY']},{source:'SECRET_CANARY'},{sources:['/private/SECRET_CANARY']},{mappings:[[[0,0,0,0,'SECRET_CANARY']]]}]){
    const changed=structuredClone(node);Object.assign(changed[0].scripts[0].projection,patch);assert.throws(()=>validateNode(f.repo,f.plan,changed));
  }
  const changed=structuredClone(node);changed[0].scripts[0].projection.mappings[0][0][3]=1;
  assert.throws(()=>importNode(f.repo,f.plan,[node,changed],join(f.repo,'import')),/Inconsistent/);
  const path=join(f.repo,'oversize.json');writeFileSync(path,' '.repeat(100));assert.throws(()=>readEvidence(path,99));
});
test('function export removes names and preserves only validated numeric range trees',()=>{
  const encoded=encodeFunctions([{functionName:'SECRET_CANARY',isBlockCoverage:true,ranges:[{startOffset:0,endOffset:20,count:1}]}]);
  assert.equal(JSON.stringify(encoded).includes('SECRET'),false);
  assert.deepEqual(decodeFunctions(encoded,20),[{functionName:'',isBlockCoverage:true,ranges:[{startOffset:0,endOffset:20,count:1}]}]);
  for(const changed of [[],[[true,[[0,21,1]]]],[[true,[[0,20,-1]]]],[[true,[[0,20,1],[2,10,1],[5,15,1]]]],[[true,[]]],[[true,[[0,20,1]],'canary']]])assert.throws(()=>decodeFunctions(changed,20));
});
test('required final gate rejects failed, cancelled, skipped, missing and foreign dependencies',()=>{
  const success={checks:'success',native:'success',browser:'success',storage:'success'};requireJobs(success);
  for(const name of Object.keys(success))for(const status of ['failure','cancelled','skipped',''])assert.throws(()=>requireJobs({...success,[name]:status}));
  const missing={...success};delete missing.storage;assert.throws(()=>requireJobs(missing));assert.throws(()=>requireJobs({...success,other:'success'}));
});

for (const fault of ['commit','base','attempt','run','runtime','source','build','inventory','groups','private-field']) test('execution plan rejects changed '+fault,t=>{
  const f=fixture(t),changed=structuredClone(f.plan); verifyPlan(f.plan,changed);
  if(fault==='commit')changed.inputs.head='c'.repeat(40);
  if(fault==='base')changed.base='d'.repeat(40);
  if(fault==='attempt')changed.browser.metadata.attempt++;
  if(fault==='run')changed.browser.metadata.run='987654';
  if(fault==='runtime')changed.browser.metadata.node='24.0.0';
  if(fault==='source')changed.inputs.hashes['scripts/example.mjs']='e'.repeat(64);
  if(fault==='build')changed.build['dist/extra.js']='f'.repeat(64);
  if(fault==='inventory')changed.browser.tests.pop();
  if(fault==='groups')changed.groups[1].stages=[];
  if(fault==='private-field')changed.browser.metadata.job='SECRET_CANARY';
  assert.throws(()=>verifyPlan(changed,f.plan));
});

test('Vite config injection mappings retain bounded virtual columns only for the config compiler',t=>{
  const f=fixture(t);writeFileSync(join(f.repo,'vite.config.ts'),'export {};');f.plan.inputs.sources.push('vite.config.ts');
  const projection={identity:'a'.repeat(64),sources:[1],lengths:[50],mappings:[[[0,0,0,40]]]};
  const record={scripts:[{script:2,instance:'b'.repeat(64),projection}],processes:[{order:[1,1,0],entries:[{script:0,functions:[[true,[[0,50,1]]]]}]}]};
  validateNode(f.repo,f.plan,[record]);
  const authored=structuredClone(record);Object.assign(authored.scripts[0],{script:1,instance:null});assert.throws(()=>validateNode(f.repo,f.plan,[authored]));
  const outside=structuredClone(record);outside.scripts[0].projection.mappings[0][0][3]=100;
  assert.throws(()=>validateNode(f.repo,f.plan,[outside]));
  const wrongSource=structuredClone(record);wrongSource.scripts[0].projection.sources=[0];
  assert.throws(()=>validateNode(f.repo,f.plan,[wrongSource]));
});

test('numeric transport preserves process boundaries and c8 order instead of premerging shards', async t => {
  const f=fixture(t),raw=join(f.repo,'raw');mkdirSync(raw);
  // c8's incremental merge can promote function-level coverage to block-level.
  // Group-local premerging these samples would drop the count of two.
  for(const [pid,block,count] of [[2,false,1],[10,false,1],[3,true,0]])writeEvidence(join(raw,`coverage-${pid}-1000-0.json`),{
    result:[{scriptId:'0',url:new URL('file://'+join(f.repo,'scripts/example.mjs')).href,
      functions:[{functionName:'PRIVATE_CANARY',isBlockCoverage:block,ranges:[{startOffset:0,endOffset:24,count}]}]}]});
  const {exportNode}=await import('../../scripts/lib/coverage/portable.mjs');
  const {nodeCoverage}=await import('../../scripts/lib/coverage/inputs.mjs');
  const exported=await exportNode(f.repo,f.plan,[raw],join(f.repo,'export-normalized'));
  assert.equal(exported[0].processes.length,3);assert.equal(JSON.stringify(exported).includes('PRIVATE_CANARY'),false);
  const directories=importNode(f.repo,f.plan,[exported],join(f.repo,'import'));
  const actual=await nodeCoverage(f.repo,f.plan.inputs.sources,directories,join(f.repo,'actual'),false);
  const expected=await nodeCoverage(f.repo,f.plan.inputs.sources,[raw],join(f.repo,'expected'),false);
  const measured=map=>Object.fromEntries(Object.entries(map).map(([path,file])=>[path,{statementMap:file.statementMap,s:file.s,branchMap:file.branchMap,b:file.b}]));
  assert.deepEqual(measured(actual),measured(expected));
  assert.ok(Object.values(actual[join(f.repo,'scripts/example.mjs')].b).flat().includes(2));
  const split=structuredClone(exported);split[0].processes.reverse();
  const reordered=importNode(f.repo,f.plan,[split],join(f.repo,'reordered'));
  assert.deepEqual(measured(await nodeCoverage(f.repo,f.plan.inputs.sources,reordered,join(f.repo,'reordered-normalized'),false)),measured(expected));
  for(const fault of ['empty','duplicate','unknown-script','foreign-order','unused']){
    const changed=structuredClone(exported);
    if(fault==='empty')changed[0].processes=[];
    if(fault==='duplicate')changed[0].processes.push(changed[0].processes[0]);
    if(fault==='unknown-script')changed[0].processes[0].entries[0].script=999;
    if(fault==='foreign-order')changed[0].processes[0].order[0]='PRIVATE_CANARY';
    if(fault==='unused')changed[0].scripts.push({...changed[0].scripts[0],instance:'x'});
    assert.throws(()=>validateNode(f.repo,f.plan,changed));
  }
});

test('report CLI refuses failed dependencies and removes stale passing reports without disclosure',t=>{
  const root=mkdtempSync(join(tmpdir(),'loom-ci-report-failure-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  cpSync(new URL('../../scripts',import.meta.url),join(root,'scripts'),{recursive:true});
  for(const name of ['package.json','.nvmrc'])cpSync(new URL('../../'+name,import.meta.url),join(root,name));
  symlinkSync(new URL('../../node_modules',import.meta.url).pathname,join(root,'node_modules'),'dir');
  const approved=join(root,'coverage/approved');mkdirSync(approved,{recursive:true});
  for(const status of ['failure','cancelled','skipped']){
    writeFileSync(join(approved,'index.html'),'PRIVATE_CANARY');
    const output=join(root,'github-output');writeFileSync(output,'');
    const environment={...process.env,GITHUB_OUTPUT:output,LOOM_CI_RESULTS:JSON.stringify({checks:'success',native:status,browser:'success',storage:'success'})};
    delete environment.NODE_V8_COVERAGE;delete environment.LOOM_COVERAGE_OUTPUT;
    const result=spawnSync(process.execPath,['scripts/coverage-ci.mjs','report'],{cwd:root,env:environment,encoding:'utf8',timeout:30_000});
    assert.equal(result.status,1);assert.equal(result.stdout.includes('PRIVATE_CANARY')||result.stderr.includes('PRIVATE_CANARY'),false);
    assert.deepEqual(JSON.parse(readFileSync(join(approved,'status.json'))),{schema:'loom-coverage-status-1',status:'incomplete',phase:'jobs'});
    assert.throws(()=>readFileSync(join(approved,'index.html')));assert.equal(readFileSync(output,'utf8'),'ready=true\n');
  }
  rmSync(join(root,'coverage'),{recursive:true});
  const protectedRoot=join(root,'protected');mkdirSync(join(protectedRoot,'approved'),{recursive:true});
  writeFileSync(join(protectedRoot,'approved/index.html'),'PRIVATE_CANARY');symlinkSync(protectedRoot,join(root,'coverage'),'dir');
  const environment={...process.env,GITHUB_OUTPUT:join(root,'guard-output'),LOOM_CI_RESULTS:'{}'};delete environment.NODE_V8_COVERAGE;delete environment.LOOM_COVERAGE_OUTPUT;
  const guarded=spawnSync(process.execPath,['scripts/coverage-ci.mjs','report'],{cwd:root,env:environment,encoding:'utf8',timeout:30_000});
  assert.equal(guarded.status,1);assert.equal(readFileSync(join(protectedRoot,'approved/index.html'),'utf8'),'PRIVATE_CANARY');
  assert.throws(()=>readFileSync(environment.GITHUB_OUTPUT));
});
