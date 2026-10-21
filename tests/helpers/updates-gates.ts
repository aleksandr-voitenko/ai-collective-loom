import type { QueryResultRow } from 'pg';
import type { Transactions, SqlTransaction } from '../../src/server/db/postgres.js';
import { barrier, bounded } from './search-races.js';
export function gates(){
  type Match=(sql:string,values:readonly unknown[])=>boolean;
  let gate:{match:Match;phase:'before'|'after';entered:ReturnType<typeof barrier<number>>;release:ReturnType<typeof barrier<void>>;fail:boolean}|undefined;
  return {pause(match:Match,phase:'before'|'after'='after',fail=false){const g={match,phase,entered:barrier<number>(),release:barrier(),fail};gate=g;return g;},
    wrapper:(database:Transactions)=>({transaction:<T>(work:(tx:SqlTransaction)=>Promise<T>)=>database.transaction(tx=>work({
      query:async<Row extends QueryResultRow>(sql:string,values:readonly unknown[])=>{
        const g=gate?.match(sql,values)?gate:undefined;if(g)gate=undefined;
        const wait=async()=>{g!.entered.release((await tx.query<{pid:number}>('SELECT pg_backend_pid() pid',[])).rows[0]!.pid);await bounded(g!.release.promise);if(g!.fail)throw new Error('Synthetic Updates stage failure');};
        if(g?.phase==='before')await wait();const r=await tx.query<Row>(sql,values);if(g?.phase==='after')await wait();return r;
      },
    }))})};
}
