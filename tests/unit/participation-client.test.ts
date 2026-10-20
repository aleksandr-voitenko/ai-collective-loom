import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  IntentStore,
  invalidateIdentity,
  sessionRequest,
  commandRequest,
  identityGeneration,
} from "../../src/web/participation-client.js";

test('anonymous identity probes settle without announcing another identity change',async t=>{
  let announcements=0;
  Object.defineProperty(globalThis,'window',{value:{dispatchEvent:()=>{announcements++;return true;}},configurable:true});
  t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'unauthenticated',message:'Sign in required.'}},{status:401}));
  const before=identityGeneration();
  for(let attempt=0;attempt<3;attempt++)await assert.rejects(sessionRequest('/api/v1/identity/self'),{code:'unauthenticated'});
  assert.equal(announcements,0,'An anonymous probe is a settled session state, not a new revocation event.');
  assert.equal(identityGeneration(),before);
});

test('ceremony failures and missing identity records do not revoke established source authority',async t=>{
  Object.defineProperty(globalThis,'window',{value:{dispatchEvent:()=>true},configurable:true});
  t.mock.method(globalThis,'fetch',async()=>Response.json({participant_id:'reader'}));
  await sessionRequest('/api/v1/identity/self');
  const before=identityGeneration();
  for(const ceremony of ['register','signin'])for(const step of ['start','finish'])for(const code of ['unauthenticated','invalid_proof','unavailable']){
    t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code,message:'Ceremony refused.'}},{status:401}));
    await assert.rejects(sessionRequest(`/api/v1/identity/${ceremony}/${step}`,{body:{}}),{code});
    assert.equal(identityGeneration(),before);
  }
  t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'unavailable',message:'Identity record absent.'}},{status:404}));
  await assert.rejects(commandRequest('/api/v1/identity/revoke',{body:{}}),{code:'unavailable'});
  assert.equal(identityGeneration(),before);
  invalidateIdentity();
});

test('an anonymous discovery fences older positive probes without announcing revocation',async t=>{
  Object.defineProperty(globalThis,'window',{value:{dispatchEvent:()=>true},configurable:true});invalidateIdentity();
  const calls:((r:Response)=>void)[]=[];t.mock.method(globalThis,'fetch',()=>new Promise<Response>(resolve=>calls.push(resolve)));
  const old=sessionRequest('/api/v1/identity/self'),oldRejected=assert.rejects(old,{name:'AbortError'});
  const current=sessionRequest('/api/v1/identity/self'),currentRejected=assert.rejects(current,{code:'unauthenticated'});
  const before=identityGeneration();calls[1]!(Response.json({error:{code:'unauthenticated',message:'Anonymous.'}},{status:401}));await currentRejected;
  assert.equal(identityGeneration(),before);
  calls[0]!(Response.json({participant_id:'older owner'}));await oldRejected;
  assert.equal(identityGeneration(),before);
});

test('late discovery refusal revokes a same-owner success but cannot revoke a replacement identity',async t=>{
  let events=0;Object.defineProperty(globalThis,'window',{value:{dispatchEvent:()=>{events++;return true;}},configurable:true});invalidateIdentity();
  const calls:((r:Response)=>void)[]=[];t.mock.method(globalThis,'fetch',()=>new Promise<Response>(resolve=>calls.push(resolve)));
  const old=sessionRequest('/api/v1/identity/self'),oldRejected=assert.rejects(old,{code:'unauthenticated'});
  const newer=sessionRequest('/api/v1/identity/self');calls[1]!(Response.json({participant_id:'reader'}));await newer;
  const before=events;calls[0]!(Response.json({error:{code:'unauthenticated',message:'Expired.'}},{status:401}));await oldRejected;
  assert.equal(events,before+1);
  const departing=sessionRequest('/api/v1/identity/self'),departed=assert.rejects(departing,{name:'AbortError'});
  invalidateIdentity();const replacement=sessionRequest('/api/v1/identity/self');calls[3]!(Response.json({participant_id:'replacement'}));await replacement;
  const replacementOwner=identityGeneration();calls[2]!(Response.json({error:{code:'unauthenticated',message:'Old owner.'}},{status:401}));await departed;
  assert.equal(identityGeneration(),replacementOwner);invalidateIdentity();
});

