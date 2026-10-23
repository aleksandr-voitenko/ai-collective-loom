import {PostgresDatabase} from '../../src/server/db/postgres.js';
import {readConfiguration} from '../../src/server/config.js';
import {FileStorage} from '../../src/server/modules/participation/file-storage.js';
import {FileTextWorker} from '../../src/server/modules/search/file-worker.js';
import type {QueryResultRow} from 'pg';
const database=new PostgresDatabase(readConfiguration().database),storage=new FileStorage(JSON.parse(process.env.LOOM_FILE_STORAGE!)),phase=process.argv[2];
const wait=()=>new Promise<void>(resolve=>process.once('message',()=>resolve()));
// Private process barriers exercise real COMMIT ownership, never a product route.
const worker=new FileTextWorker({transaction:work=>database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
  const result=await tx.query<Row>(sql,values);
  if(phase==='before_commit'&&sql.startsWith('UPDATE loom.file_text_jobs SET state=$2')){process.send?.({stage:'before_commit'});await wait();}
  return result;
}}))},storage);
try{
  await worker.discover();const claim=(await worker.claim(1))[0];if(!claim)throw new Error();
  const prepared=await worker.prepare(claim);process.send?.({stage:'prepared',claim});
  if(phase==='prepared')await wait();
  const accepted=await worker.finalize(claim,prepared);process.send?.({stage:'after_commit',accepted});await wait();
}catch{process.send?.({stage:'failed'});process.exitCode=1;}
finally{storage.client.destroy();await database.close();process.disconnect?.();}
