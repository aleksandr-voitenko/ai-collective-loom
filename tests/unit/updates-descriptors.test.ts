import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import { test } from 'node:test';
import { checkContinuity, decodeDescriptor, encodeDescriptor, intervalBinding, newBound, queryBinding } from '../../src/server/modules/updates/descriptors.js';
import { UpdatesError } from '../../src/server/modules/updates/errors.js';
import { attentionCoverage, directMembers, groupCounts, groupKey, traversalMetadata } from '../../src/server/modules/updates/presentation.js';
import type { Bound, Member, State, UpdatesMode, View } from '../../src/server/modules/updates/model.js';
import type { RoutineOptions } from '../../src/contracts/routine-updates.js';
import type { SharedCandidate } from '../../src/server/modules/following/retrieval.js';

const owner='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000002';
const target='00000000-0000-4000-8000-000000000003';
const definitions:Bound['definitions']=[{target:{kind:'area',resource_id:target},include_descendants:true,
  preferences:['new_discussions','replies','structural'],version:4}];
const state:State={cursor_key:Buffer.alloc(32,7),instance:'instance',epoch:'updates',shared_epoch:'shared',personal_epoch:'personal',
  shared_visibility:'11',personal_visibility:'13',shared_position:'101',personal_position:'29',shared_floor:'0',personal_floor:'0'};
const saved:Bound={purpose:'combined-updates-1',v:1,owner,instance:'instance',epoch:'updates',shared_epoch:'shared',personal_epoch:'personal',
  shared_visibility:'11',personal_visibility:'13',id,scope:'following',definitions,reason:'reply',shared_lower:'5',shared_upper:'31',
  personal_lower:'2',personal_upper:'7',shared_history:'incomplete',personal_history:'retained',kind:'groups',selection:'direct',
  after:3,group:null,direct:false,expires:2000,baseline:false};
const error=(code:string)=>(value:unknown)=>value instanceof UpdatesError&&value.code===code;