test('a definitive publication refusal preserves the authenticated owner and settles its exact journal',async t=>{
  Object.defineProperty(globalThis,'window',{value:{dispatchEvent:()=>true},configurable:true});invalidateIdentity();t.after(()=>invalidateIdentity());
  t.mock.method(globalThis,'fetch',async()=>Response.json({participant_id:'reader'}));
  await sessionRequest('/api/v1/identity/self');
  const storage=new JSDOM('',{url:'https://loom.example'}).window.localStorage;
  const store=new IntentStore('instance','reader',storage,'https://loom.example');
  const body={discussion_id:crypto.randomUUID(),parent_id:crypto.randomUUID(),content:{format:'loom-markdown-v1',text:'Preserved reply',mentions:[]}};
  const exact=await store.prepareDispatch(store.create('reply:parent','reply.create','/api/v1/replies',body),body);
  const before=identityGeneration();
  // Closing publication leaves the session and readable source valid. This is
  // the real protocol exercised by participation.spec.ts's revoked-rights case.
  t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'forbidden',message:'Publication is closed.'}},{status:403}));
  await assert.rejects(commandRequest('/api/v1/replies',{body:exact.body}),{code:'forbidden'});
  const rejected=await store.settle(exact,{state:'rejected'});
  assert.equal(identityGeneration(),before);assert.equal(rejected.state,'rejected');assert.deepEqual(rejected.body,exact.body);
});

test('v3 journal round-trips explicit change fields and refuses malformed or silently stripped semantics',async()=>{
  const storage=new JSDOM('',{url:'https://loom.example'}).window.localStorage;
  const store=new IntentStore('instance','alice',storage,'https://loom.example');
  const body={content:{format:'loom-markdown-v3',text:'Main',mentions:[],references:[]},
    change_note:{format:'loom-markdown-v2',text:'',mentions:[],references:[]},change_account:null};
  const saved=await store.saveDraft(store.create('edit:source','revision.publish','/api/v1/revisions',body),body);
  assert.deepEqual(new IntentStore('instance','alice',storage,'https://loom.example').all(),[saved]);
  for(const bad of [{...body,change_note:false},{...body,change_note:{...body.change_note,mentions:[{token:'m',participant_id:'bad'}]}},
    {...body,change_account:{revisions:[],carry_forward_revision_id:'bad'}},{...body,change_account:{carry_forward_revision_id:'bad'}},
    {content:body.content,change_account:null},{...body,content:{...body.content,format:'loom-markdown-v2'}}]){
    storage.setItem(store.prefix+saved.key,JSON.stringify({...saved,body:{...bad,idempotency_key:saved.key}}));
    assert.throws(()=>store.all(),/incompatible|requires|Legacy/);
  }
  storage.setItem(store.prefix+saved.key,JSON.stringify(saved));
  const dispatched=await store.prepareDispatch(saved,{...body,change_note:{...body.change_note,text:'Frozen note'}});
  const retried=await store.prepareDispatch(dispatched,{...body,change_note:null});
  assert.deepEqual(retried.body,dispatched.body);
});

test("recovery storage survives a new client object and separates participant, instance and origin", async () => {
  const storage = new JSDOM("", { url: "https://loom.example" }).window
    .localStorage;
  const a = new IntentStore(
    "instance",
    "alice",
    storage,
    "https://loom.example",
  );
  let intent = a.create("reply:parent", "reply.create", "/api/v1/replies", {
    parent_id: "parent",
    content: {
      format: "loom-markdown-v1",
      text: "Exact\r\ntext",
      mentions: [],
    },
  });
  intent.state = "uncertain";
  intent = await a.save(intent);
  assert.deepEqual(
    new IntentStore("instance", "alice", storage, "https://loom.example").all(),
    [intent],
  );
  for (const [instance, participant, origin] of [
    ["other", "alice", "https://loom.example"],
    ["instance", "bob", "https://loom.example"],
    ["instance", "alice", "https://different.example"],
  ])
    assert.deepEqual(
      new IntentStore(instance!, participant!, storage, origin!).all(),
      [],
    );
  const bob = new IntentStore(
    "instance",
    "bob",
    storage,
    "https://loom.example",
  );
  await assert.rejects(bob.save(intent), /different account/);
  await bob.clear();
  assert.deepEqual(a.all(), [intent]);
});
test("full or unreadable recovery storage refuses writes without evicting unresolved intent", async () => {
  const storage = new JSDOM("", { url: "https://loom.example" }).window
      .localStorage,
    a = new IntentStore("instance", "alice", storage, "https://loom.example");
  for (let i = 0; i < 32; i++) {
    let intent = a.create("reply:" + i, "reply.create", "/api/v1/replies", {
      text: "recover",
    });
    intent.state = "uncertain";
    intent = await a.save(intent);
  }
  const before = a.all();
  await assert.rejects(
    a.save(a.create("next", "reply.create", "/api/v1/replies", {})),
    /full/,
  );
  assert.deepEqual(a.all(), before);
  storage.setItem(a.prefix + "broken", "{");
  assert.throws(() => a.all(), /unreadable/);
});
test("even an uncancellable successful HTTP response is discarded after identity changes", async (t) => {
  Object.defineProperty(globalThis, "window", {
    value: { dispatchEvent: () => true },
    configurable: true,
  });
  let release!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, "fetch", () => held);
  const pending = sessionRequest("/api/v1/identity/self");
  invalidateIdentity();
  release(new Response(JSON.stringify({ private: "old owner result" })));
  await assert.rejects(pending, { name: "AbortError" });
});

