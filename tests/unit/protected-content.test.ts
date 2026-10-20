import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ContentCoordinator,contentKey} from '../../src/web/protected-content.js';
const a={kind:'artifact' as const,resource_id:'a'},b={kind:'artifact' as const,resource_id:'b'};
const available=(target=a)=>({target,source:{state:'available' as const,title:'protected',path:[],browser_url:'/source'},other_current_scope_mutes:[]});
const denied=(target=a)=>({target,source:{state:'unavailable' as const},other_current_scope_mutes:[]});

for(const delivery of ['denial first','positive first'] as const)test(`server check after recovery revokes across remount, ${delivery}`,()=>{
  let owner=1;const c=new ContentCoordinator(owner,()=>owner),r=c.region('following');r.mount();
  const old=c.begin(r,[contentKey(a)]),initial=c.begin(r);r.publish(initial,[available(a),available(b)],true);c.finish(initial);
  const first=c.begin(r);r.publish(first,[denied()],false);c.finish(first);
  r.unmount();const replacement=c.region('following');assert.equal(replacement,r);replacement.mount();replacement.retry();
  const recovery=c.begin(replacement),lease=replacement.publish(recovery,[available(a),available(b)],true);c.finish(recovery);
  const pending=c.begin(replacement);
  // Independent oracle: the source is suppressed AFTER the recovery check.
  // The old request only reaches the server now. Dispatch age is irrelevant.
  if(delivery==='positive first')replacement.publish(pending,[available(b)],true);
  r.publish(old,[denied()],true);c.finish(old);
  if(delivery==='denial first')replacement.publish(pending,[available(b)],true);
  c.finish(pending);assert.equal(replacement.preview(a,lease),undefined);assert.equal(replacement.preview(b,lease),undefined);
  replacement.unmount();assert.deepEqual(c.retained,{regions:0,requests:0,previews:0});owner++;
});

test('mixed bounded batch atomically publishes only available sources; every later denial revokes again',()=>{
 const c=new ContentCoordinator(1,()=>1),r=c.region('settings'),other=c.region('other');r.mount();other.mount();
 const settled=c.begin(other),previous=other.publish(settled,[available(b)],true);c.finish(settled);
 const pending=c.begin(other);
 const batch=c.begin(r),lease=r.publish(batch,[denied(a),available(b)],true);c.finish(batch);
 assert.equal(r.preview(a,lease)?.source.state,'unavailable');assert.equal(r.preview(b,lease)?.source.state,'available');
 assert.equal(other.preview(b,previous),undefined);
 assert.equal(other.publish(pending,[available(b)],true),undefined);c.finish(pending);
 const late=c.begin(r);r.publish(late,[denied(a)],false);c.finish(late);assert.equal(r.preview(b,lease),undefined);
});

test('source bookkeeping stays bounded across withdrawal without retaining preview data',()=>{
 const c=new ContentCoordinator(1,()=>1),r=c.region('settings');r.mount();
 const targets=Array.from({length:1000},(_,i)=>({...a,resource_id:'bounded-'+i})),read=c.begin(r),lease=r.publish(read,targets.map(available),true);c.finish(read);
 assert.equal(c.retained.previews,1000);assert.ok(r.preview(targets[0]!,lease));
 const denial=c.begin(r);c.deny(denial,new Error('Unavailable'));c.finish(denial);
 assert.equal(c.retained.previews,0);r.retry();
 const retry=c.begin(r,targets.map(contentKey));c.finish(retry);
 assert.throws(()=>c.begin(r,[contentKey(a)]),/bounded view limit/);
 r.unmount();assert.deepEqual(c.retained,{regions:0,requests:0,previews:0});
});

test('same-owner revocation reaches every region but isolates replacement identities',()=>{
 let owner=1;const c=new ContentCoordinator(1,()=>owner),old=c.region('old'),related=c.region('related'),unrelated=c.region('unrelated');
 for(const r of [old,related,unrelated])r.mount();
 const request=c.begin(old,[contentKey(a)]),relatedRead=c.begin(related),unrelatedRead=c.begin(unrelated);
 const la=related.publish(relatedRead,[available(a)],true),lb=unrelated.publish(unrelatedRead,[available(b)],true);c.finish(relatedRead);c.finish(unrelatedRead);
 c.deny(request,new Error('denied'));assert.equal(related.preview(a,la),undefined);assert.equal(unrelated.preview(b,lb),undefined);
 owner=2;const newer=new ContentCoordinator(2,()=>owner),r=newer.region('related');r.mount();const t=newer.begin(r),lease=r.publish(t,[available(a)],true);
 c.deny(request,new Error('old identity'));assert.ok(r.preview(a,lease));
});

