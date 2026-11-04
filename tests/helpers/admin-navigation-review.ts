import {execFileSync} from 'node:child_process';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {Page} from '@playwright/test';
import {expect} from './browser-fixtures.js';
import {applicationInputs} from '../../scripts/lib/release-identity.mjs';

// Opt-in actual application evidence, separate from diagnostic uploads.
export async function adminNavigationReview(page:Page,series?:'participant-recovery'|'handoff-completion'){
 const mode=process.env.LOOM_ADMIN_NAVIGATION_REVIEW;
 const enabled=mode==='before'||mode==='after';
 const directory='/tmp/loom-review-evidence/ui-05/'+mode+(series?'/'+series:'');
 const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trimEnd();
 const inputs=enabled?applicationInputs(process.cwd()):undefined;
 const assets:Record<string,string>={};
 if(enabled)for(const directory of ['dist/web','dist/web/assets'])for(const name of await readdir(directory)){
  if(/\.(html|js|css)$/.test(name))assets[directory+'/'+name]=createHash('sha256').update(await readFile(directory+'/'+name)).digest('hex');
 }
 const metadata=enabled?{
  source_commit:git('rev-parse','HEAD'),dirty_tree:git('status','--porcelain').length>0,
  dirty_paths:git('status','--porcelain').split('\n').filter(Boolean).map(line=>line.slice(3)),
  application_input_sha256:inputs!.sha256,
  build_sha256:JSON.parse(await readFile('dist/release.json','utf8')).sha256,
  served_asset_sha256:assets,
  browser:{name:'Chromium',version:page.context().browser()!.version()},
  authentication:'Isolated synthetic administrator, existing virtual WebAuthn enrollment/sign-in',
 }:undefined;
 if(metadata){expect(metadata.build_sha256).toBe(metadata.application_input_sha256);await mkdir(directory,{recursive:true,mode:0o700});await writeFile(directory+'/source-inputs.json',JSON.stringify(inputs,null,2)+'\n',{mode:0o600});}
 const screenshots:unknown[]=[];
 return {before:mode==='before',async capture(state:string,viewports=[{width:1440,height:1000}],faults:string[]=[]){
  if(!metadata)return;
  expect(await page.getByLabel('Issued secret',{exact:true}).count()).toBe(0);
  const previous=page.viewportSize()!;
  try{for(const viewport of viewports){
   await page.setViewportSize(viewport);await page.waitForLoadState('load');
   await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(image=>image.decode()));window.scrollTo(0,0);});
   await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   const filename=`${state}-${viewport.width}x${viewport.height}.png`;
   const bytes=await page.screenshot({path:directory+'/'+filename,fullPage:false});
   screenshots.push({...metadata,filename,route:new URL(page.url()).pathname,query:new URL(page.url()).search,viewport,state,
    fault_injections:faults,redactions:[],full_viewport:true,sha256:createHash('sha256').update(bytes).digest('hex')});
  }}finally{await page.setViewportSize(previous);}
  await writeFile(directory+'/manifest.json',JSON.stringify({task:'UI-05',mode,screenshots,
   isolation:'Disposable PostgreSQL/HTTPS, software passkey; no pilot/staging access. No cookies, secrets, profiles, traces or authentication exports in this package.'},null,2)+'\n',{mode:0o600});
 }};
}
