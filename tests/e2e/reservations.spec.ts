import {test,expect} from '../helpers/browser-fixtures.js';
import {setup,api,journal} from '../helpers/change-browser.js';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {plain} from '../helpers/references.js';
const base='/api/v1/editing-intent';
async function open(page:any,origin:string,id:string){await page.goto(origin+'/loom/resource/'+id);await page.getByRole('button',{name:'Inspect editing intent',exact:true}).click();await expect(page.getByText(/Observed by server at/)).toBeVisible();}
async function announce(page:any,purpose='Shorten the opening'){
  await page.getByLabel('Purpose',{exact:true}).fill(purpose);await page.getByLabel('Scope',{exact:true}).selectOption('described');await page.getByLabel('Scope description',{exact:true}).fill('chapters/01.md — introduction');
  await page.getByRole('button',{name:'Announce editing intent',exact:true}).click();await expect(page.getByText(/Original announce accepted/)).toBeVisible();
}
async function refresh(page:any){await page.getByRole('button',{name:'Refresh editing intent',exact:true}).click();await expect(page.getByText(/Observation may be stale/)).toHaveCount(0);}
test('all publication kinds expose explicit intent, overlapping peers, exact bases, keyboard refresh and narrow layout',async({page,context,server})=>{
  const f=await setup(page,context,server);
  const opening=await api(page,'/api/v1/discussions',{idempotency_key:randomUUID(),area_id:f.area,title:'Intent discussion',content:plain('Opening source')});
  const discussion=(await api(page,'/api/v1/resources/'+opening.resource_id)).discussion_id;
  const comment=await api(page,'/api/v1/replies',{idempotency_key:randomUUID(),discussion_id:discussion,parent_id:opening.resource_id,content:plain('Comment source')});
  const preparation=await api(page,'/api/v1/summary-preparations',{idempotency_key:randomUUID(),discussion_id:discussion,scope:'full'});
  const summary=await api(page,'/api/v1/summaries',{idempotency_key:randomUUID(),discussion_id:discussion,title:'Intent summary',content:plain('Summary source'),coverage:{preparation_id:preparation.preparation_id}});
  const artifact=await api(page,'/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Intent artifact',content:plain('Artifact source')});
  for(const resource of [opening,comment,summary,artifact]){
    await open(page,server.origin,resource.resource_id);expect((await server.observer.query('SELECT count(*)::int AS n FROM loom.editing_notices WHERE resource_id=$1',[resource.resource_id])).rows[0].n).toBe(0);
    await announce(page);await refresh(page);await expect(page.getByText('Shorten the opening',{exact:true})).toBeVisible();
    await page.getByLabel('Duration in minutes').fill('1');await page.getByRole('button',{name:'Renew editing intent',exact:true}).click();await expect(page.getByText(/Original renew accepted/)).toBeVisible();
    await refresh(page);await page.getByRole('button',{name:'Release editing intent',exact:true}).click();await expect(page.getByText(/Original release accepted/)).toBeVisible();
  }
  await refresh(page);await announce(page,'Overlapping intention');
  const peer=await f.admin.call(base+'/announce',{idempotency_key:randomUUID(),resource_id:artifact.resource_id,base_revision_id:artifact.revision_id,purpose:'Peer overlapping intention',scope:{kind:'described',description:'chapters/01.md — introduction'}});expect(peer.status).toBe(200);
  await refresh(page);await expect(page.getByText('Peer overlapping intention',{exact:true})).toBeVisible();
  const publish=await f.admin.call('/api/v1/revisions',{idempotency_key:randomUUID(),resource_id:artifact.resource_id,expected_revision_id:artifact.revision_id,title:'Later artifact',content:plain('Peer committed without release')});expect(publish.status).toBe(201);
  const button=page.getByRole('button',{name:'Refresh editing intent',exact:true});await button.focus();await page.keyboard.press('Enter');await expect(page.getByText(/Based on an older revision/).first()).toBeVisible();await expect(button).toBeFocused();
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if(process.env.LOOM_RESERVATIONS_REVIEW_SCREENS==='1'){await mkdir('/tmp/loom-review-evidence/reservations',{recursive:true});await page.screenshot({path:'/tmp/loom-review-evidence/reservations/intent-mobile.png',fullPage:true});}
  expect((await api(page,base+'/resources/'+artifact.resource_id)).items.filter((r:any)=>r.state==='active')).toHaveLength(2);
  // Fixture advancement covers background display; native tests wait a real minute.
  await server.observer.query("UPDATE loom.editing_notices SET expires_at=clock_timestamp()-interval '1 second' WHERE resource_id=$1",[artifact.resource_id]);
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.getByText(/Observation may be stale/)).toBeVisible();
  await refresh(page);await expect(page.getByText(/expired at observation/).first()).toBeVisible();await expect(page.getByRole('button',{name:'Edit this text',exact:true})).toBeEnabled();
});