test('session and command APIs reject protected reads before dispatch and preserve command bytes',async t=>{
  const calls:{path:string;body:unknown}[]=[];
  t.mock.method(globalThis,'fetch',async(path:string,options?:RequestInit)=>{
    calls.push({path,body:options?.body});return Response.json({operation_state:'not_recorded'});
  });
  for(const path of ['/api/v1/resources/example','/api/v1/contributions/example/children',
    '/api/v1/me/reading/lookup','/api/v1/me/saved-items/lookup','/api/v1/me/following/private',
    '/api/v1/shared-changes/query','/api/v1/me/attention/previews','/api/v1/new-protected-read']){
    await assert.rejects(sessionRequest(path),/authorization boundary/);
    await assert.rejects(sessionRequest(path,{body:{}}),/authorization boundary/);
    await assert.rejects(commandRequest(path,{body:{}}),/authorization boundary/);
  }
  await assert.rejects(commandRequest('/api/v1/artifacts',{body:undefined}),/authorization boundary/);
  assert.equal(calls.length,0);
  const body={idempotency_key:'ABCDEFAB-1234-1234-1234-ABCDEFABCDEF',content:{format:'loom-markdown-v1',text:'Frozen\r\nbytes',mentions:[]}};
  await commandRequest('/api/v1/replies',{body});
  await commandRequest('/api/v1/replies',{body});
  assert.deepEqual(calls,[{path:'/api/v1/replies',body:JSON.stringify(body)},{path:'/api/v1/replies',body:JSON.stringify(body)}]);
});

test("only definitive first-dispatch rejection permits a corrected identity", async () => {
  const { ApiError, isDefinitiveRejection } = await import(
    "../../src/web/participation-client.js"
  );
  for (const code of [
    "invalid_input",
    "invalid_request",
    "revision_conflict",
    "nickname_conflict",
    "credential_limit",
    "saved_limit_reached",
    "forbidden",
  ]) {
    assert.equal(
      isDefinitiveRejection(new ApiError(code, "rejected"), false),
      true,
    );
    assert.equal(
      isDefinitiveRejection(new ApiError(code, "rejected"), true),
      false,
    );
    assert.equal(
      isDefinitiveRejection(
        new ApiError(code, "unknown", undefined, "unknown"),
        false,
      ),
      false,
    );
  }
  for (const code of [
    "idempotency_conflict",
    "service_unavailable",
    "retryable",
    "unknown",
  ])
    assert.equal(
      isDefinitiveRejection(new ApiError(code, "uncertain"), false),
      false,
    );
  assert.equal(isDefinitiveRejection(new Error("timeout"), false), false);
  const storage = new JSDOM("", { url: "https://loom.example" }).window
    .localStorage;
  const store = new IntentStore(
    "instance",
    "alice",
    storage,
    "https://loom.example",
  );
  let intent = store.create(
    "setup",
    "community.setup",
    "/api/v1/community/setup",
    { community_name: "" },
  );
  intent.state = "uncertain";
  intent = await store.save(intent);
  await assert.rejects(store.correct(intent), /definitively rejected/);
  assert.deepEqual(store.all(), [intent]);
  intent.state = "rejected";
  intent = await store.save(intent);
  const before = store.all();
  await assert.rejects(
    store.correct({ ...intent, participant_id: "bob" }),
    /different account/,
  );
  assert.deepEqual(store.all(), before);
  const next = await store.correct(intent);
  assert.notEqual(next.key, intent.key);
  assert.equal(next.state, "draft");
  assert.deepEqual(next.body, { ...intent.body, idempotency_key: next.key });
  assert.deepEqual(store.all(), [next]);
});

