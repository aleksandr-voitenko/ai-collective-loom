import { spawn,type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { DatabaseConfiguration } from '../../src/server/config.js';

/** Same-release native consumers, independently supervised by the isolated preview. */
export class NativeSearchWorker {
  private child:ChildProcess|undefined;
  private exit:Promise<void>|undefined;
  constructor(private readonly configuration:DatabaseConfiguration,private readonly consumer:'search'|'notifications'='search') {}
  async start(){
    if(this.child)return;
    const c=this.configuration;
    const child=spawn(process.execPath,[fileURLToPath(new URL(`../../dist/server/${this.consumer}-worker.js`,import.meta.url))],{
      env:{...process.env,LOOM_PARTICIPATION_PROFILE:'synthetic',LOOM_DATABASE_HOST:c.host,LOOM_POSTGRES_PORT:String(c.port),LOOM_DATABASE_NAME:c.database,LOOM_DATABASE_USER:c.user,LOOM_PG_APP_PASSWORD:c.password},
      stdio:['ignore','pipe','pipe','ipc'],
    });
    this.child=child;this.exit=new Promise(resolve=>child.once('close',()=>{if(this.child===child)this.child=undefined;resolve();}));
    try {
      await new Promise<void>((resolve,reject)=>{
        let pending='';
        const cleanup=()=>{clearTimeout(timer);child.stdout!.off('data',ready);child.off('error',failed);child.off('close',exited);};
        const fail=(message:string)=>{cleanup();reject(new Error(message));};
        const failed=()=>fail(`${this.consumer} worker failed to start.`);
        const exited=()=>fail(`${this.consumer} worker exited before readiness.`);
        const timer=setTimeout(()=>fail(`${this.consumer} worker startup timed out.`),10000);
        const ready=(data:Buffer)=>{
          pending=(pending+data.toString()).slice(-1024);
          if(pending.includes(`{"event":"${this.consumer}_worker_ready"}\n`)){cleanup();resolve();}
        };
        child.stdout!.on('data',ready);child.once('error',failed);child.once('close',exited);
        child.stderr!.resume();
      });
    } catch(error) {
      // A timed-out launch still belongs to this supervisor. Reap it before the
      // preview disposes its database or permits a replacement process.
      child.kill('SIGKILL');await this.exit;throw error;
    }
    child.stdout!.resume();child.stderr!.resume();
  }
  async stop(signal:NodeJS.Signals='SIGTERM'){this.child?.kill(signal);await this.exit;}
  async observeUntil(predicate:()=>Promise<boolean>,timeout=15000){
    const child=this.child;if(!child)throw new Error(`${this.consumer} worker is stopped.`);
    await new Promise<void>((resolve,reject)=>{
      let checking=false;
      const cleanup=()=>{clearTimeout(timer);child.off('message',check);child.off('exit',exited);};
      const exited=()=>{cleanup();reject(new Error(`${this.consumer} worker exited while observing progress.`));};
      const check=()=>{if(checking)return;checking=true;void predicate().then(ready=>{checking=false;if(ready){cleanup();resolve();}},error=>{cleanup();reject(error);});};
      const timer=setTimeout(()=>{cleanup();reject(new Error(`${this.consumer} worker progress deadline exceeded.`));},timeout);
      child.on('message',check);child.once('exit',exited);check();
    });
  }
}