test('lost announcement and renewal survive reload, current release and exact replay with independent pending custody',async({page,context,server})=>{
  const f=await setup(page,context,server),a=await api(page,'/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Recover intent',content:plain('Retained source')});
  await open(page,server.origin,a.resource_id);
  await page.route('**/api/v1/editing-intent/announce',async route=>{await route.fetch();await route.abort('failed');},{times:1});
  await page.getByLabel('Purpose',{exact:true}).fill('Lost announcement');await page.getByRole('button',{name:'Announce editing intent',exact:true}).click();
  await expect(page.getByRole('button',{name:'Check editing intent outcome',exact:true})).toBeEnabled();const first=await journal(page,'editing-intent.announce');const raw=JSON.stringify(first.body);
  await page.reload();await page.getByRole('button',{name:'Inspect editing intent',exact:true}).click();await page.getByRole('button',{name:'Check editing intent outcome',exact:true}).click();await expect(page.getByText(/Original announce accepted/)).toBeVisible();
  await refresh(page);await page.route('**/api/v1/editing-intent/renew',async route=>{await route.fetch();await route.abort('failed');},{times:1});
  await page.getByRole('button',{name:'Renew editing intent',exact:true}).click();await expect(page.getByRole('button',{name:'Retry exact editing intent command',exact:true})).toBeEnabled();
  const renewal=await journal(page,'editing-intent.renew');const current=(await api(page,base+'/status',{action:'renew',idempotency_key:renewal.key})).current;
  await api(page,base+'/release',{idempotency_key:randomUUID(),notice_id:current.notice_id,expected_version:current.version});
  const b=await api(page,'/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Second pending command',content:plain('Second source')});
  await open(page,server.origin,b.resource_id);await announce(page,'Second intent');await refresh(page);
  await page.route('**/api/v1/editing-intent/release',async route=>{await route.fetch();await route.abort('failed');},{times:1});
  await page.getByRole('button',{name:'Release editing intent',exact:true}).click();await expect(page.getByRole('button',{name:'Retry exact editing intent command',exact:true})).toBeEnabled();
  const pendingRelease=await journal(page,'editing-intent.release'),pendingRaw=JSON.stringify(pendingRelease);
  await page.goto(server.origin+'/loom/editing-intent');await page.reload();
  await expect(page.getByRole('button',{name:'Retry exact editing intent command',exact:true})).toHaveCount(2);let sent='';await page.route('**/api/v1/editing-intent/renew',async route=>{sent=route.request().postData()!;await route.continue();},{times:1});
  await page.getByRole('group',{name:'renew '+renewal.key,exact:true}).getByRole('button',{name:'Retry exact editing intent command',exact:true}).click();await expect(page.getByText(/Observed released at/)).toBeVisible();expect(JSON.stringify(await journal(page,'editing-intent.release'))).toBe(pendingRaw);expect(sent).toBe(JSON.stringify(renewal.body));expect(JSON.stringify((await journal(page,'editing-intent.announce',first.key)).body)).toBe(raw);
  const replay=await api(page,base+'/announce',first.body);expect(replay.current.state).toBe('released');expect((await server.observer.query('SELECT count(*)::int AS n FROM loom.editing_notices')).rows[0].n).toBe(2);
});

