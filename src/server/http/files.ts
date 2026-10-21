import {Type} from '@sinclair/typebox';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {UUID,closed,PageInput,ParticipationError} from '../../contracts/participation.js';
import {UploadInput,UploadStatus,FilePage,fileLimits} from '../../contracts/files.js';
import type {ActorContext} from '../modules/publication/actor.js';
import type { Transactions } from '../db/postgres.js';
import {FileError,type FileStorage} from '../modules/participation/file-storage.js';
import {ArtifactFiles} from '../modules/participation/files.js';

export function registerFiles(app:FastifyInstance,database:Transactions,actor:(request:FastifyRequest)=>Promise<ActorContext>,storage?:FileStorage){
  const files=new ArtifactFiles(database,storage),empty=Type.Object({},closed),params=Type.Object({id:UUID},closed);
  const errors=Object.fromEntries([400,401,403,404,409,413,415,429,500,503].map(status=>[status,ParticipationError]));
  app.post('/api/v1/file-uploads',{bodyLimit:4096,schema:{operationId:'createFileUpload',body:UploadInput,querystring:empty,response:{...errors,201:UploadStatus}}},
    async(request,reply)=>reply.code(201).send(await files.create(await actor(request),request.body)));
  app.post('/api/v1/file-uploads/status',{schema:{operationId:'findFileUpload',body:Type.Object({idempotency_key:UUID},closed),querystring:empty,
    response:{...errors,200:Type.Union([UploadStatus,Type.Object({operation_state:Type.Literal('not_recorded')},closed)])}}},
    async request=>files.find(await actor(request),(request.body as {idempotency_key:string}).idempotency_key));
  app.get('/api/v1/file-uploads/:id',{schema:{operationId:'getFileUpload',params,querystring:empty,response:{...errors,200:UploadStatus}}},
    async request=>files.status(await actor(request),(request.params as {id:string}).id));
  app.post('/api/v1/file-uploads/:id/finalize',{schema:{operationId:'finalizeFileUpload',params,body:empty,querystring:empty,response:{...errors,200:UploadStatus}}},
    async request=>files.finalize(await actor(request),(request.params as {id:string}).id));
  app.post('/api/v1/file-uploads/cleanup',{schema:{operationId:'cleanupFileUploads',body:empty,querystring:empty,
    response:{...errors,200:Type.Object({removed:Type.Integer(),quarantined:Type.Integer()},closed)}}},async request=>files.cleanup(await actor(request)));
  // Keep a shared HTTP slot until the body is consumed or delivered. Native
  // admission also covers verified buffers awaiting final database checks.
  // No database transaction remains open while Fastify consumes a transfer.
  let receiving=0;
  async function admitTransfer(request:FastifyRequest,reply:FastifyReply){
    await actor(request);
    if(receiving>=fileLimits.active)throw new FileError('file_capacity');
    receiving++;let released=false;
    const deadline=setTimeout(()=>reply.raw.destroy(),fileLimits.transferMs);deadline.unref();
    const release=()=>{if(!released){clearTimeout(deadline);receiving--;released=true;}};
    request.raw.once('aborted',release);reply.raw.once('close',release);reply.raw.once('finish',release);
  }
  app.register(async scope=>{
    scope.addContentTypeParser('application/octet-stream',{parseAs:'buffer',bodyLimit:fileLimits.fileBytes},(_request,body,done)=>done(null,body));
    scope.post('/api/v1/file-uploads/:id/bytes',{bodyLimit:fileLimits.fileBytes,
      schema:{operationId:'uploadFileBytes',params,querystring:empty,response:{...errors,200:UploadStatus}},
      onRequest:admitTransfer},async request=>{
        if(!Buffer.isBuffer(request.body))throw new Error('Unsupported file body.');
        return files.upload(await actor(request),(request.params as {id:string}).id,request.body);
      });
  });
  const exact={id:UUID,revision:UUID};
  app.get('/api/v1/artifacts/:id/revisions/:revision/files',{schema:{operationId:'listArtifactFiles',params:Type.Object(exact,closed),
    querystring:Type.Object({...PageInput.properties,prefix:Type.Optional(Type.String({maxLength:512}))},closed),response:{...errors,200:FilePage}}},
    async request=>{const p=request.params as {id:string;revision:string};return files.manifest(await actor(request),p.id,p.revision,request.query as {});});
  app.get('/api/v1/artifacts/:id/revisions/:revision/files/:file/download',{schema:{operationId:'downloadArtifactFile',
    params:Type.Object({...exact,file:UUID},closed),querystring:empty,response:errors},onRequest:admitTransfer},async(request,reply)=>{
    const p=request.params as {id:string;revision:string;file:string};const result=await files.download(await actor(request),p.id,p.revision,p.file);
    const name=result.path.split('/').at(-1)!;
    return reply.header('content-type','application/octet-stream').header('cache-control','private, no-store')
      .header('content-security-policy',"sandbox; default-src 'none'").header('x-content-type-options','nosniff')
      .header('content-disposition',`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`)
      .send(result.bytes);
  });
}
