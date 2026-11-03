import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {Page,Locator} from '@playwright/test';
import {expect} from './browser-fixtures.js';
import {applicationInputs} from '../../scripts/lib/release-identity.mjs';

// Same opt-in viewport/provenance pattern as the settings and indexing reviews.
// A one-time display is captured only with Playwright's capture-time mask.
export async function admissionReview(page:Page){
 const enabled=process.env.LOOM_ADMISSION_REVIEW_SCREENS==='1';
 const directory='/tmp/loom-review-evidence/ui-04/after';
 const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trimEnd();
 const metadata=enabled?{
  source_commit:git('rev-parse','HEAD'),dirty_tree:git('status','--porcelain').length>0,
  dirty_paths:git('status','--porcelain').split('\n').filter(Boolean).map(line=>line.slice(3)),
  application_input_sha256:applicationInputs(process.cwd()).sha256,
  build_sha256:JSON.parse(await readFile('dist/release.json','utf8')).sha256 as string,
  browser:{name:'Chromium',version:page.context().browser()!.version()},
  test_account:{role:'administrator',kind:'human',authentication:'existing isolated virtual WebAuthn enrollment and sign-in'},
  reproduction_command:"npm run app:build && LOOM_ADMISSION_REVIEW_SCREENS=1 npm run test:e2e -- participation.spec.ts --grep 'rejected admission'",
 }:undefined;
 if(metadata){expect(metadata.build_sha256).toBe(metadata.application_input_sha256);await mkdir(directory,{recursive:true,mode:0o700});}
 const screenshots:unknown[]=[];
 return {async capture(state:string,anchor:Locator,faults:string[]=[],masked=false){
  if(!metadata)return;
  const secret=page.getByLabel('Issued secret',{exact:true});
  expect(await secret.count()===0||masked).toBe(true);
  if(masked)expect(await secret.count()===1).toBe(true);
  const previous=page.viewportSize()!;
  try{
   for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    await page.setViewportSize(viewport);await page.waitForLoadState('load');
    await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(image=>image.decode()));});
    await anchor.evaluate(element=>element.scrollIntoView({block:'start'}));
    await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    const filename=`${state}-${viewport.width}x${viewport.height}${masked?'-masked':''}.png`;
    const bytes=await page.screenshot({path:directory+'/'+filename,fullPage:false,mask:masked?[secret]:[],maskColor:'#333333'});
    screenshots.push({...metadata,filename,candidate_url:page.url(),route:new URL(page.url()).pathname,viewport,state,
     fault_injections:faults,redactions:masked?['Issued secret textarea masked at capture time; no DOM mutation.']:[],
     full_viewport:true,scroll_y:await page.evaluate(()=>scrollY),sha256:createHash('sha256').update(bytes).digest('hex')});
   }
  }finally{await page.setViewportSize(previous);}
  await writeFile(directory+'/manifest.json',JSON.stringify({task:'UI-04',screenshots,
   isolation:'Separate Playwright Chromium; disposable PostgreSQL/HTTPS and virtual WebAuthn. Fixture TLS exceptions are not public-certificate or physical-device validation. No staging cookies, state exports, traces or raw response bodies.'},null,2)+'\n',{mode:0o600});
 }};
}
