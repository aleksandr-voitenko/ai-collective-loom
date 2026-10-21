import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {StrictMode} from 'react';
import {createMemoryRouter} from 'react-router';
import {RouterProvider} from 'react-router/dom';
import {AuthorizationBoundary} from '../../src/web/AuthorizationBoundary.js';
import {ModerationPage} from '../../src/web/Moderation.js';
import {IntentStore} from '../../src/web/participation-client.js';
import type {Context} from '../../src/web/participation-state.js';
import type {ModerationResourceView} from '../../src/contracts/moderation.js';

const locks=navigator.locks;
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://loom.example/'});
for(const key of ['window','document','navigator','HTMLElement','MutationObserver','location','localStorage','Event'] as const)
  Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});
Object.defineProperty(globalThis,'IS_REACT_ACT_ENVIRONMENT',{value:true,configurable:true,writable:true});
dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
const {render,screen,fireEvent,cleanup,act,within}=await import('@testing-library/react');
afterEach(()=>{cleanup();localStorage.clear();});

test('saved moderation labels and custody stay independent of refreshed current control state',async t=>{
  const instance=randomUUID(),participant=randomUUID();
  const store=new IntentStore(instance,participant,localStorage,location.origin,locks);
  const artifact:ModerationResourceView={target:{kind:'artifact',resource_id:randomUUID()},local_state:'suppressed',version:7,owner_id:null,ordinary_read_available:false};
  const discussion:ModerationResourceView={target:{kind:'discussion',resource_id:randomUUID()},local_state:'active',version:8,owner_id:null,ordinary_read_available:true};
  const suppress=await store.prepareModeration({target:artifact.target,suppressed:true,expected_version:1},()=>true);
  const restore=await store.prepareModeration({target:discussion.target,suppressed:false,expected_version:2},()=>true);
  const retained=Object.entries(localStorage).sort();
  const context={store,self:{participant_id:participant,credential_id:randomUUID(),nickname:'administrator',kind:'human',role:'administrator'},community:{instance_id:instance}} as Context;
  const reads:string[]=[];
  t.mock.method(globalThis,'fetch',async(path:string,options?:RequestInit)=>{
    assert.equal(options?.method,undefined,'Rendering and refreshing saved choices must not dispatch a command');
    reads.push(path);
    if(path==='/api/v1/admin/moderation/resources/'+discussion.target.resource_id)return Response.json(discussion);
    assert.match(path,/^\/api\/v1\/admin\/moderation\/targets\?limit=(1|12)$/,'Only control metadata may be read');
    return Response.json({items:[artifact,discussion].filter(item=>item.local_state==='suppressed'),next_cursor:null,complete:true});
  });
  const router=createMemoryRouter([{path:'/loom/moderation',element:<AuthorizationBoundary sourcePolicy="settings"><ModerationPage context={context}/></AuthorizationBoundary>}],
    {initialEntries:['/loom/moderation?target='+discussion.target.resource_id+'&intent='+restore.key]});
  t.after(()=>router.dispose());
  render(<StrictMode><RouterProvider router={router}/></StrictMode>);
  await screen.findByText(/Lifecycle version 8/);
  assert.ok(screen.getByRole('button',{name:'Restore artifact'}));
  assert.ok(screen.getByRole('button',{name:'Suppress discussion'}));
  function savedChoices(){
    for(const [record,label,version,id] of [[suppress,'Suppress artifact',1,artifact.target.resource_id],[restore,'Restore discussion',2,discussion.target.resource_id]] as const){
      const group=within(screen.getByRole('group',{name:label+' '+id}));
      assert.ok(group.getByRole('heading',{name:label}));assert.ok(group.getByText(id,{exact:true}));
      assert.ok(group.getByText('Expected lifecycle version '+version,{exact:true}));
      assert.ok(group.getByText('Operation '+record.key,{exact:true}));
    }
    assert.ok(screen.getByText('Selected command · Awaiting confirmation',{exact:true}));
    assert.deepEqual(Object.entries(localStorage).sort(),retained);
  }
  savedChoices();
  artifact.local_state='active';artifact.version=9;artifact.ordinary_read_available=true;
  discussion.local_state='suppressed';discussion.version=10;discussion.ordinary_read_available=false;
  const before=reads.length;
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh control state'})));
  await screen.findAllByText(/Lifecycle version 10/);
  assert.ok(reads.length>before);savedChoices();
});
