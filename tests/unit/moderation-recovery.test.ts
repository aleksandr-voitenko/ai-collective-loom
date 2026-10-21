import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {IntentStore} from '../../src/web/participation-client.js';

test('moderation intent keeps exact transport bytes across aliases, overlap refusals, reload and newer choices',async()=>{
  const storage=new JSDOM('',{url:'https://loom.example'}).window.localStorage;
  const store=new IntentStore('instance','administrator',storage,'https://loom.example');
  const body={target:{kind:'artifact',resource_id:randomUUID().toUpperCase()},suppressed:true,expected_version:1};
  const saved=await store.prepareModeration(body,()=>true),bytes=storage.getItem(store.prefix+saved.key);
  assert.equal(saved.state,'uncertain');assert.equal(saved.body.target&&JSON.stringify(saved.body.target),JSON.stringify(body.target));
  await assert.rejects(store.prepareModeration({...body,target:{...body.target,resource_id:body.target.resource_id.toLowerCase()},suppressed:false},()=>true),/existing moderation command/);
  assert.equal(storage.getItem(store.prefix+saved.key),bytes);
  const restarted=new IntentStore(store.instance,store.participant,storage,store.origin);
  const retry=await restarted.prepareDispatch(restarted.all()[0]!,{suppressed:false});
  assert.deepEqual(retry.body,saved.body);
  await restarted.settle(retry,{state:'committed'});
  const next=await restarted.prepareModeration({...body,suppressed:false,expected_version:2},()=>true);
  assert.notEqual(next.key,saved.key);assert.equal(next.body.suppressed,false);
  assert.equal(new IntentStore(store.instance,'other',storage,store.origin).all().length,0);
});

test('moderation custody fails closed on view departure, missing locks, capacity and failed readback',async t=>{
  const dom=new JSDOM('',{url:'https://loom.example'}),storage=dom.window.localStorage;
  const store=new IntentStore('instance','administrator',storage,'https://loom.example');
  const body=()=>({target:{kind:'comment',resource_id:randomUUID()},suppressed:false,expected_version:1});
  await assert.rejects(store.prepareModeration(body(),()=>false),{name:'AbortError'});
  assert.equal(store.all().length,0);
  const withoutLocks=new IntentStore(store.instance,store.participant,storage,store.origin,undefined);
  // Explicit unsupported lock adapter represents an environment lacking Web Locks.
  Object.defineProperty(withoutLocks,'locks',{value:undefined});
  await assert.rejects(withoutLocks.prepareModeration(body(),()=>true),/Web Locks/);
  const write=dom.window.Storage.prototype.setItem;
  let corrupt=true;t.mock.method(dom.window.Storage.prototype,'setItem',function(this:Storage,key:string,value:string){write.call(this,key,corrupt?'incomplete':value);corrupt=false;});
  await assert.rejects(store.prepareModeration(body(),()=>true),/safely saved|saved|retained/);
  assert.equal(storage.length,0);
  for(let i=0;i<32;i++)await store.prepareModeration(body(),()=>true);
  const before=Object.entries(storage).sort();
  await assert.rejects(store.prepareModeration(body(),()=>true),/full|limit/);
  assert.deepEqual(Object.entries(storage).sort(),before);
});

test('failed moderation settlement readback preserves the exact uncertain command',async t=>{
  const dom=new JSDOM('',{url:'https://loom.example'}),storage=dom.window.localStorage;
  const store=new IntentStore('instance','administrator',storage,'https://loom.example');
  const saved=await store.prepareModeration({target:{kind:'artifact',resource_id:randomUUID()},suppressed:true,expected_version:1},()=>true);
  const before=storage.getItem(store.prefix+saved.key),write=dom.window.Storage.prototype.setItem;
  let corrupt=true;t.mock.method(dom.window.Storage.prototype,'setItem',function(this:Storage,key:string,value:string){write.call(this,key,corrupt?'incomplete':value);corrupt=false;});
  await assert.rejects(store.settle(saved,{state:'committed'}),/could not be saved/);
  assert.equal(storage.getItem(store.prefix+saved.key),before);
  assert.deepEqual(store.all(),[saved]);
});

test('journal rollback preserves the original storage error for existing callers',async t=>{
  const dom=new JSDOM('',{url:'https://loom.example'}),storage=dom.window.localStorage;
  const store=new IntentStore('instance','administrator',storage,'https://loom.example');
  const saved=await store.prepareModeration({target:{kind:'artifact',resource_id:randomUUID()},suppressed:true,expected_version:1},()=>true);
  const before=storage.getItem(store.prefix+saved.key),failure=new DOMException('Original storage diagnostic','QuotaExceededError');
  t.mock.method(dom.window.Storage.prototype,'setItem',()=>{throw failure;});
  await assert.rejects(store.settle(saved,{state:'committed'}),error=>error===failure);
  assert.equal(storage.getItem(store.prefix+saved.key),before);
});
