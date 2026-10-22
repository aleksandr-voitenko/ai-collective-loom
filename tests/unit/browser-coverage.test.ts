import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, TestInfo } from '@playwright/test';
import { BrowserCoverage } from '../helpers/browser-coverage.js';

function fixture(t: TestContext) {
  const root=mkdtempSync(join(tmpdir(),'loom-coverage-source-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source="globalThis.answer = 'café — Māori 😀';\n";
  writeFileSync(join(root,'fixture.js'),source);
  const context=new EventEmitter() as EventEmitter & Record<string,any>;
  const page=new EventEmitter() as EventEmitter & Record<string,any>;
  const cdp=new EventEmitter() as EventEmitter & Record<string,any>;
  let closed=false;
  const functions=[{functionName:'private-name',isBlockCoverage:true,ranges:[{startOffset:0,endOffset:source.length,count:2}]}];
  cdp.send=async(name:string)=>{
    // Navigation can retire the source before this asynchronous request arrives.
    if(name==='Debugger.getScriptSource')throw new Error('No script for id');
    if(name==='Profiler.takePreciseCoverage')return {result:[{scriptId:'1',url:'https://fixture.invalid/assets/fixture.js',functions}]};
    return {};
  };
  cdp.detach=async()=>{};
  context.newCDPSession=async()=>cdp; context.pages=()=>closed?[]:[page]; context.newPage=async()=>page;
  context.close=async()=>{closed=true;page.emit('close');};
  page.context=()=>context; page.isClosed=()=>closed; page.close=context.close;
  for(const name of ['goto','reload','goBack','goForward'])page[name]=async()=>null;
  const id=createHash('sha256').update('source-identity').digest('hex')+'-0-0';
  const collector=new BrowserCoverage({testId:'source-identity',repeatEachIndex:0,retry:0} as TestInfo,{assetsRoot:root,output:root});
  const tracked=collector.track(context as unknown as BrowserContext);
  const event={scriptId:'1',url:'https://fixture.invalid/assets/fixture.js',hash:createHash('sha256').update(source).digest('hex'),length:source.length,startLine:0,startColumn:0};
  return {collector,tracked,cdp,event,functions,read:()=>JSON.parse(readFileSync(join(root,id+'.json'),'utf8'))};
}

test('browser counters retain exact source identity when navigation retires retrievable script text',async t=>{
  const f=fixture(t);await f.tracked.newPage();f.cdp.emit('Debugger.scriptParsed',f.event);
  await f.tracked.close();await f.collector.finish();
  const result=f.read();assert.deepEqual(result.issues,[]);
  assert.deepEqual(result.pages[0].entries,[{asset:'fixture.js',sha256:f.event.hash,functions:f.functions.map(fn=>({...fn,functionName:''}))}]);
});

for(const [name,patch] of Object.entries({
  'missing hash':{hash:undefined},'changed bytes':{hash:'0'.repeat(64)},
  'missing length':{length:undefined},'changed length':{length:1},
  'shifted line':{startLine:1},'shifted column':{startColumn:1},
}))test(`browser coverage refuses ${name} even under a known asset URL`,async t=>{
  const f=fixture(t);await f.tracked.newPage();f.cdp.emit('Debugger.scriptParsed',{...f.event,...patch});
  await f.tracked.close();await assert.rejects(()=>f.collector.finish(),/Every page/);
  assert.ok(f.read().issues.length);assert.deepEqual(f.read().pages[0].entries,[]);
});

test('browser coverage refuses counters without a verified parsed script identity',async t=>{
  const f=fixture(t);await f.tracked.newPage();await f.tracked.close();
  await assert.rejects(()=>f.collector.finish(),/Every page/);assert.deepEqual(f.read().pages[0].entries,[]);
});