test('ancestor refusals withdraw descendants, opaque content and apparently unrelated sources',()=>{
 const c=new ContentCoordinator(1,()=>1),old=c.region('old'),child=c.region('child'),unknown=c.region('unknown'),other=c.region('other');
 for(const r of [old,child,unknown,other])r.mount();
 const held=c.begin(old,['area:parent']),read=c.begin(child),unrelated=c.begin(other);
 const lease=child.publish(read,[{...available(a),source:{...available(a).source,path:[{id:'parent',title:'Parent'}]}}],true),otherLease=other.publish(unrelated,[available(b)],true);
 c.finish(read);c.finish(unrelated);c.deny(held,new Error('Parent unavailable'));
 assert.equal(child.preview(a,lease),undefined);assert.equal(unknown.snapshot.state,'withdrawn');assert.equal(other.preview(b,otherLease),undefined);
});

test('bounded pending custody refuses excess work and releases only after the last outstanding response',()=>{
 const c=new ContentCoordinator(1,()=>1),r=c.region('host');r.mount();
 const requests=Array.from({length:256},()=>c.begin(r));assert.throws(()=>c.begin(r),/Too many protected requests/);
 r.unmount();assert.deepEqual(c.retained,{regions:1,requests:256,previews:0});
 for(const ticket of requests)c.finish(ticket);assert.deepEqual(c.retained,{regions:0,requests:0,previews:0});
 const regions=Array.from({length:32},(_,i)=>c.region('host-'+i));for(const region of regions)region.mount();
 assert.throws(()=>c.region('overflow'),/Too many protected views/);for(const region of regions)region.unmount();
 assert.deepEqual(c.retained,{regions:0,requests:0,previews:0});
});

for(const start of ['before first preview','after first preview'] as const)
for(const arrival of ['denial first','positive first'] as const)
test(`partially resolved sibling dependencies remain conservative: ${start}, ${arrival}`,()=>{
 const c=new ContentCoordinator(1,()=>1),departed=c.region('departed-area'),r=c.region('following');departed.mount();r.mount();
 const denial=c.begin(departed,['area:parent']);departed.unmount();
 const first=c.begin(r,[contentKey(a)]),early=start==='before first preview'?c.begin(r,[contentKey(b)]):undefined;
 r.publish(first,[{...available(a),source:{...available(a).source,path:[{id:'unrelated',title:'Unrelated'}]}}],true);c.finish(first);
 const pending=early??c.begin(r,[contentKey(b)]);
 // B's server check precedes suppression; its ancestry is learned only when
 // the held positive reply arrives. A's result cannot certify B's scope.
 const held={...available(b),source:{...available(b).source,path:[{id:'parent',title:'Parent'}]}};
 if(arrival==='positive first'){r.publish(pending,[held],true);c.finish(pending);}
 c.deny(denial,new Error('Ancestor suppressed'));c.finish(denial);
 if(arrival==='denial first'){r.publish(pending,[held],true);c.finish(pending);}
 assert.equal(r.snapshot.state,'withdrawn');assert.equal(r.preview(a,r.snapshot.generation),undefined);assert.equal(r.preview(b,r.snapshot.generation),undefined);
 r.unmount();assert.deepEqual(c.retained,{regions:0,requests:0,previews:0});
});

test('a denial with unknown targets fences even fully resolved projections in other regions',()=>{
 const c=new ContentCoordinator(1,()=>1),old=c.region('old'),r=c.region('settings');old.mount();r.mount();
 const denial=c.begin(old),read=c.begin(r),lease=r.publish(read,[available(b)],true);c.finish(read);
 c.deny(denial,new Error('Unknown protected scope unavailable'));
 assert.equal(r.snapshot.state,'withdrawn');assert.equal(r.preview(b,lease),undefined);
});

test('settling pending work does not exempt cached previews from a later denial',()=>{
 const c=new ContentCoordinator(1,()=>1),old=c.region('old'),r=c.region('settings');old.mount();r.mount();
 const denial=c.begin(old,['area:unrelated']),read=c.begin(r),lease=r.publish(read,[available(a)],true);c.finish(read);
 const pending=c.begin(r,[contentKey(b)]);c.finish(pending);
 c.deny(denial,new Error('Unrelated source unavailable'));assert.equal(r.preview(a,lease),undefined);
});

test('private command custody survives global source withdrawal without preserving previews',()=>{
 const c=new ContentCoordinator(1,()=>1),old=c.region('old'),r=c.region('settings');old.mount();r.mount();
 const denial=c.begin(old,['area:unrelated']),read=c.begin(r),lease=r.publish(read,[available(a)],true);c.finish(read);
 const receipt=c.beginPrivate(r,[contentKey(b)]);
 c.deny(denial,new Error('Unrelated source unavailable'));assert.equal(r.preview(a,lease),undefined);assert.equal(receipt.finished,false);c.finish(receipt);
});

