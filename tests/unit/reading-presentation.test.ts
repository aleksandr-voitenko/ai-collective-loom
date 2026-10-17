import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PresentedBands, PresentationEpisode } from '../../src/web/reading-presentation.js';
test('full long text needs every band; hidden intervals reset unfinished dwell and resizing resets coverage',()=>{
  const bands=new PresentedBands();
  const top=(a:number,b:number)=>a>=0&&b<=320,bottom=(a:number,b:number)=>a>=320&&b<=640;
  assert.equal(bands.sample(640,top,0),false);assert.equal(bands.sample(640,top,1000),false);
  assert.equal(bands.sample(640,bottom,1100),false);assert.equal(bands.sample(640,()=>false,1500),false);
  assert.equal(bands.sample(640,bottom,2100),false);assert.equal(bands.sample(640,bottom,3100),true);
  assert.equal(bands.sample(800,()=>true,3200),false);
  bands.pause();assert.equal(bands.sample(800,()=>true,10000),false);assert.equal(bands.sample(800,()=>true,11000),true);
});
test('episode fences survive target removal/revisit and capacity pauses instead of evicting unread decisions',()=>{
  const episode=new PresentationEpisode(2);
  episode.track('old',0);episode.block('old');episode.track('second',0);
  episode.track('old',0);assert.equal(episode.excludes('old'),true);
  assert.equal(episode.excludes('second'),false);
  episode.track('second',1);assert.equal(episode.excludes('second'),true);
  episode.track('overflow',0);assert.equal(episode.paused,true);
  assert.equal(episode.excludes('overflow'),true);assert.equal(episode.excludes('old'),true);
  const reopened=new PresentationEpisode(2);reopened.track('old',1);assert.equal(reopened.excludes('old'),false);
});