test('optional retrieval and capacity failures preserve complete composer drafts and never block ordinary publication',async({page,context,server})=>{
  const f=await setup(page,context,server),a=await api(page,'/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Optional notice',content:plain('Initial content')});
  await page.goto(server.origin+'/loom/resource/'+a.resource_id+'?edit=1');await page.getByLabel('Text',{exact:true}).fill('Complete authored draft survives notice failure');
  await page.route('**/api/v1/editing-intent/resources/*',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'service_unavailable',message:'Optional notice service unavailable'}})}));
  await page.getByRole('button',{name:'Inspect editing intent',exact:true}).click();await expect(page.getByText(/could not be retrieved/)).toBeVisible();await expect(page.getByLabel('Text',{exact:true})).toHaveValue('Complete authored draft survives notice failure');
  const retained=await page.evaluate(()=>Object.entries(localStorage));
  await page.evaluate(()=>{(window as any).restoreIntentStorage=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('loom.intent.v1:'))throw new Error('Synthetic durable storage refusal');return (window as any).restoreIntentStorage.call(this,key,value);};});
  await page.getByLabel('Purpose',{exact:true}).fill('Storage failure');await page.getByRole('button',{name:'Announce editing intent',exact:true}).click();await expect(page.getByText('Synthetic durable storage refusal',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>Object.entries(localStorage))).toEqual(retained);expect((await server.observer.query('SELECT count(*)::int AS n FROM loom.editing_notices')).rows[0].n).toBe(0);
  await page.evaluate(()=>{Storage.prototype.setItem=(window as any).restoreIntentStorage;delete (window as any).restoreIntentStorage;});
  await server.observer.query('UPDATE loom.editing_intent_state SET decisions=10000 WHERE id=1');
  await page.getByLabel('Purpose',{exact:true}).fill('At capacity');await page.getByRole('button',{name:'Announce editing intent',exact:true}).click();await expect(page.getByText(/synthetic editing intent limit/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Publish',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
  const saved=await journal(page,'revision.publish');expect(saved.body.content.text).toBe('Complete authored draft survives notice failure');expect((await api(page,'/api/v1/resources/'+a.resource_id)).revision_id).toBe(saved.result.revision_id);
});

test('held source response cannot restore notices after suppression; owner private release remains usable',async({page,context,server})=>{
  const f=await setup(page,context,server),a=await api(page,'/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:f.area,title:'Withdrawn intent',content:plain('Withdrawn body')});
  await open(page,server.origin,a.resource_id);await announce(page);await refresh(page);
  let release!:()=>void,entered!:()=>void;const entry=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  await page.route('**/api/v1/editing-intent/resources/*',async route=>{const response=await route.fetch();entered();await gate;await route.fulfill({response});},{times:1});
  await page.getByRole('button',{name:'Refresh editing intent',exact:true}).click();await entry;
  const state=(await f.admin.call('/api/v1/admin/moderation/resources/'+a.resource_id)).body;
  await f.admin.call('/api/v1/admin/moderation/state',{idempotency_key:randomUUID(),target:state.target,suppressed:true,expected_version:state.version});
  // A separate current source read delivers denial through the real notice host.
  await page.getByRole('button',{name:'Refresh editing intent',exact:true}).click();await expect(page.getByRole('button',{name:'Retry protected view',exact:true})).toBeVisible();release();
  await expect(page.getByText('Shorten the opening',{exact:true})).toHaveCount(0);await expect(page.getByText('Withdrawn body',{exact:true})).toHaveCount(0);
  await page.goto(server.origin+'/loom/editing-intent');await page.getByRole('button',{name:'Check editing intent outcome',exact:true}).click();await expect(page.getByRole('button',{name:'Release recovered editing intent',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Release recovered editing intent',exact:true}).click();await expect(page.getByText(/Observed released at/)).toBeVisible();
  await expect(page.getByText('Withdrawn body',{exact:true})).toHaveCount(0);
});
