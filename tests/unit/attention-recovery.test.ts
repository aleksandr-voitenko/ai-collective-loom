import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {attentionLimits} from '../../src/contracts/attention.js';
import {AttentionRecovery, type AttentionCommandView} from '../../src/web/attention-recovery.js';

const dom=new JSDOM('',{url:'https://loom.example/'});
for(const key of ['window','navigator','location','localStorage','Event'] as const)
  Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(navigator,'locks',{value:{request:async(_name:string,work:()=>unknown)=>work()},configurable:true});
afterEach(()=>localStorage.clear());

const command=():AttentionCommandView=>({kind:'mute',body:{target:{kind:'artifact',resource_id:randomUUID()},
  include_descendants:false,muted:true,expected_version:0,idempotency_key:randomUUID()}});
const journal=()=>new AttentionRecovery(randomUUID(),randomUUID());
const contents=()=>Object.entries(localStorage).sort(([a],[b])=>a.localeCompare(b));

for(const corruption of ['unreadable','schema','key','oversized'] as const)
test(`a ${corruption} journal blocks new intent and preserves every stored byte`,async()=>{
  const store=journal(),saved=await store.save(command(),()=>true),key=store.prefix+'intent:'+saved.command.body.idempotency_key;
  const raw=corruption==='unreadable'?'{':corruption==='schema'?JSON.stringify({...saved,version:2}):
    corruption==='key'?JSON.stringify({...saved,command:command()}):'x'.repeat(attentionLimits.requestBytes+1);
  localStorage.setItem(key,raw);localStorage.setItem('loom.reading.unrelated','preserve');
  const before=contents(),expected=corruption==='unreadable'?/unreadable/:corruption==='oversized'?/exceeds/:/incompatible/;
  assert.throws(()=>store.all(),expected);
  await assert.rejects(store.save(command(),()=>true),expected);
  await assert.rejects(store.clear(),expected);
  assert.deepEqual(contents(),before,'failure must not discard or repair unknown command bytes');
});

test('a corrupt sibling owner or instance does not obstruct this owner or get cleared',async()=>{
  const instance=randomUUID(),owner=randomUUID(),store=new AttentionRecovery(instance,owner),otherOwner=new AttentionRecovery(instance,randomUUID());
  const otherInstance=new AttentionRecovery(randomUUID(),owner);
  for(const other of [otherOwner,otherInstance])localStorage.setItem(other.prefix+'intent:'+randomUUID(),'{');
  const before=contents(),saved=await store.save(command(),()=>true);
  assert.deepEqual(store.all(),[saved]);await store.clear();assert.deepEqual(contents(),before);
});

test('reusing an operation key cannot replace the exact saved command',async()=>{
  const store=journal(),saved=await store.save(command(),()=>true),before=contents();
  const replacement={...saved.command,body:{...saved.command.body,muted:false}} as AttentionCommandView;
  await assert.rejects(store.save(replacement,()=>true),/already exists/);
  assert.deepEqual(contents(),before);
});

for(const operation of ['begin','recordConflict','finish'] as const)
test(`${operation} refuses a stale same-key command without changing its recovery`,async()=>{
  const store=journal(),saved=await store.save(command(),()=>true),before=contents();
  const altered={...saved,command:{...saved.command,body:{...saved.command.body,expected_version:1}} as AttentionCommandView};
  await assert.rejects(store[operation](altered),/intent changed/);
  assert.deepEqual(contents(),before);
});

test('resolved-only dismissal cannot discard uncertainty; late settlement leaves siblings intact',async()=>{
  const store=journal(),saved=await store.save(command(),()=>true),sibling=await store.save(command(),()=>true),before=contents();
  await assert.rejects(store.finish(saved,true),/intent changed/);assert.deepEqual(contents(),before);
  await store.recordConflict(saved);await assert.rejects(store.begin(saved),/intent changed/);
  await store.finish(saved,true);const after=contents();
  await store.finish(saved);await store.recordConflict(saved);
  await assert.rejects(store.begin(saved),/intent changed/);
  assert.deepEqual(contents(),after);assert.deepEqual(store.all(),[sibling]);
});

test('a view that departs while waiting for its lock cannot save a new command',async t=>{
  let release!:()=>void,active=true;
  t.mock.method(navigator.locks,'request',async(_name:string,work:()=>unknown)=>{
    await new Promise<void>(resolve=>{release=resolve;});return work();
  });
  const store=journal(),before=contents(),pending=store.save(command(),()=>active);
  active=false;release();await assert.rejects(pending,{name:'AbortError'});
  assert.deepEqual(contents(),before);
});

test('missing Web Locks refuses mutation while leaving existing recovery readable',async t=>{
  const store=journal(),saved=await store.save(command(),()=>true),before=contents();
  t.mock.property(navigator,'locks',undefined);
  await assert.rejects(store.begin(saved),/require Web Locks/);
  assert.deepEqual(store.all(),[saved]);assert.deepEqual(contents(),before);
});

for(const operation of ['save','begin','recordConflict'] as const)
test(`failed ${operation} readback restores exact prior bytes and emits no change`,async t=>{
  const store=journal(),saved=await store.save(command(),()=>true);
  await store.save(command(),()=>true);localStorage.setItem('loom.reading.unrelated','preserve');
  const before=contents(),setItem=dom.window.Storage.prototype.setItem;let fail=true,events=0;
  const onChange=()=>{events++;};window.addEventListener('loom-attention',onChange);
  t.after(()=>window.removeEventListener('loom-attention',onChange));
  // Simulate a storage adapter that accepts a write but cannot retain its exact
  // value. Both new intent and updates must verify custody before dispatch.
  t.mock.method(dom.window.Storage.prototype,'setItem',function(this:Storage,key:string,value:string){
    setItem.call(this,key,fail?'incomplete':value);fail=false;
  });
  const pending=operation==='save'?store.save(command(),()=>true):store[operation](saved);
  await assert.rejects(pending,operation==='recordConflict'?/conflict could not be saved/:/intent could not be saved/);
  assert.deepEqual(contents(),before);assert.equal(events,0);
});
