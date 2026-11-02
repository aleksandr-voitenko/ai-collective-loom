import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {Page,Locator} from '@playwright/test';
import {expect} from './browser-fixtures.js';
import {applicationInputs} from '../../scripts/lib/release-identity.mjs';

// Opt-in synthetic review evidence stays outside diagnostic upload candidates.
export async function searchIndexingReview(page:Page,series='after'){
 const enabled=process.env.LOOM_SEARCH_REVIEW_SCREENS==='1';
 const directory='/tmp/loom-review-evidence/ui-03/'+series;
 const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trimEnd();
 const metadata=enabled?{
  source_commit:git('rev-parse','HEAD'),dirty_tree:git('status','--porcelain').length>0,
  dirty_paths:git('status','--porcelain').split('\n').filter(Boolean).map(line=>line.slice(3)),
  application_input_sha256:applicationInputs(process.cwd()).sha256,
  build_sha256:JSON.parse(await readFile('dist/release.json','utf8')).sha256 as string,
  browser:{name:'Chromium',version:page.context().browser()!.version()},
  test_account:{role:'administrator',kind:'human',authentication:'existing Playwright virtual WebAuthn enrollment and sign-in'},
  reproduction_command:"npm run app:build && LOOM_SEARCH_REVIEW_SCREENS=1 npm run test:e2e -- search.spec.ts",
 }:undefined;
 if(metadata){
  expect(metadata.build_sha256).toBe(metadata.application_input_sha256);
  await mkdir(directory,{recursive:true,mode:0o700});
 }
 const screenshots:unknown[]=[];
 return {async capture(state:string,injected:string[]=[],anchor?:Locator,options:{fullPage?:boolean}={}){
  if(!metadata)return;
  const previous=page.viewportSize()!;
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
   await page.setViewportSize(viewport);await page.waitForLoadState('load');
   await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(image=>image.decode()));});
   if(anchor)await anchor.evaluate(element=>element.scrollIntoView({block:'start'}));else await page.evaluate(()=>window.scrollTo(0,0));
   await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   for(const fullPage of [false,true]){
    if(fullPage && options.fullPage===false)continue;
    if(fullPage && await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight))continue;
    // Capture supplements from the document origin so offscreen fixed controls
    // do not move into a stitched page when Chromium expands its capture area.
    if(fullPage){await page.evaluate(()=>window.scrollTo(0,0));await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));}
    const filename=`${state}-${viewport.width}x${viewport.height}${fullPage?'-full-page':''}.png`;
    const bytes=await page.screenshot({path:directory+'/'+filename,fullPage});
    screenshots.push({...metadata,filename,route:new URL(page.url()).pathname,viewport,state,
     fault_injections:injected,full_viewport:!fullPage,full_page:fullPage,scroll_y:await page.evaluate(()=>scrollY),sha256:createHash('sha256').update(bytes).digest('hex')});
   }
  }
  await page.setViewportSize(previous);
  await writeFile(directory+'/manifest.json',JSON.stringify({task:'UI-03',series,screenshots,
   isolation:'Disposable synthetic PostgreSQL/HTTPS fixture and dedicated WebAuthn accounts. No retained pilot data. Authentication material remains in private test custody; no state files or traces are exported.'},null,2)+'\n',{mode:0o600});
 }};
}
