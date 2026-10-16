import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Page,BrowserContext} from '@playwright/test';
import {expect} from './browser-fixtures.js';
import {httpClient} from './participation-http.js';
import type {syntheticServer} from './participation-server.js';
import {plain} from './references.js';
export async function api(page:Page,path:string,body?:unknown){
  const self=await(await page.request.get(new URL('/api/v1/identity/self',page.url()).href)).json();
  const response=body===undefined?await page.request.get(new URL(path,page.url()).href):await page.request.post(new URL(path,page.url()).href,{data:body,headers:{origin:new URL(page.url()).origin,'x-loom-csrf':self.csrf}});
  expect(response.ok()).toBeTruthy();return response.json();
}
export async function setup(page:Page,context:BrowserContext,server:Awaited<ReturnType<typeof syntheticServer>>){
  const admin=httpClient(server.origin,await readFile(server.directory+'/cert.pem','utf8'));await admin.enroll(server.ticket);
  expect((await admin.call('/api/v1/community/setup',{idempotency_key:randomUUID(),community_name:'Reference browser',ordinary_area_name:'General',proposal_area_name:'Proposals',overview:plain('Overview')})).status).toBe(201);
  const area=(await admin.call('/api/v1/areas')).body.items.find((r:any)=>r.title==='General').id;
  const person=await admin.call('/api/v1/identity/accounts',{idempotency_key:randomUUID(),nickname:'browser_author',kind:'human',role:'participant'});expect(person.status).toBe(200);
  const ticket=await admin.call('/api/v1/identity/credentials',{idempotency_key:randomUUID(),participant_id:person.body.participant_id,kind:'enrollment',purpose:'enroll',label:'Reference browser',replace_credential_id:null});expect(ticket.status).toBe(200);
  const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  await page.goto(server.origin+'/loom');await page.getByText('Set up an admitted account',{exact:true}).click();await page.getByLabel('Enrollment ticket',{exact:true}).fill(ticket.body.secret);
  await page.getByRole('button',{name:'Create passkey',exact:true}).click();await expect(page.getByText('Your passkey is ready. Sign in to continue.')).toBeVisible();await page.getByRole('button',{name:'Sign in with passkey'}).click();await expect(page.getByRole('heading',{name:'Topics',exact:true})).toBeVisible();
  const target=await admin.call('/api/v1/artifacts',{idempotency_key:randomUUID(),area_id:area,title:'Target R1',content:plain('Original target text')});expect(target.status).toBe(201);
  return {admin,area,target:target.body,person:person.body.participant_id};
}

export const journal=(page:Page,kind:string,key?:string)=>page.evaluate(({kind,key})=>Object.entries(localStorage).filter(([k])=>k.startsWith('loom.intent.v1:')).map(([,v])=>JSON.parse(v)).find(r=>r.kind===kind&&(!key||r.key===key)),{kind,key});
