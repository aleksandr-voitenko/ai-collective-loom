import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {Page} from '@playwright/test';
import {expect} from './browser-fixtures.js';
import {applicationInputs} from '../../scripts/lib/release-identity.mjs';

// Deliberately curated synthetic review evidence, never diagnostic attachments.
export async function settingsReview(page:Page,review:'ui-02'|'ui-02-followup'='ui-02'){
 const enabled=process.env.LOOM_SETTINGS_REVIEW_SCREENS==='1';
 const directory=`/tmp/loom-review-evidence/${review}/viewport`;
 const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trimEnd();
 const metadata=enabled?{
  source_commit:git('rev-parse','HEAD'),dirty_tree:git('status','--porcelain').length>0,
  dirty_paths:git('status','--porcelain').split('\n').filter(Boolean).map(line=>line.slice(3)),
  application_input_sha256:applicationInputs(process.cwd()).sha256,
  browser:{name:'Chromium',version:page.context().browser()!.version()},
  test_account:{role:'administrator',kind:'human',authentication:'existing Playwright virtual WebAuthn enrollment and sign-in'},
  route:'/loom/admin/community',
  reproduction_command:`npm run app:build && LOOM_SETTINGS_REVIEW_SCREENS=1 npm run test:e2e -- administration.spec.ts --grep '${review==='ui-02'?'bounded administrative browsing':'community settings conflict recovery and bounded picker navigation'}'`,
 }:undefined;
 if(metadata){
  const built=JSON.parse(await readFile('dist/release.json','utf8'));
  expect(built.sha256).toBe(metadata.application_input_sha256);
  await mkdir(directory,{recursive:true,mode:0o700});
 }
 const screenshots:unknown[]=[],dialogs:{decision:string;message:string}[]=[];
 return {
  dialog(decision:'cancel'|'accept',message:string){if(enabled)dialogs.push({decision,message});},
  async capture(state:string,injected:string[]=[]){
   if(!metadata)return;
   const previous=page.viewportSize()!;
   for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    await page.setViewportSize(viewport);
    await page.waitForLoadState('load');
    await page.evaluate(async()=>{
     await document.fonts.ready;
     await Promise.all([...document.images].map(image=>image.decode()));
    });
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const filename=`${state}-${viewport.width}x${viewport.height}.png`;
    const bytes=await page.screenshot({path:directory+'/'+filename,fullPage:false});
    screenshots.push({...metadata,route:new URL(page.url()).pathname,filename,state,viewport,injected_responses_or_delays:injected,
     full_viewport:true,scroll_y:await page.evaluate(()=>window.scrollY),sha256:createHash('sha256').update(bytes).digest('hex')});
    if(['version-conflict','refresh-error','unresolved-save','recovered-conflict','saved-comparison'].includes(state) && await page.getByRole('form',{name:'Community settings'}).evaluate(form=>form.getBoundingClientRect().bottom>innerHeight)){
     const fullFilename=`${state}-${viewport.width}-full-page.png`;
     const fullBytes=await page.screenshot({path:directory+'/'+fullFilename,fullPage:true});
     screenshots.push({...metadata,route:new URL(page.url()).pathname,filename:fullFilename,state,viewport,injected_responses_or_delays:injected,
      full_viewport:false,full_page:true,sha256:createHash('sha256').update(fullBytes).digest('hex')});
    }
   }
   await page.setViewportSize(previous);
   await writeFile(directory+'/manifest.json',JSON.stringify({
    task:review,screenshots,native_confirmation_checks:dialogs,
    native_confirmation_note:'Browser-native confirm dialogs are verified by Playwright dialog events; they are not page DOM and are not reconstructed in these viewport PNGs.',
    isolation:'Disposable PostgreSQL/HTTPS fixture; synthetic accounts; fixture role promotion. No retained pilot data. Browser credentials stay in the private test context; no authentication state is exported.',
   },null,2)+'\n',{mode:0o600});
  },
 };
}