// Encode independently from the production codec, including its historical compact
// tuple representation, so a mutually incompatible encoder/decoder cannot pass.
function seal(value:unknown,purpose:string) {
  const nonce=Buffer.alloc(12,3),cipher=createCipheriv('aes-256-gcm',state.cursor_key,nonce);
  cipher.setAAD(Buffer.from(purpose));
  const bytes=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
  return Buffer.concat([nonce,cipher.getAuthTag(),bytes]).toString('base64url');
}
function open(token:string,purpose:string) {
  const bytes=Buffer.from(token,'base64url'),cipher=createDecipheriv('aes-256-gcm',state.cursor_key,bytes.subarray(0,12));
  cipher.setAAD(Buffer.from(purpose));cipher.setAuthTag(bytes.subarray(12,28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString()) as unknown;
}

for(const mode of ['combined','routine'] as const)test(`${mode} descriptors preserve independently encoded compact wire values and purpose`,()=>{
  const purpose=mode==='routine'?'combined-updates-2':'combined-updates-1';
  const bound={...saved,purpose,...(mode==='routine'?{policy:9}:{}),legacy_extension:{retained:true}} as Bound&{legacy_extension:{retained:boolean}};
  const {definitions:_,...rest}=bound;
  const compact={...rest,d:[['area',target,1,69,4]]};
  assert.deepEqual(decodeDescriptor(mode,state,seal(compact,purpose),owner),bound);
  assert.deepEqual(open(encodeDescriptor(mode,state,bound),purpose),compact);
  assert.throws(()=>decodeDescriptor(mode,state,seal(compact,purpose),target),error('updates_token_invalid'));
  assert.throws(()=>decodeDescriptor(mode==='routine'?'combined':'routine',state,seal(compact,purpose),owner),error('updates_token_invalid'));
  assert.throws(()=>decodeDescriptor(mode,{...state,epoch:'replacement'},seal(compact,purpose),owner),error('updates_epoch_changed'));
  for(const mask of [0,128])assert.throws(()=>decodeDescriptor(mode,state,seal({...compact,d:[['area',target,1,mask,4]]},purpose),owner),error('updates_token_invalid'));
});

test('descriptor limits and existing legacy field interpretation remain unchanged',()=>{
  const {definitions:_,...rest}=saved;
  const compact={...rest,policy:'legacy extension',d:[['area',target,1,69,4]]};
  assert.deepEqual(decodeDescriptor('combined',state,seal(compact,'combined-updates-1'),owner),{...saved,policy:'legacy extension'});
  assert.throws(()=>decodeDescriptor('combined',state,'x'.repeat(16385),owner),error('updates_token_invalid'));
  assert.throws(()=>encodeDescriptor('combined',state,{...saved,extension:'x'.repeat(16384)} as Bound),error('updates_capacity'));
});

test('fresh intervals preserve complete values and independent stream bounds',()=>{
  const cases:[RoutineOptions,Bound|undefined,string,string,Bound['shared_history'],Bound['personal_history'],boolean][]=[
    [{reason:'reply',selection:'direct'},undefined,'0','0','retained','retained',false],
    [{checkpoint:'saved'},{...saved,kind:'checkpoint'},'31','7','incomplete','retained',false],
    [{checkpoint:'saved'},{...saved,kind:'checkpoint',personal_history:'incomplete'},'31','7','incomplete','incomplete',false],
    [{recovery:{action:'replay',token:'saved'}},saved,'0','0','incomplete','retained',false],
    [{recovery:{action:'resynchronize',token:'saved'}},saved,'101','29','incomplete','incomplete',true],
  ];
  for(const [options,previous,sharedLower,personalLower,sharedHistory,personalHistory,baseline] of cases){
    const binding=queryBinding(options,previous),interval=intervalBinding(state,options,previous,definitions,binding.scope,options.recovery?.action);
    assert.equal(interval.fresh,true);assert.equal(interval.settingsCurrent,true);
    const actual=newBound({mode:'routine',state,owner,options,saved:previous,policy:9,action:options.recovery?.action,...binding,definitions:interval.definitions,id:'new-id',expires:9000});
    assert.deepEqual(actual,{...saved,purpose:'combined-updates-2',policy:9,id:'new-id',kind:'prepare',after:0,expires:9000,
      shared_lower:sharedLower,shared_upper:'101',personal_lower:personalLower,personal_upper:'29',
      shared_history:sharedHistory,personal_history:personalHistory,baseline});
  }
  const personalOptions:RoutineOptions={scope:{kind:'personal'},reason:'mention',recovery:{action:'resynchronize'}};
  const binding=queryBinding(personalOptions,undefined),interval=intervalBinding(state,personalOptions,undefined,undefined,binding.scope,personalOptions.recovery?.action);
  assert.deepEqual(binding,{scope:'personal',reason:'mention'});assert.deepEqual(interval.definitions,[]);
  const personal=newBound({mode:'combined',state,owner,options:personalOptions,saved:undefined,policy:undefined,action:personalOptions.recovery?.action,...binding,definitions:[],id:'new-id',expires:9000});
  assert.deepEqual(personal,{...saved,id:'new-id',scope:'personal',reason:'mention',definitions:[],kind:'prepare',selection:'highlights',after:0,
    shared_lower:'101',shared_upper:'101',personal_lower:'29',personal_upper:'29',shared_history:'incomplete',personal_history:'incomplete',baseline:true,expires:9000});
});

test('retained query binding keeps selected scope and definitions while rejecting mismatched use',()=>{
  const changed=[{...definitions[0]!,version:5}];
  for(const options of [{cursor:'saved'},{switch:{token:'saved',selection:'complete'}},{recovery:{action:'renew',token:'saved'}},
    {recovery:{action:'attention_refresh',token:'saved'}}] satisfies RoutineOptions[]){
    const binding=queryBinding(options,saved),interval=intervalBinding(state,options,saved,changed,binding.scope,options.recovery?.action);
    assert.deepEqual(binding,{scope:'following',reason:'reply'});
    assert.deepEqual(interval,{definitions,settingsCurrent:false,fresh:false,resync:false,replay:false});
  }
  const member={...saved,kind:'members' as const,group:target,direct:true};
  assert.deepEqual(queryBinding({switch:{token:'saved',selection:'complete'}},member),{scope:'following',reason:'reply'});
  assert.deepEqual(queryBinding({recovery:{action:'attention_refresh',token:'saved'}},member),{scope:'following',reason:'reply'});
  for(const options of [{cursor:'saved'},{checkpoint:'saved'}] satisfies RoutineOptions[])
    assert.throws(()=>queryBinding(options,member),error('updates_token_invalid'));
  for(const options of [{reason:'mention'},{selection:'highlights'},{scope:{kind:'personal'}}] satisfies RoutineOptions[])
    assert.throws(()=>queryBinding(options,saved),error('updates_token_invalid'));
  const checkpoint={...saved,kind:'checkpoint' as const};
  for(const options of [{switch:{token:'saved',selection:'complete'}},{recovery:{action:'renew',token:'saved'}},
    {recovery:{action:'attention_refresh',token:'saved'}}] satisfies RoutineOptions[])
    assert.throws(()=>queryBinding(options,checkpoint),error('updates_token_invalid'));
  assert.throws(()=>intervalBinding(state,{checkpoint:'saved'},checkpoint,changed,'following',undefined),error('updates_definition_changed'));
  for(const action of ['replay','resynchronize'] as const){
    const interval=intervalBinding(state,{recovery:{action,token:'saved'}},checkpoint,changed,'following',action);
    assert.deepEqual(interval,{definitions,settingsCurrent:false,fresh:true,resync:action==='resynchronize',replay:action==='replay'});
  }
});

test('interval construction uses the recovery action captured before the Following lookup',()=>{
  const options:RoutineOptions={recovery:{action:'replay',token:'saved'}},action=options.recovery!.action;
  // Model an options object changing during the intervening asynchronous read.
  // The original orchestrator retains its captured action, not a later reread.
  options.recovery!.action='resynchronize';
  const interval=intervalBinding(state,options,saved,definitions,'following',action);
  assert.deepEqual(interval,{definitions,settingsCurrent:true,fresh:true,resync:false,replay:true});
  const bound=newBound({mode:'combined',state,owner,options,saved,policy:undefined,scope:'following',reason:'reply',
    definitions,id,expires:9000,action});
  assert.deepEqual(bound,{...saved,shared_lower:'0',shared_upper:'101',personal_lower:'0',personal_upper:'29',
    kind:'prepare',after:0,expires:9000});
});

test('explicit scopes normalize deliberately and history errors retain their order',()=>{
  const explicit={...saved,scope:'explicit' as const};
  const {version:_,...settings}=definitions[0]!;
  const options:RoutineOptions={scope:{kind:'explicit',definition:{...settings,preferences:['structural','replies','new_discussions']}}};
  assert.deepEqual(queryBinding(options,explicit),{scope:'explicit',reason:'reply'});
  assert.deepEqual(intervalBinding(state,options,undefined,undefined,'explicit',undefined).definitions,[{...definitions[0]!,version:0}]);
  assert.throws(()=>queryBinding({...options,scope:{kind:'explicit',definition:{...settings,include_descendants:false}}},explicit),error('updates_token_invalid'));
  assert.throws(()=>intervalBinding({...state,shared_floor:'1',personal_floor:'1'},{},undefined,definitions,'following',undefined),error('updates_shared_history_gap'));
  assert.throws(()=>intervalBinding({...state,personal_floor:'1'},{},undefined,definitions,'following',undefined),error('updates_personal_history_gap'));
});

test('continuity orders visibility, shared history, personal history and expiry independently',t=>{
  t.mock.method(Date,'now',()=>3000);
  assert.throws(()=>checkContinuity({...state,shared_visibility:'99',shared_floor:'99',personal_floor:'99'},saved),error('updates_visibility_replay_required'));
  assert.throws(()=>checkContinuity({...state,shared_floor:'6',personal_floor:'3'},saved),error('updates_shared_history_gap'));
  assert.throws(()=>checkContinuity({...state,personal_floor:'3'},saved),error('updates_personal_history_gap'));
  assert.throws(()=>checkContinuity(state,saved),error('updates_descriptor_expired'));
  assert.doesNotThrow(()=>checkContinuity(state,saved,'renew'));
  assert.doesNotThrow(()=>checkContinuity(state,saved,'attention_refresh'));
  assert.doesNotThrow(()=>checkContinuity({...state,shared_floor:'31',personal_floor:'7'},{...saved,kind:'checkpoint',expires:0}));
  assert.throws(()=>checkContinuity({...state,shared_floor:'1'},saved,'replay'),error('updates_shared_history_gap'));
  assert.doesNotThrow(()=>checkContinuity({...state,shared_visibility:'99',shared_floor:'999',personal_floor:'999'},saved,'resynchronize'));
});

test('both modes retain v1 traversal fingerprints while attention coverage stays separate',()=>{
  const view:View={shared_after:'31',personal_after:'6',ready:true,unknown_shared:true,steps:2,retain_until:new Date(10000)};
  const boundary=(component:string,position:string)=>createHmac('sha256',state.cursor_key)
    .update(JSON.stringify(['combined-updates-1',owner,component,position])).digest('base64url');
  const expected={id,scope:'following',definitions,reason:'reply',selection:'direct',settings_current:false,grouping:'ownership; area_event',
    order:'direct_first; frozen_recent_then_identity',expires_at:new Date(2000).toISOString(),
    shared:{contract:'shared-changes-1',lower:boundary('shared','5'),upper:boundary('shared','31'),scan_complete:true,coverage:'unknown',history:'incomplete'},
    personal:{contract:'personal-attention-1',lower:boundary('personal','2'),upper:boundary('personal','7'),scan_complete:false,coverage:'known',history:'retained'}};
  for(const mode of ['combined','routine'] satisfies UpdatesMode[]){
    const bound:Bound={...saved,purpose:mode==='routine'?'combined-updates-2':'combined-updates-1'};
    assert.deepEqual(traversalMetadata(state,bound,view,false),expected);
  }
  const attention={policy_version:9,selection:'remaining_routine_inputs',counts:'source_records; shared_events; personal_signals_are_distinct_units',refresh:'explicit_same_scope_and_intervals'};
  assert.deepEqual(attentionCoverage({...saved,policy:9}),attention);
  assert.deepEqual(attentionCoverage({...saved,policy:9,selection:'complete'}),{...attention,selection:'all_represented_inputs'});
});

test('authorized presentation counts overlap once and orders tied direct records without mutating input',()=>{
  const event=(id:string,extra:Partial<SharedCandidate>={}):SharedCandidate=>({id,position:'1',kind:'revision.published',resource_id:target,
    revision_id:id,publisher_id:owner,created_at:new Date(1000),area_scope_ids:[],before_area_scope_ids:null,after_area_scope_ids:null,
    affected_target_ids:null,resource_kind:'contribution',discussion_id:'discussion',parent_id:'parent',revision_number:'1',
    content_format:'loom-markdown-v3',actor_kind:'human',nickname:'Fixture',typed:true,note:false,operation_kind:null,...extra});
  const eligible=[event('b'),event('a',{revision_number:'2'}),event('c',{resource_kind:'summary',parent_id:null}),
    event('d',{resource_kind:'artifact',discussion_id:null,parent_id:null}),event('e',{parent_id:null}),
    event('f',{kind:'organization.changed',resource_kind:'area',discussion_id:null,parent_id:null,revision_id:null})];
  const member=(event_id:string,shared:boolean,delivery_id:string|null):Member=>({event_id,resource_id:target,revision_id:event_id,
    group_kind:'discussion',group_key:'discussion',shared,delivery_id,display_at:new Date(1000)});
  const visible=[member('b',true,'delivery-b'),member('a',false,'delivery-a'),...['c','d','e','f'].map(id=>member(id,true,null))];
  const before=structuredClone(visible),direct=directMembers(visible);
  assert.deepEqual(direct.map(v=>v.event_id),['a','b']);assert.deepEqual(visible,before);
  assert.deepEqual(groupCounts(eligible,visible,direct,true),{certainty:'known_sources_only',source_records:6,shared_changes:5,
    personal_signals:2,reply_publications:1,reply_revisions:1,summary_changes:1,artifact_changes:1,opening_changes:1,structural_changes:1});
  assert.deepEqual(groupKey(eligible[0]!),{kind:'discussion',key:'discussion'});
  assert.deepEqual(groupKey(eligible[3]!),{kind:'artifact',key:target});
  assert.deepEqual(groupKey(eligible[5]!),{kind:'structural',key:'f'});
});
