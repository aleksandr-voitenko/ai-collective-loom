// Private process/COMMIT barriers; never registered by the runtime or HTTP API.
import { PostgresDatabase, type Transactions } from '../../src/server/db/postgres.js';
import { readConfiguration } from '../../src/server/config.js';
import { NotificationWorker } from '../../src/server/modules/notifications/worker.js';
import type { QueryResultRow } from 'pg';
const database=new PostgresDatabase(readConfiguration().database),phase=process.argv[2];
const wait=()=>new Promise<void>(resolve=>process.once('message',()=>resolve()));
const wrapped:Transactions={transaction:work=>database.transaction(tx=>work({query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
  const result=await tx.query<Row>(sql,values);
  if(phase==='before_commit'&&sql.includes("state='succeeded'")){process.send?.({stage:'before_commit'});await wait();}
  return result;
}}))};
try{
  const worker=new NotificationWorker(wrapped),claim=(await worker.claim(1))[0];if(!claim)throw new Error();
  const prepared=await worker.prepare(claim);process.send?.({stage:'prepared',claim});
  if(phase==='prepared')await wait();
  const accepted=await worker.finalize(claim,prepared);process.send?.({stage:'after_commit',accepted});await wait();
}catch{process.send?.({stage:'failed'});process.exitCode=1;}
finally{await database.close();process.disconnect?.();}