test("failed correction storage keeps the original rejected attempt", async () => {
  const storage = new JSDOM("", { url: "https://loom.example" }).window
    .localStorage;
  const store = new IntentStore(
    "instance",
    "alice",
    storage,
    "https://loom.example",
  );
  let intent = store.create("edit", "revision.publish", "/api/v1/revisions", {
    text: "Keep rejected text",
  });
  intent.state = "rejected";
  intent = await store.save(intent);
  for (let i = 1; i < 32; i++)
    await store.save(
      store.create("other" + i, "reply.create", "/api/v1/replies", {}),
    );
  const before = store.all();
  await assert.rejects(store.correct(intent), /full/);
  assert.deepEqual(store.all(), before);
});

test("journal versions fence stale dispatch, removal and late outcomes across clients", async () => {
  const storage = new JSDOM("", { url: "https://loom.example" }).window
    .localStorage;
  const a = new IntentStore(
    "instance",
    "alice",
    storage,
    "https://loom.example",
  );
  const b = new IntentStore(
    "instance",
    "alice",
    storage,
    "https://loom.example",
  );
  const draft = await a.save(
    a.create("reply", "reply.create", "/api/v1/replies", { text: "original" }),
  );
  const [sent, stale] = await Promise.allSettled([
    a.save({ ...draft, state: "uncertain" }),
    b.save({ ...draft, body: { ...draft.body, text: "changed" } }),
  ]);
  assert.equal(sent.status, "fulfilled");
  assert.equal(stale.status, "rejected");
  const dispatched = a.all()[0]!;
  await assert.rejects(b.remove(draft), /changed in another view/);
  await assert.rejects(
    b.save({ ...draft, state: "uncertain" }),
    /changed in another view/,
  );
  const separate = await b.saveDraft(draft, { ...draft.body, text: "unsent" });
  assert.equal(separate.blocked_by, draft.key);
  assert.notEqual(separate.key, draft.key);
  assert.equal(separate.body.text, "unsent");
  assert.deepEqual(
    a.all().find((r) => r.key === draft.key),
    dispatched,
  );
  await assert.rejects(
    b.save({ ...separate, state: "uncertain" }),
    /Review the separately saved/,
  );
  const retry = await b.save(dispatched);
  // The first request's refusal is no longer proof of failure after a retry.
  assert.deepEqual(await a.settle(dispatched, { state: "rejected" }), retry);
  const committed = await b.settle(retry, { state: "committed" });
  assert.deepEqual(
    await a.settle(dispatched, { state: "rejected" }),
    committed,
  );
  await a.clear();
  await assert.rejects(
    b.settle(retry, { state: "committed" }),
    /changed in another view/,
  );
  assert.deepEqual(a.all(), []);
});

test("serialized journal quota preserves existing recovery records under concurrent creation", async () => {
  const storage = new JSDOM("", { url: "https://loom.example" }).window
    .localStorage;
  const store = new IntentStore(
    "instance",
    "alice",
    storage,
    "https://loom.example",
  );
  for (let i = 0; i < 31; i++)
    await store.save(
      store.create(String(i), "reply.create", "/api/v1/replies", {}),
    );
  const before = store.all();
  const results = await Promise.allSettled(
    [0, 1].map((i) =>
      store.save(
        store.create("new" + i, "reply.create", "/api/v1/replies", {}),
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(store.all().length, 32);
  for (const record of before)
    assert.deepEqual(
      store.all().find((r) => r.key === record.key),
      record,
    );
});

test("legacy unresolved records retain exact request identity when adopting journal versions", async () => {
  const storage = new JSDOM("", { url: "https://loom.example" }).window
    .localStorage;
  const store = new IntentStore(
    "instance",
    "alice",
    storage,
    "https://loom.example",
  );
  const { sequence: _, ...legacy } = store.create(
    "reply",
    "reply.create",
    "/api/v1/replies",
    { text: "legacy exact body" },
  );
  legacy.state = "uncertain";
  storage.setItem(store.prefix + legacy.key, JSON.stringify(legacy));
  const saved = await store.save(store.all()[0]!);
  assert.deepEqual(saved.body, legacy.body);
  assert.equal(saved.key, legacy.key);
  assert.equal(saved.state, "uncertain");
  await assert.rejects(
    store.save({ ...saved, state: "draft" }),
    /changed in another view/,
  );
  await assert.rejects(
    store.save({ ...saved, body: { ...saved.body, text: "different" } }),
    /changed in another view/,
  );
});
