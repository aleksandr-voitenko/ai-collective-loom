import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Value} from '@sinclair/typebox/value';
import * as N from '../../src/contracts/notes.js';
import type {ReferenceTargetValue} from '../../src/contracts/participation.js';
export const notes='/api/v1/me/notes';
export const createNote=(links:ReferenceTargetValue[]=[],extra:Record<string,unknown>={})=>({idempotency_key:randomUUID(),note_id:randomUUID(),title:'Owner canary title',body:'Private canary observation Ω café',links,...extra});
export const changeNote=(body:ReturnType<typeof createNote>,version=1,extra:Record<string,unknown>={})=>({...body,idempotency_key:randomUUID(),expected_version:version,...extra});
export const deleteNote=(id:string,version=1)=>({idempotency_key:randomUUID(),note_id:id,expected_version:version});
export async function accepted(client:any,action:string,body:unknown):Promise<N.NoteResultView>{const r=await client.call(notes+'/'+action,body);assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(Value.Check(N.NoteResult,r.body),JSON.stringify(r.body));return r.body;}
export async function readNote(client:any,id:string):Promise<N.NoteDetailView>{const r=await client.call(notes+'/'+id);assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(Value.Check(N.NoteDetail,r.body));return r.body;}
export async function queryNotes(client:any,body:Record<string,unknown>={query:''}):Promise<N.NotePageView>{const r=await client.call(notes+'/query',body);assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(Value.Check(N.NotePage,r.body));return r.body;}