test('whole-host fences survive previews, withdrawal, retry and repeated remounts',()=>{
 const c=new ContentCoordinator(1,()=>1),old=c.region('old'),r=c.region('full-host');old.mount();r.mount();
 for(let cycle=0;cycle<3;cycle++){
  const denial=c.begin(old,['area:parent']),preview=c.begin(r),lease=r.publish(preview,[available(a)],true);c.finish(preview);
  const pending=c.begin(r,[contentKey(b)]);r.unmount();const replacement=c.region('full-host');assert.equal(replacement,r);replacement.mount();
  c.deny(denial,new Error('Ancestor suppressed'));c.finish(denial);
  replacement.publish(pending,[available(b)],true);c.finish(pending);
  assert.equal(replacement.preview(a,lease),undefined);assert.equal(replacement.preview(b,replacement.snapshot.generation),undefined);
  replacement.retry();
 }
 r.unmount();old.unmount();assert.deepEqual(c.retained,{regions:0,requests:0,previews:0});
});

test('settled requests cannot publish or revoke a later projection',()=>{
 const c=new ContentCoordinator(1,()=>1),r=c.region('settings');r.mount();
 const finished=c.begin(r);c.finish(finished);assert.equal(r.publish(finished,[available(a)],true),undefined);
 const read=c.begin(r),lease=r.publish(read,[available(b)],true);c.finish(read);
 c.deny(finished,new Error('Already settled'));assert.ok(r.preview(b,lease));
});

const lower='12345678-abcd-1234-abcd-123456789abc',upper=lower.toUpperCase();
for(const ancestor of [false,true])for(const reverse of [false,true])
test(`case aliases revoke settled ${ancestor?'ancestor':'target'} dependencies, reversed=${reverse}`,()=>{
 const c=new ContentCoordinator(1,()=>1),old=c.region('old'),current=c.region('following'),unrelated=c.region('unrelated');
 for(const r of [old,current,unrelated])r.mount();
 const read=c.begin(current),other=c.begin(unrelated),base=available({...a,resource_id:ancestor?'child':reverse?upper:lower}),
  source={...base,source:{...base.source,path:ancestor?[{id:reverse?upper:lower,title:'Ancestor'}]:[]}};
 const lease=current.publish(read,[source],true),otherLease=unrelated.publish(other,[available(b)],true);c.finish(read);c.finish(other);
 // Raw comparison keys cannot rewrite requests or exempt unrelated regions.
 const key=(ancestor?'area:':'artifact:')+(reverse?lower:upper),request=c.beginPrivate(old,[key]);
 c.deny(request,new Error('Unavailable'));c.finish(request);
 assert.equal(current.preview(source.target,lease),undefined);assert.equal(unrelated.preview(b,otherLease),undefined);
 for(const r of [old,current,unrelated])r.unmount();assert.deepEqual(c.retained,{regions:0,requests:0,previews:0});
});

test('resource host aliases retain one fence, cache and attempted preview identity through remount',()=>{
 const c=new ContentCoordinator(1,()=>1),r=c.region('area:'+upper);r.mount();
 const target={...a,resource_id:upper},canonical={...a,resource_id:lower},pending=c.begin(r,[contentKey(target)]);
 r.previewRequested(['artifact:'+upper]);assert.equal(r.hasPreviewAttempt('artifact:'+lower),true);
 r.unmount();const replacement=c.region('area:'+lower);replacement.mount();assert.equal(replacement,r);
 const read=c.begin(replacement),lease=replacement.publish(read,[available(canonical)],true);c.finish(read);
 assert.ok(replacement.preview(target,lease));assert.equal(contentKey(target),contentKey(canonical));
 c.deny(pending,new Error('Late alias refusal'));c.finish(pending);assert.equal(replacement.preview(canonical,lease),undefined);
 replacement.unmount();assert.deepEqual(c.retained,{regions:0,requests:0,previews:0});
});

test('canonical resource scopes preserve kind, opaque host names and case-sensitive paths',()=>{
 const c=new ContentCoordinator(1,()=>1);
 for(const kind of ['area','discussion','resource','artifact'])assert.equal(c.region(kind+':'+upper),c.region(kind+':'+lower));
 assert.notEqual(c.region('area:'+lower),c.region('artifact:'+lower));
 assert.notEqual(c.region('/api/source?cursor=ABC'),c.region('/api/source?cursor=abc'));
 assert.notEqual(c.region('OpaqueHost'),c.region('opaquehost'));
});
