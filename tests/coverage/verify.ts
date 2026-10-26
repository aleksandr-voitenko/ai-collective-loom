import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { chromium, type BrowserContext, type TestInfo } from '@playwright/test';
import { build } from 'vite';
import { BrowserCoverage } from '../helpers/browser-coverage.js';
import { remap, readCaptures } from '../../scripts/lib/coverage/browser.mjs';
import { mergeExact, canonicalizeLocations } from '../../scripts/lib/coverage/merge.mjs';
import { exportNode, importNode, compactBrowser, expandBrowser } from '../../scripts/lib/coverage/portable.mjs';
import { nodeCoverage, digest } from '../../scripts/lib/coverage/inputs.mjs';

const require = createRequire(import.meta.url);
const { createCoverageMap } = require('istanbul-lib-coverage');
const repo = process.cwd();
mkdirSync('coverage', { recursive:true });
const root = mkdtempSync(resolve('coverage/probe-')), captures = join(root,'captures');
mkdirSync(join(root,'src')); mkdirSync(captures);
const fixture = join(root,'src/fixture.ts');
writeFileSync(fixture, `export function choose(flag: boolean): string {
  if (flag) {
    return 'yes';
  } else {
    return 'no';
  }
}
export function unused(): string {
  return 'uncalled';
}
export function treeShaken(): string {
  return 'removed';
}
`);
writeFileSync(join(root,'src/main.ts'), `import {choose,unused} from './fixture';
(globalThis as any).answer=choose(false);
(globalThis as any).uncalled=unused;
`);
writeFileSync(join(root,'src/index.html'),'<script type="module" src="./main.ts"></script>');
writeFileSync(join(root,'run-node.ts'),"import assert from 'node:assert/strict'; import {choose} from './src/fixture.js'; assert.equal(choose(true),'yes');");
const info = { testId:'coverage-measurement-probe',repeatEachIndex:0,retry:0 } as TestInfo;
let server: ReturnType<typeof createServer> | undefined;
try {
  // Native suites and Playwright fixture hosts import the same application files.
  // Their generated coordinates must agree before any V8 counters can be merged.
  const sharedSource='src/server/modules/participation/file-storage.ts';
  const sharedImport=`import { FileStorage } from ${JSON.stringify(pathToFileURL(join(repo,sharedSource)).href)};`;
  const nativeHost=spawnSync(process.execPath,['--enable-source-maps','--import','tsx','--input-type=module','-e',sharedImport],{
    cwd:repo,env:{...process.env,NODE_V8_COVERAGE:join(root,'native-host-raw')},encoding:'utf8',timeout:30_000,
  });
  assert.equal(nativeHost.status,0,'Native application import must execute');
  writeFileSync(join(root,'host.spec.ts'),`${sharedImport}\nimport { test, expect } from '@playwright/test';\ntest('application import',()=>expect(typeof FileStorage).toBe('function'));\n`);
  writeFileSync(join(root,'playwright.config.ts'),`import config from ${JSON.stringify(pathToFileURL(join(repo,'playwright.config.ts')).href)};\nexport default {...config,testDir:'.',testMatch:'host.spec.ts',reporter:'list'};\n`);
  const browserHost=spawnSync(process.execPath,['--enable-source-maps','--import','tsx','node_modules/@playwright/test/cli.js','test','--config',join(root,'playwright.config.ts'),'--list'],{
    cwd:repo,env:{...process.env,NODE_V8_COVERAGE:join(root,'browser-host-raw')},encoding:'utf8',timeout:30_000,
  });
  assert.equal(browserHost.status,0,'Playwright application import must execute');
  await nodeCoverage(repo,[sharedSource],[join(root,'native-host-raw'),join(root,'browser-host-raw')],join(root,'host-normalized'),false);
  const node = spawnSync(process.execPath,['--enable-source-maps','--import','tsx',join(root,'run-node.ts')],{
    cwd:repo,env:{ ...process.env,NODE_V8_COVERAGE:join(root,'node-raw') },encoding:'utf8',timeout:30_000,
  });
  assert.equal(node.status,0,'Node coverage probe must execute successfully');
  await build({ configFile:false,root:join(root,'src'),build:{ outDir:join(root,'dist/web'),sourcemap:'hidden' },logLevel:'error' });
  const assetsRoot = join(root,'dist/web/assets');
  const assets = new Map(readdirSync(assetsRoot).filter(n=>n.endsWith('.js')).map(name=> {
    const source = readFileSync(join(assetsRoot,name),'utf8'); return [name,{ sha256:digest(source),length:source.length }];
  }));
  const responses = new Map([['/',readFileSync(join(root,'dist/web/index.html'))],...Array.from(assets.keys(),name=>['/assets/'+name,readFileSync(join(assetsRoot,name))] as const)]);
  server=createServer((request,response)=>{
    const path=new URL(request.url!,'http://probe.invalid').pathname,body=responses.get(path);
    response.setHeader('content-type',path.endsWith('.js')?'application/javascript; charset=utf-8':'text/html; charset=utf-8');
    response.statusCode=body?200:404; response.end(body);
  });
  await new Promise<void>(done=>server!.listen(0,'127.0.0.1',done));
  const address=server.address(); assert.ok(address && typeof address!=='string');
  const origin='http://127.0.0.1:'+address.port;
  const collector=new BrowserCoverage(info,{ output:captures,assetsRoot });
  const browser=await chromium.launch();
  try {
    // Exercise the pinned browser's parsed-source hash encoding and reject a
    // same-URL, same-length substitution. Unicode must bind to the same build.
    const identityAssets=join(root,'identity-assets');mkdirSync(identityAssets);
    const identitySource="globalThis.identityAnswer = 'café — Māori 😀';\n";
    writeFileSync(join(identityAssets,'identity.js'),identitySource);
    responses.set('/identity.html',Buffer.from('<script src="/assets/identity.js"></script>'));
    for(const changed of [false,true]){
      const output=join(root,'identity-'+changed);mkdirSync(output);
      responses.set('/assets/identity.js',Buffer.from(changed?identitySource.replace('café','cafe'):identitySource));
      const identity=new BrowserCoverage({...info,testId:'identity-'+changed},{output,assetsRoot:identityAssets});
      const context=identity.track(await browser.newContext()),page=await context.newPage();
      try{
        await page.goto(origin+'/identity.html');
        assert.equal(await page.evaluate(()=>(globalThis as any).identityAnswer),changed?'cafe — Māori 😀':'café — Māori 😀');
        if(!changed){await page.reload();await page.goto(origin+'/identity.html');}
      }finally{await context.close();}
      if(changed)await assert.rejects(()=>identity.finish(),/Every page/);
      else{
        await identity.finish();
        const result=JSON.parse(readFileSync(join(output,digest('identity-false')+'-0-0.json'),'utf8'));
        assert.deepEqual(result.issues,[]);
        assert.equal(result.pages[0].entries.length,3,'Each navigation must retain its executed counters');
        assert.ok(result.pages[0].entries.every((entry:any)=>entry.functions.some((fn:any)=>fn.ranges.some((range:any)=>range.count>0))));
      }
    }
    const context=collector.track(await browser.newContext(),'default');
    const page=await context.newPage();
    await page.goto(origin+'/?coverage-query-canary');
    await page.evaluate(()=>{ localStorage.setItem('coverage-storage-canary','private'); (globalThis as any).coverageAnonymousCanary='private'; });
    assert.equal(await page.evaluate(()=>(globalThis as any).answer),'no');
    await page.reload(); assert.equal(await page.evaluate(()=>(globalThis as any).answer),'no');
    const sibling=await context.newPage(); await sibling.goto(origin);
    await page.close(); await context.close();
    const explicit=collector.track(await browser.newContext(),'explicit'),native=await explicit.newPage();
    await native.goto(origin); await collector.captureBeforeClose(native);
    const session=await browser.newBrowserCDPSession();
    const disconnected=new Promise<void>(done=>browser.once('disconnected',()=>done()));
    await session.send('Browser.close'); await disconnected;
  } finally { await browser.close(); }
  const persistent=collector.track(await chromium.launchPersistentContext(join(root,'profile')),'persistent');
  try { const page=await persistent.newPage(); await page.goto(origin); } finally { await persistent.close(); }
  await collector.finish();
  const id=digest(info.testId);
  const run={ state:'completed',status:'passed',planned:1,ended:1,omitted:0,tests:[{ status:'passed',test:{ id,repeat:0,retry:0 } }] };
  const collected=readCaptures(captures,run,assets),entries=collected.flatMap(c=>c.pages.flatMap((p: { entries:any[] })=>p.entries));
  assert.ok(entries.length>=5,'Reload, siblings, persistent and native closure must retain their counters');
  const serialized=JSON.stringify(collected);
  for(const forbidden of [origin,'coverage-query-canary','coverage-storage-canary','coverageAnonymousCanary','private','choose','scriptSource']) assert.ok(!serialized.includes(forbidden),'Coverage must contain only verified asset identities and numeric counters');
  const ts = require('typescript');
  const compiled = ts.transpileModule(readFileSync(fixture,'utf8'), { fileName:'fixture.ts',compilerOptions:{ module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,sourceMap:true,inlineSources:true } });
  mkdirSync(join(root,'dist/server'),{ recursive:true });
  const sourceMap=JSON.parse(compiled.sourceMapText); sourceMap.sources=['../../src/fixture.ts'];
  writeFileSync(join(root,'dist/server/fixture.js'),compiled.outputText);
  writeFileSync(join(root,'dist/server/fixture.js.map'),JSON.stringify(sourceMap));
  const compiledNode=spawnSync(process.execPath,['--enable-source-maps','--input-type=module','-e',`import {choose} from '${join(root,'dist/server/fixture.js')}'; if(choose(true)!=='yes') throw Error();`],{ cwd:repo,env:{ ...process.env,NODE_V8_COVERAGE:join(root,'compiled-raw') },encoding:'utf8',timeout:30_000 });
  assert.equal(compiledNode.status,0,'Compiled Node probe must execute successfully');
  process.chdir(root);
  const directMap=await nodeCoverage(root,['src/fixture.ts'],[join(root,'node-raw')],join(root,'normalized-direct'),true);
  const compiledMap=await nodeCoverage(root,['src/fixture.ts'],[join(root,'compiled-raw')],join(root,'normalized-compiled'),false);
  const nodeMap=await nodeCoverage(root,['src/fixture.ts'],[join(root,'node-raw'),join(root,'compiled-raw')],join(root,'normalized'),true);
  for(const map of [directMap,compiledMap,nodeMap]) canonicalizeLocations(map,(path:string)=>readFileSync(path,'utf8'));
  const branches=(map:any)=>Object.entries(map[fixture].branchMap).map(([id,branch]:[string,any])=>({ key:JSON.stringify([branch.type,branch.locations]),hits:map[fixture].b[id] })).sort((a,b)=>a.key.localeCompare(b.key));
  assert.deepEqual(branches(nodeMap),branches(mergeExact(directMap,compiledMap)),'Node variants must not inherit enclosing branch hits');
  // A distributed round trip must preserve the merged V8 range population,
  // including different compiler coordinates, before source remapping.
  const portablePlan = { inputs: { sources: ['src/fixture.ts'], hashes: { 'src/fixture.ts': digest(readFileSync(fixture)) } },
    build: { 'dist/server/fixture.js': digest(readFileSync(join(root,'dist/server/fixture.js'))) } };
  const portable = await Promise.all(['node-raw','compiled-raw'].map((name,index) => exportNode(root, portablePlan,
    [join(root,name)], join(root,'portable-export-'+index))));
  const imported = importNode(root,portablePlan,portable,join(root,'portable-import'));
  const transported = await nodeCoverage(root,['src/fixture.ts'],imported,join(root,'portable-normalized'),true);
  assert.deepEqual(branches(transported),branches(nodeMap),'Portable compiler ranges must match sequential normalization');
  assert.deepEqual(createCoverageMap(transported).fileCoverageFor(fixture).getLineCoverage(),createCoverageMap(nodeMap).fileCoverageFor(fixture).getLineCoverage());
  for(const forbidden of ['choose','uncalled','sourceContent','file:','http:','fixture.ts']) assert.ok(!JSON.stringify(portable).includes(forbidden),'Portable counters contain no authored/runtime text');
  const browserMaps=[];
  for(const asset of assets.keys()) {
    const { files }=await remap(join(assetsRoot,asset),entries.filter(e=>e.asset===asset));
    const split = [entries.filter((_,i)=>i%2===0), entries.filter((_,i)=>i%2===1)]
      .flatMap(group => expandBrowser(compactBrowser(group,assets),assets));
    const roundtrip = await remap(join(assetsRoot,asset),split.filter(e=>e.asset===asset));
    assert.ok(roundtrip.files[fixture] && files[fixture]);
    assert.deepEqual(roundtrip.files[fixture].b, files[fixture].b, 'Browser groups merge before source mapping');
    assert.deepEqual(roundtrip.files[fixture].s, files[fixture].s);
    browserMaps.push({ [fixture]:files[fixture] });
  }
  const browserMap=mergeExact(...browserMaps);
  for(const map of [nodeMap,browserMap]) canonicalizeLocations(map,(path:string)=>readFileSync(path,'utf8'));
  const nodeFile=createCoverageMap(nodeMap).fileCoverageFor(fixture),browserFile=createCoverageMap(browserMap).fileCoverageFor(fixture);
  assert.equal(nodeFile.getLineCoverage()[5],0); assert.ok(browserFile.getLineCoverage()[5]>0);
  assert.equal(browserFile.getLineCoverage()[9],0,'Exposed but uncalled browser function stays uncovered');
  assert.equal(browserFile.getLineCoverage()[12],undefined,'Tree-shaken code supplies no browser execution evidence');
  const combined=createCoverageMap(mergeExact(nodeMap,browserMap));
  const lines=combined.fileCoverageFor(fixture).getLineCoverage();
  assert.ok(lines[3]>0&&lines[5]>0); assert.equal(lines[9],0); assert.equal(lines[12],0);
  assert.ok(combined.getCoverageSummary().branches.covered>createCoverageMap(nodeMap).getCoverageSummary().branches.covered);

  // A measurement failure must not prevent the original owner closing resources.
  const fakeContext=new EventEmitter() as EventEmitter & Record<string,any>;
  const fakePage=new EventEmitter() as EventEmitter & Record<string,any>;
  const cdp=new EventEmitter() as EventEmitter & Record<string,any>;
  let pageClosed=false,contextClosed=false;
  cdp.send=async(name:string)=>{ if(name==='Profiler.takePreciseCoverage') throw new Error('synthetic capture failure'); return {}; }; cdp.detach=async()=>{};
  fakeContext.newCDPSession=async()=>cdp; fakeContext.pages=()=>pageClosed?[]:[fakePage]; fakeContext.newPage=async()=>fakePage;
  fakeContext.close=async()=>{ contextClosed=true; pageClosed=true; fakePage.emit('close'); };
  fakePage.context=()=>fakeContext; fakePage.isClosed=()=>pageClosed;
  fakePage.close=async()=>{ pageClosed=true; fakePage.emit('close'); };
  for(const name of ['goto','reload','goBack','goForward']) fakePage[name]=async()=>null;
  const broken=new BrowserCoverage({ ...info,testId:'coverage-failed-capture' },{ output:captures,assetsRoot });
  const tracked=broken.track(fakeContext as unknown as BrowserContext); await tracked.newPage(); await fakePage.close(); await tracked.close();
  assert.ok(pageClosed&&contextClosed); await assert.rejects(()=>broken.finish(),/Every page/);
  console.log('Coverage probes passed: real Node/Chromium union, branches, cold code, Unicode source identity, changed-source refusal, all closure paths, numeric-only capture, safe disposal.');
} finally {
  process.chdir(repo);
  if(server) await new Promise<void>(done=>server!.close(()=>done()));
  rmSync(root,{ recursive:true,force:true });
}
