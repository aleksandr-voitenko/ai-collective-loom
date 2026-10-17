import { chromium } from '@playwright/test';
import { diagnosticTest as test,expect } from '../helpers/browser-fixtures.js';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

test('native lifecycle cleanup diagnostic',async({diagnostics})=>{
  const server=createServer((_request,response)=>response.end('<html><title>Synthetic cleanup</title><body>Profile cleanup fixture</body></html>'));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  diagnostics.setOrigin(origin);diagnostics.observeServer(server);
  try{
    for(let i=0;i<3;i++){
      const directory=await mkdtemp(join(tmpdir(),'loom-reading-lifecycle-'));
      const native=spawn(chromium.executablePath(),['--headless','--no-sandbox','--no-first-run','--ignore-certificate-errors','--remote-debugging-port=0','--user-data-dir='+directory,'about:blank'],{stdio:'ignore'});
      let browser:Awaited<ReturnType<typeof chromium.connectOverCDP>>|undefined;
      try{
        let port='';await expect.poll(async()=>{try{port=(await readFile(join(directory,'DevToolsActivePort'),'utf8')).split('\n')[0]!;return Number(port)>0;}catch{return false;}}).toBe(true);
        browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{noDefaults:true});
        const context=diagnostics.track(browser.contexts()[0]!,'explicit'),page=await context.newPage();
        await page.goto(origin+'/loom');
        await page.evaluate(()=>{for(let n=0;n<10;n++)localStorage.setItem('synthetic-cleanup-'+n,'x'.repeat(100000));});
      }finally{
        try{if(browser)for(const context of browser.contexts())await context.close();}
        finally{
          await browser?.close().catch(()=>{});
          await test.step('Stop native browser diagnostic',async()=>{
            if(native.exitCode===null&&native.signalCode===null){const ended=new Promise<void>(resolve=>native.once('exit',()=>resolve()));native.kill('SIGTERM');await ended;}
          });
          await test.step('Remove native browser diagnostic profile',async()=>{
            try{await rm(directory,{recursive:true,force:true});}
            catch(error){expect.soft((error as NodeJS.ErrnoException).code==='ENOTEMPTY').toBe(false);throw error;}
          });
        }
      }
    }
  }finally{
    diagnostics.phase('server_closing');await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));diagnostics.phase('server_closed');
  }
});
