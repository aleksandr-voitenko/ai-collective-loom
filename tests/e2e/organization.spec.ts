import type { Page, BrowserContext } from '@playwright/test';
import { test, expect } from '../helpers/browser-fixtures.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { syntheticServer } from '../helpers/participation-server.js';
import type { Intent } from '../../src/web/participation-client.js';

const changes='/api/v1/organization/changes';
const content=(text:string)=>({format:'loom-markdown-v1',text,mentions:[]});
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
const authenticators=new WeakMap<Page,{remove:()=>Promise<unknown>}>();
async function enter(page:Page,context:BrowserContext,origin:string,ticket:string) {
  await authenticators.get(page)?.remove();
  const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');
  const {authenticatorId}=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  authenticators.set(page,{remove:()=>cdp.send('WebAuthn.removeVirtualAuthenticator',{authenticatorId})});
  await page.goto(origin+'/loom');await page.getByText('Set up an admitted account',{exact:true}).click();
  await page.getByLabel('Enrollment ticket',{exact:true}).fill(ticket);await page.getByRole('button',{name:'Create passkey',exact:true}).click();
  await expect(page.getByText('Your passkey is ready. Sign in to continue.')).toBeVisible();
  await page.getByRole('button',{name:'Sign in with passkey'}).click();await expect(page.getByRole('heading',{name:'Topics',exact:true})).toBeVisible();
}
async function api(page:Page,path:string,body?:unknown) {
  const self=await (await page.request.get(new URL('/api/v1/identity/self',page.url()).href)).json();
  const response=body===undefined?await page.request.get(new URL(path,page.url()).href):await page.request.post(new URL(path,page.url()).href,{data:body,headers:{origin:new URL(page.url()).origin,'x-loom-csrf':self.csrf}});
  expect(response.ok()).toBeTruthy();return response.json();
}
async function setup(page:Page,context:BrowserContext,server:Awaited<ReturnType<typeof syntheticServer>>) {
  await enter(page,context,server.origin,server.ticket);
  await page.getByRole('link',{name:'Administration',exact:true}).click();await page.getByRole('button',{name:'Initialize community',exact:true}).click();
  await expect(page.getByText('Community configuration',{exact:true})).toBeVisible();
  const areas=(await api(page,'/api/v1/areas')).items;
  return {general:areas.find((r:any)=>r.title==='General').id as string,feedback:areas.find((r:any)=>r.title==='Community organization').id as string};
}
async function create(page:Page,title:string,parent_id:string|null=null) {
  const version=(await api(page,'/api/v1/organization/children?limit=1')).hierarchy_version;
  return (await api(page,changes,{idempotency_key:randomUUID(),kind:'area.create',parent_id,title,description:'Scope for '+title,expected_hierarchy_version:version})).current.resource_id as string;
}
async function command(page:Page,id:string,kind:string,fields:Record<string,unknown>={}) {
  const r=await api(page,'/api/v1/organization/resources/'+id);
  return api(page,changes,{idempotency_key:randomUUID(),kind,resource_id:id,expected_version:r.version,expected_hierarchy_version:r.hierarchy_version,...fields});
}
async function records(page:Page):Promise<Intent[]> {return page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('loom.intent.')).map(k=>JSON.parse(localStorage.getItem(k)!)));}
async function view(page:Page) {await page.getByRole('link',{name:'View current location',exact:true}).click();}

