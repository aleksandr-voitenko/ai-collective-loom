import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {CreateBucketCommand,PutBucketVersioningCommand} from '@aws-sdk/client-s3';
import {FileStorage} from '../../src/server/modules/participation/file-storage.js';
import {localDockerEndpoint} from '../../scripts/lib/local-config.mjs';

/** Isolated named volume permits ordinary recreation without running setup again. */
export async function isolatedFileStorage(){
  const name='loom-files-test-'+randomUUID(),volume=name+'-data';
  const credentials={AWS_ACCESS_KEY_ID:randomBytes(16).toString('hex'),AWS_SECRET_ACCESS_KEY:randomBytes(32).toString('hex')};
  const docker=(args:string[])=>{const result=spawnSync('docker',args,{encoding:'utf8',timeout:900000,env:{...process.env,...credentials}});
    if(result.error||result.status!==0)throw new Error('Isolated storage Docker operation failed.');return result.stdout.trim();};
  const endpoint=docker(['context','inspect',...(process.env.DOCKER_CONTEXT?[process.env.DOCKER_CONTEXT]:[]),'--format','{{.Endpoints.docker.Host}}']);
  assert.ok(localDockerEndpoint(process.env.DOCKER_CONTEXT?endpoint:process.env.DOCKER_HOST||endpoint));
  const image=/image: (chrislusf\/seaweedfs:\S+@sha256:[a-f0-9]{64})/.exec(await readFile(new URL('../../compose.yaml',import.meta.url),'utf8'))?.[1];assert.ok(image);
  let port=0,storage:FileStorage|undefined;
  const start=()=>{docker(['run','--detach','--name',name,'-p',`127.0.0.1:${port||''}:8333`,'--mount',`type=volume,src=${volume},dst=/data`,
    ...Object.keys(credentials).flatMap(key=>['-e',key]),image,'mini','-dir=/data','-s3.port=8333']);
    port=Number(docker(['port',name,'8333/tcp']).split(':').at(-1));};
  const ready=async()=>{const end=Date.now()+90000;while(true){try{await storage!.check();return;}catch{if(Date.now()>end)throw new Error('Isolated native storage readiness timed out.');await delay(200);}}};
  const close=async()=>{storage?.client.destroy();docker(['rm','--force',name]);docker(['volume','rm',volume]);};
  try{
    start();
    // Docker reassigns an ephemeral host port on start. Fix the allocated port
    // before provisioning so persistence tests use the unchanged endpoint.
    docker(['stop',name]);docker(['rm',name]);start();
    storage=new FileStorage({endpoint:`http://127.0.0.1:${port}`,accessKeyId:credentials.AWS_ACCESS_KEY_ID,secretAccessKey:credentials.AWS_SECRET_ACCESS_KEY,
      stagingBucket:'loom-files-staging',finalBucket:'loom-files-final'});
    const deadline=Date.now()+90000;
    for(const Bucket of [storage.configuration.stagingBucket,storage.configuration.finalBucket]){
      while(true){try{await storage.client.send(new CreateBucketCommand({Bucket}));break;}catch{if(Date.now()>deadline)throw new Error('Native storage initialization timed out.');await delay(200);}}
      await storage.client.send(new PutBucketVersioningCommand({Bucket,VersioningConfiguration:{Status:'Enabled'}}));
    }
    await ready();
    return {storage,close,stop:()=>docker(['stop',name]),start:async()=>{docker(['start',name]);await ready();},
      recreate:async()=>{docker(['stop',name]);docker(['rm',name]);start();await ready();}};
  }catch(error){await close();throw error;}
}
