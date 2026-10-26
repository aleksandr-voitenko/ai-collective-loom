import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerParticipation, type ParticipationServices } from '../../src/server/http/participation.js';
import { participationRateRoutes, participationRateRoute } from '../../src/server/http/rate-policy.js';
import { ThrottledError } from '../../src/server/modules/rates/accounting.js';
import { responseContracts, classifyError } from '../../src/web/response-contracts.js';
import { ApiError, isDefinitiveRejection } from '../../src/web/participation-client.js';

test('every actual participation route has one explicit rate meaning, including POST reads and HEAD',async t=>{
  const app=Fastify({logger:false}),actual=new Set<string>();t.after(()=>app.close());
  app.addHook('onRoute',route=>{for(const method of [route.method].flat())actual.add(method+' '+route.url);});
  app.addHook('onRequest',async()=>{throw new ThrottledError('ordinary_requests',17);});
  await registerParticipation(app,{database:{transaction:async()=>{throw new Error('No SQL for inventory');}},authentication:{policy:{origin:'https://loom.test'}},administration:{}} as unknown as ParticipationServices);await app.ready();
  assert.deepEqual([...participationRateRoutes.keys()].sort(),[...actual].filter(r=>!r.startsWith('HEAD ')).sort());
  const publications=['discussions','replies','artifacts','revisions','summaries','summary-revisions','attachment-promotions','community/setup'];
  assert.deepEqual([...participationRateRoutes].filter(([,kind])=>kind==='publication').map(([r])=>r).sort(),publications.map(p=>'POST /api/v1/'+p).sort());
  for(const p of ['me/notes/query','me/updates/query','me/attention/private/list','me/reading/lookup'])assert.equal(participationRateRoute('POST','/api/v1/'+p),'ordinary_requests');
  for(const p of ['operations/status','me/reading/status','identity/accounts/query','admin/participation-rates/state'])assert.equal(participationRateRoute('POST','/api/v1/'+p),'recovery_control');
  assert.equal(participationRateRoute('GET','/api/v1/search/files/status'),'ordinary_requests');
  assert.equal(participationRateRoute('POST','/api/v1/identity/signin/start'),'excluded');
  assert.equal(participationRateRoute('GET','/unclassified'),undefined);
  for(const route of actual){const [method,template]=route.split(' ');const result=await app.inject({method:method as 'GET'|'POST'|'HEAD',url:template!.replace(/:\w+/g,'12345678-abcd-1234-abcd-123456789abc')});
    assert.equal(result.statusCode,429);assert.equal(result.headers['retry-after'],'17');
    if(method==='HEAD'){assert.equal(result.body,'');assert.equal(participationRateRoute(method,template),participationRateRoute('GET',template));}
    else {assert.equal(result.json().error.operation_outcome,undefined);assert.equal(result.json().error.recovery.action,'wait_then_retry_same_request');}
  }
});
test('temporary throttling never revokes identity/content or establishes command rejection',()=>{
  const failure=new ApiError('temporarily_throttled','Wait and retry the exact request.');
  for(const contract of responseContracts.values())assert.deepEqual(classifyError(contract,failure),{session:'retain',content:'retain'});
  for(const uncertain of [false,true])assert.equal(isDefinitiveRejection(failure,uncertain),false);
});

test('release OpenAPI publishes semantic categories, bounded policy commands and temporary retry guidance',async t=>{
  const {createApplication}=await import('../../src/server/http/app.js');
  const app=await createApplication({logger:false,database:{isReady:async()=>true,close:async()=>{}},participation:{database:{transaction:async()=>{throw new Error('No SQL');}},authentication:{policy:{origin:'https://loom.test'}},administration:{}} as unknown as ParticipationServices});t.after(()=>app.close());
  const response=await app.inject('/api/v1/openapi.json');assert.equal(response.statusCode,200);const spec=response.json();
  const {default:SwaggerParser}=await import('@apidevtools/swagger-parser');await SwaggerParser.validate(structuredClone(spec));
  for(const [route,category] of participationRateRoutes){const [method,template]=route.split(' '),path=template!.replace(/:(\w+)/g,'{$1}'),operation=spec.paths[path][method!.toLowerCase()];
    assert.equal(operation['x-participation-rate-category'],category,route);
    if(category!=='excluded'){assert.match(operation.responses['429'].description,/uncertainty/);assert.equal(operation.responses['429'].headers['Retry-After'].schema.maximum,60);}
  }
  const command=spec.paths['/api/v1/admin/participation-rates/state'].post;
  assert.ok(command.requestBody.required);assert.equal(spec.paths['/health/live'].get['x-participation-rate-category'],undefined);
});
