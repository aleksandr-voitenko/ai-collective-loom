import { setTimeout as delay } from 'node:timers/promises';
import { readConfiguration, ConfigurationError } from './config.js';
import { PostgresDatabase } from './db/postgres.js';
import { NotificationWorker } from './modules/notifications/worker.js';

let database:PostgresDatabase|undefined,stopping=false;
process.once('SIGINT',()=>{stopping=true;});process.once('SIGTERM',()=>{stopping=true;});
try{
  if(process.env.LOOM_PARTICIPATION_PROFILE!=='synthetic')throw new ConfigurationError('The worker requires the synthetic profile.');
  const args=process.argv.slice(2);
  if(args.length&&!(args.length===1&&args[0]==='--once'))throw new ConfigurationError('Use no arguments or --once.');
  database=new PostgresDatabase(readConfiguration().database);
  if(!await database.isReady())throw new ConfigurationError('Worker database access is unavailable or privileged.');
  const worker=new NotificationWorker(database);
  process.stdout.write('{"event":"notifications_worker_ready"}\n');
  do{
    try{await worker.tick();process.send?.({event:'notifications_worker_cycle'});}
    catch{process.stderr.write('{"event":"notifications_worker_tick_failed"}\n');if(args.length){process.exitCode=1;break;}}
    if(args.length||stopping)break;await delay(250);
  }while(!stopping);
}catch{process.stderr.write('{"event":"notifications_worker_unavailable"}\n');process.exitCode=1;}
finally{await database?.close();}