test('administrator creates and edits nested topics, moves a subtree, closes/reopens by keyboard and browses narrow layouts',async({page,context,server},info)=>{
  const d=await setup(page,context,server);await page.getByRole('link',{name:'Topics',exact:true}).first().click();
  await page.getByRole('link',{name:'Create root topic',exact:true}).click();
  await page.getByLabel('Topic title',{exact:true}).fill('Research');await page.getByLabel('Scope description').fill('Shared research scope.');
  await page.getByRole('button',{name:'Save topic',exact:true}).click();await expect(page.getByText('Organization change confirmed.',{exact:true})).toBeVisible();await view(page);
  await page.getByRole('link',{name:'Create subtopic',exact:true}).click();await page.getByLabel('Topic title').fill('Reviews');await page.getByLabel('Scope description').fill('Research review scope.');await page.getByRole('button',{name:'Save topic',exact:true}).click();await view(page);
  const child=page.url().split('/').at(-1)!;
  await expect(page.getByRole('navigation',{name:'Topic ancestry'})).toContainText('Research');
  await page.getByRole('link',{name:'Edit topic',exact:true}).click();await page.getByLabel('Topic title').fill('Evidence reviews');await page.getByLabel('Scope description').fill('Published evidence and open questions.');await page.getByRole('button',{name:'Save topic',exact:true}).click();await view(page);
  await page.getByText('About this topic',{exact:true}).click();await page.getByText('Topic metadata history',{exact:true}).click();await expect(page.getByText('Evidence reviews · 2',{exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Move topic',exact:true}).click();await page.getByRole('button',{name:'Select General',exact:true}).focus();await page.keyboard.press('Enter');
  await expect(page.locator('.organization-form')).toContainText('from Research to General');
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('organization-move-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'Confirm move',exact:true}).focus();await page.keyboard.press('Enter');await view(page);
  expect((await api(page,'/api/v1/organization/resources/'+child)).parent_id).toBe(d.general);
  await command(page,child,'area.close');await page.goto(server.origin+'/loom/area/'+d.general);
  await page.getByRole('link',{name:'Close topic',exact:true}).click();await page.getByRole('button',{name:'Confirm close',exact:true}).click();await view(page);
  await expect(page.getByText('Closed to contributions',{exact:true}).first()).toBeVisible();await page.getByRole('link',{name:'Reopen topic',exact:true}).click();await page.getByRole('button',{name:'Confirm reopen',exact:true}).click();await view(page);
  expect((await api(page,'/api/v1/organization/resources/'+child)).local_open).toBe(false);
  await expect(page.getByRole('link',{name:'Evidence reviews',exact:true})).toBeVisible();
  await expect(page.getByText('Nothing here yet',{exact:true})).toBeVisible();
  await page.screenshot({path:info.outputPath('organization-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Open navigation'}).click();await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Open navigation'})).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('organization-mobile.png'),fullPage:true});
});

test('discussion and artifact move controls preserve exact revisions and use bounded contextual destinations',async({page,context,server})=>{
  const d=await setup(page,context,server),first=await create(page,'Writing'),second=await create(page,'Research');
  const reviews=await create(page,'Reviews',first);await create(page,'Reviews',second);
  const opened=await api(page,'/api/v1/discussions',{idempotency_key:randomUUID(),area_id:d.general,title:'Movable discussion',content:content('Original opening')});const discussion=(await api(page,'/api/v1/resources/'+opened.resource_id)).discussion_id;
  const artifact=await api(page,'/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:d.general,title:'Movable artifact',content:content('Exact artifact body')});
  for(const [kind,id,url] of [['discussion',discussion,'discussion'],['artifact',artifact.resource_id,'resource']]) {
    await page.goto(server.origin+'/loom/'+url+'/'+id);await page.getByRole('link',{name:'Move '+kind,exact:true}).click();
    await expect(page.getByRole('button',{name:'Select Writing › Reviews',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Select Research › Reviews',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Select Writing › Reviews',exact:true}).click();await page.getByRole('button',{name:'Confirm move',exact:true}).click();await view(page);
    expect((await api(page,'/api/v1/organization/resources/'+id)).parent_id).toBe(reviews);
  }
  const exact=await api(page,'/api/v1/resources/'+artifact.resource_id+'/revisions/'+artifact.revision_id);expect(exact.content.text).toBe('Exact artifact body');expect(exact.area_id).toBe(reviews);
});

test('lost committed move survives browser process restart; retry after another move reports original and current placement',async({server,diagnostics})=>{
  const directory=await mkdtemp(join(tmpdir(),'loom-organization-browser-'));let context=await diagnostics.launchPersistentContext(directory,{ignoreHTTPSErrors:true,headless:true});
  try {
    let page=await context.newPage();const d=await setup(page,context,server);const child=await create(page,'Moving topic',d.general);
    await page.goto(server.origin+'/loom/organize?target='+child+'&action=area.move');await page.getByRole('button',{name:'Select Community organization',exact:true}).click();
    let original:any;const discarded=barrier();await page.route('**'+changes,async route=>{original=route.request().postDataJSON();const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('connectionfailed');discarded.release();});
    await page.getByRole('button',{name:'Confirm move',exact:true}).click();await discarded.promise;await expect(page.getByRole('button',{name:'Retry same organization change'})).toBeVisible();
    await command(page,child,'area.move',{parent_id:d.general});
    await context.close();context=await diagnostics.launchPersistentContext(directory,{ignoreHTTPSErrors:true,headless:true});page=await context.newPage();await page.goto(server.origin+'/loom/organize?intent='+original.idempotency_key);
    let retried:any;page.on('request',r=>{if(r.url().endsWith(changes))retried=r.postDataJSON();});await page.getByRole('button',{name:'Retry same organization change'}).click();
    await expect(page.getByText('Organization change confirmed.',{exact:true})).toBeVisible();expect(retried).toEqual(original);
    await expect(page.locator('.organization-form')).toContainText('Current location: General › Moving topic');
    expect((await api(page,'/api/v1/organization/resources/'+child)).parent_id).toBe(d.general);
    expect((await server.observer.query('SELECT count(*)::int AS n FROM loom.organization_operations WHERE idempotency_key=$1',[original.idempotency_key])).rows[0].n).toBe(1);
  }finally{await context.close();await rm(directory,{recursive:true,force:true});}
});

test('stale versions preserve metadata inputs across reload and require an explicit reviewed correction',async({page,context,server})=>{
  const d=await setup(page,context,server);await page.goto(server.origin+'/loom/organize?target='+d.general+'&action=area.edit');await page.getByLabel('Topic title').fill('My retained title');await page.getByLabel('Scope description').fill('My retained scope');
  await command(page,d.general,'area.edit',{title:'Other confirmed title',description:'Other scope'});
  await page.getByRole('button',{name:'Save topic',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Organization changed');
  await page.reload();await expect(page.getByLabel('Topic title')).toHaveValue('My retained title');await expect(page.getByLabel('Scope description')).toHaveValue('My retained scope');
  await expect(page.getByLabel('Topic title')).toBeDisabled();await page.getByRole('button',{name:'Review latest organization and prepare correction'}).click();await expect(page.getByLabel('Topic title')).toBeEnabled();
  await page.getByRole('button',{name:'Save topic',exact:true}).click();await expect(page.getByText('Organization change confirmed.',{exact:true})).toBeVisible();
  expect((await api(page,'/api/v1/organization/resources/'+d.general)).title).toBe('My retained title');
});

test('a stale tab saves separate organization input without changing the dispatched operation or unrelated drafts',async({page,context,server})=>{
  const d=await setup(page,context,server);await page.goto(server.origin+'/loom/area/'+d.general);await page.getByRole('button',{name:'Start a discussion'}).click();await page.getByLabel('Title',{exact:true}).fill('Unrelated draft');await page.getByLabel('Text',{exact:true}).fill('Keep my publication');
  await expect.poll(async()=>(await records(page)).find(r=>r.kind==='discussion.create')?.body.title).toBe('Unrelated draft');
  await page.goto(server.origin+'/loom/organize?target='+d.general+'&action=area.edit');await page.getByLabel('Topic title').fill('Confirmed name');
  const operation=(await records(page)).find(r=>r.kind==='organization.change')!;
  const other=await context.newPage();await other.goto(server.origin+'/loom/organize?intent='+operation.key);await expect(other.getByLabel('Topic title')).toHaveValue('Confirmed name');
  await page.getByRole('button',{name:'Save topic',exact:true}).click();await expect(page.getByText('Organization change confirmed.',{exact:true})).toBeVisible();
  await other.getByLabel('Topic title').fill('Separate unsent name');await expect(other.getByText('Your changes were saved separately.',{exact:true})).toBeVisible();
  const all=await records(other);expect(all.find(r=>r.key===operation.key)!.body.title).toBe('Confirmed name');expect(all.find(r=>r.blocked_by===operation.key)!.body.title).toBe('Separate unsent name');expect(all.find(r=>r.kind==='discussion.create')!.body.title).toBe('Unrelated draft');
  await other.reload();await expect(other.getByLabel('Topic title')).toHaveValue('Separate unsent name');await other.close();
});

test('late organization responses cannot redirect a new route or overwrite a different account',async({page,context,server})=>{
  const d=await setup(page,context,server);
  const account=await api(page,'/api/v1/identity/accounts',{idempotency_key:randomUUID(),nickname:'ordinary_reader',kind:'human',role:'participant'});
  const ticket=await api(page,'/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:account.participant_id,kind:'enrollment',purpose:'enroll',label:'Browser account',replace_credential_id:null});
  await page.goto(server.origin+'/loom/organize?target='+d.general+'&action=area.edit');await page.getByLabel('Topic title').fill('Late result');
  const committed=barrier(),release=barrier();await page.route('**'+changes,async route=>{const response=await route.fetch();committed.release();await release.promise;await route.fulfill({response});});
  try {
    await page.getByRole('button',{name:'Save topic',exact:true}).click();await committed.promise;
    await page.getByRole('link',{name:'Saved items',exact:true}).first().click();await expect(page.getByRole('heading',{name:'Saved items',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Sign out',exact:true}).click();
    await page.getByRole('button',{name:'Clear local drafts and sign out',exact:true}).click();
    await expect(page.getByRole('button',{name:'Sign in with passkey'})).toBeVisible();
    await enter(page,context,server.origin,ticket.secret);
    release.release();await page.unrouteAll({behavior:'wait'});await expect(page.getByRole('heading',{name:'Topics',exact:true})).toBeVisible();
    await expect(page.getByRole('link',{name:'Create root topic',exact:true})).toHaveCount(0);
    await page.goto(server.origin+'/loom/organize?target='+d.general+'&action=area.close');await expect(page.getByRole('alert')).toContainText('Administrator access is required');
    const all=await records(page);expect(all.filter(r=>r.participant_id===account.participant_id&&r.kind==='organization.change')).toHaveLength(0);
  }finally{release.release();}
});

test('proposal route changes and closure retain the ordinary draft, affected-area reference and administrator fallback',async({page,context,server})=>{
  const d=await setup(page,context,server);
  await page.goto(server.origin+'/loom/overview');await page.getByRole('button',{name:'Suggest an organizational change'}).click();
  await expect(page.getByLabel('Text',{exact:true})).toHaveValue('');
  await page.getByLabel('Title',{exact:true}).fill('Community-wide suggestion');await page.getByLabel('Text',{exact:true}).fill('About our whole community.');
  await expect.poll(async()=> (await records(page)).find(r=>r.slot==='proposal:community')?.body.content).toEqual(content('About our whole community.'));
  await page.goto(server.origin+'/loom/help');await page.getByRole('link').filter({hasText:'discussion.create · draft'}).click();
  await expect(page).toHaveURL(/\/loom\/overview\?proposal=1&intent=/);await expect(page.getByLabel('Text',{exact:true})).toHaveValue('About our whole community.');
  expect((await records(page)).find(r=>r.slot==='proposal:community')!.body.proposal_context).not.toHaveProperty('affected_area_id');
  await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
  expect((await server.observer.query('SELECT count(*)::int AS n FROM loom.discussion_area_references')).rows[0].n).toBe(0);
  await page.goto(server.origin+'/loom/area/'+d.general);await page.getByText('About this topic',{exact:true}).click();
  const before=(await server.observer.query('SELECT count(*)::int AS n FROM loom.discussions')).rows[0].n;
  await page.getByRole('button',{name:'Suggest an organizational change'}).click();expect((await server.observer.query('SELECT count(*)::int AS n FROM loom.discussions')).rows[0].n).toBe(before);
  await page.getByLabel('Title',{exact:true}).fill('Keep this suggestion');await page.getByLabel('Text',{exact:true}).fill('Please organize this area.');
  await command(page,d.feedback,'area.close');await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button',{name:'Refresh proposal route'}).click();await expect(page.getByText(/Keep your draft and contact an administrator/)).toBeVisible();await expect(page.getByLabel('Text',{exact:true})).toHaveValue('Please organize this area.');
  const record=(await records(page)).find(r=>r.slot==='proposal:'+d.general)!;expect(record.body.area_id).toBe(d.feedback);expect((record.body.proposal_context as any).affected_area_id).toBe(d.general);
  await page.goto(server.origin+'/loom/help');await page.getByRole('link').filter({hasText:'discussion.create · rejected'}).click();await expect(page.getByLabel('Text',{exact:true})).toHaveValue('Please organize this area.');
  await command(page,d.feedback,'area.open');await command(page,d.feedback,'area.edit',{title:'Renamed feedback',description:'Same route'});await command(page,d.feedback,'area.move',{parent_id:d.general});
  await page.getByRole('button',{name:'Prepare corrected submission'}).click();await page.getByRole('button',{name:'Publish',exact:true}).click();await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
  expect((await server.observer.query('SELECT area_id FROM loom.discussion_area_references')).rows[0].area_id).toBe(d.general);
});

for (const availability of ['closed', 'unconfigured'] as const) {
  for (const state of ['draft', 'uncertain'] as const) {
    test(`community-wide proposal ${state} recovers after its destination is ${availability}`, async ({page,context,server}) => {
      const d = await setup(page,context,server);
      await page.goto(server.origin+'/loom/overview');
      await page.getByRole('button',{name:'Suggest an organizational change'}).click();
      await page.getByLabel('Title',{exact:true}).fill('Retained community suggestion');
      await page.getByLabel('Text',{exact:true}).fill('Keep this exact community-wide proposal.');
      await expect.poll(async()=> (await records(page)).find(r=>r.slot==='proposal:community')?.body.content)
        .toEqual(content('Keep this exact community-wide proposal.'));
      const original = (await records(page)).find(r=>r.slot==='proposal:community')!;
      expect(original.body.area_id).toBe(d.feedback);
      expect(original.body.proposal_context).not.toHaveProperty('affected_area_id');
      const before = (await server.observer.query('SELECT count(*)::int AS n FROM loom.discussions')).rows[0].n;
      if (state === 'uncertain') {
        await page.route('**/api/v1/discussions', async route => {
          expect(route.request().postDataJSON()).toEqual(original.body);
          const response = await route.fetch();
          expect(response.status()).toBe(201);
          await route.abort('connectionfailed');
        });
        await page.getByRole('button',{name:'Publish',exact:true}).click();
        await expect(page.getByRole('button',{name:'Check status',exact:true})).toBeVisible();
        await page.unrouteAll({behavior:'wait'});
      }
      if (availability === 'closed') await command(page,d.feedback,'area.close');
      else {
        const community = await api(page,'/api/v1/community');
        await api(page,'/api/v1/community/settings',{
          idempotency_key:randomUUID(),expected_version:community.settings_version,
          community_name:community.community_name,overview_id:community.overview.resource_id,
          proposal_area_id:null,
        });
      }
      expect((await api(page,'/api/v1/community')).proposal_area)
        .toEqual({state:availability==='closed'?'unavailable':'setup_incomplete'});
      await page.goto(server.origin+'/loom/help');
      await page.getByRole('link').filter({hasText:'discussion.create · '+state}).click();
      await expect(page).toHaveURL(new RegExp('/loom/overview\\?proposal=1&intent='+original.key+'$'));
      await page.reload();
      await expect(page.getByText(/Keep your draft and contact an administrator/)).toBeVisible();
      await expect(page.getByRole('link',{name:'Administrator contacts',exact:true})).toBeVisible();
      await expect(page.getByLabel('Text',{exact:true})).toHaveValue('Keep this exact community-wide proposal.');
      await expect(page.getByLabel('Title',{exact:true})).toHaveValue('Retained community suggestion');
      const retained = (await records(page)).find(r=>r.key===original.key)!;
      expect(retained.body).toEqual(original.body);
      expect(retained.state).toBe(state);
      if (state === 'uncertain') {
        const status = page.waitForRequest(r=>r.url().endsWith('/api/v1/operations/status'));
        await page.getByRole('button',{name:'Check status',exact:true}).click();
        expect((await status).postDataJSON()).toEqual({operation_kind:'discussion.create',idempotency_key:original.key});
        await expect(page.getByText('Your publication is saved.',{exact:true})).toBeVisible();
        const settled = (await records(page)).find(r=>r.key===original.key)!;
        expect(settled.body).toEqual(original.body);
        expect(settled.state).toBe('committed');
      } else await expect(page.getByLabel('Text',{exact:true})).toBeEnabled();
      expect((await server.observer.query('SELECT count(*)::int AS n FROM loom.discussions')).rows[0].n)
        .toBe(before+(state==='uncertain'?1:0));
      expect((await server.observer.query('SELECT count(*)::int AS n FROM loom.discussion_area_references')).rows[0].n).toBe(0);
    });
  }
}

test('destination pagination fails explicitly after a hierarchy change and refresh retains the move form',async({page,context,server})=>{
  const d=await setup(page,context,server);for(let i=0;i<13;i++)await create(page,'Destination '+i);
  await page.goto(server.origin+'/loom/organize?target='+d.general+'&action=area.move');await expect(page.getByRole('button',{name:'Next topics'})).toBeEnabled();
  await create(page,'Intervening topic');await page.getByRole('button',{name:'Next topics'}).click();await expect(page.getByRole('alert')).toContainText('Start this view again');
  await expect(page.getByRole('button',{name:'Confirm move',exact:true})).toBeVisible();await page.getByRole('button',{name:'Refresh topics'}).click();await expect(page.getByRole('button',{name:'Next topics'})).toBeEnabled();await page.getByRole('button',{name:'Next topics'}).click();
  await expect(page.getByRole('heading',{name:'Choose a destination',exact:true})).toBeFocused();
});
