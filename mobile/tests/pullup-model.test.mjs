import test from 'node:test';import assert from 'node:assert/strict';
import {predictHGB,PullupModelSession,classifyFeatures,extractModelFeatures,mapFrame} from '../app/pullup-model.mjs';
// Generated geometry and toy trees only: no recorded person or trained weights.
const entry={baseline:0,trees:[[[1,0,0,0,0,0,0]]],threshold:.5};
const model={models:{partial:entry,swing:entry}};
function syntheticFrame(time){
 const points=Array.from({length:33},()=>({x:.5,y:.5,visibility:1,presence:1}));
 const degrees=115+50*Math.cos(2*Math.PI*time/2400),half=degrees*Math.PI/360;
 const dy=.24*Math.sin(half),bend=.12*Math.cos(half);
 for(const[s,e,w,h,k,a,sign]of [[11,13,15,23,25,27,-1],[12,14,16,24,26,28,1]]){
  const x=.5+sign*.09;
  points[w]={...points[w],x,y:.15};points[s]={...points[s],x,y:.15+dy};
  points[e]={...points[e],x:x+sign*bend,y:.15+dy/2};
  points[h]={...points[h],x,y:.4+dy};points[k]={...points[k],x,y:.55+dy};
  points[a]={...points[a],x,y:.7+dy};
 }
 points[0]={...points[0],y:.05+dy};
 return mapFrame(points,time,480,480);
}
const fixture={frames:Array.from({length:61},(_,i)=>syntheticFrame(i*40)),
 rep:{sampleStart:200,start:400,top:1200,end:2400},
 previous:[{risePixels:100,duration:2.4},{risePixels:108,duration:2.3}]};
test('tree evaluator follows numeric and missing branches',()=>{const m={baseline:0,trees:[[[0,0,0,1,1,1,2],[1,-2,0,0,0,0,0],[1,2,0,0,0,0,0]]]};assert.ok(predictHGB(m,[0])<.2);assert.ok(predictHGB(m,[2])>.8);assert.equal(predictHGB(m,[NaN]),predictHGB(m,[0]));});
test('model refuses low confidence, large gaps and unstable pose',()=>{const good=extractModelFeatures(fixture.frames,fixture.rep,fixture.previous);for(const [key,bad]of [['confidence',.1],['maxGap',1],['nanFrac',.5],['wristMove',2],['bodyJump',1]]){const r=classifyFeatures(model,{...good,quality:{...good.quality,[key]:bad}});assert.equal(r.targets.partial.state,'unavailable');assert.equal(r.targets.swing.score,null);}});
test('missing legs affect swing without fabricating confident absence',()=>{const f=extractModelFeatures(fixture.frames,fixture.rep,fixture.previous),r=classifyFeatures(model,{...f,quality:{...f.quality,legs:0}});assert.notEqual(r.targets.partial.state,'unavailable');assert.equal(r.targets.swing.state,'unavailable');});
test('first cycles leave unavailable relative context as missing',()=>{const f=extractModelFeatures(fixture.frames,fixture.rep,[]);assert.ok(Number.isNaN(f.features[1]));assert.ok(Number.isFinite(f.features[15]));});
test('reset clears prior context; repeated timestamps do not duplicate observations',()=>{const s=new PullupModelSession(model);s.observe(null,100,360,640,'waiting');s.observe(null,100,360,640,'waiting');assert.equal(s.frames.length,1);s.reset();assert.equal(s.frames.length,0);assert.equal(s.previous.length,0);assert.equal(s.contextStart,null);});
test('MediaPipe mapping preserves pixel aspect and marks missing landmarks',()=>{const p=Array.from({length:33},()=>({x:.25,y:.5,visibility:.9}));const f=mapFrame(p,1000,360,640);assert.deepEqual(f.p[5],[90,320,.9]);assert.equal(f.t,1);assert.equal(mapFrame(null,0,360,640).p[5][2],0);});
test('prefix extraction uses no future context; source buffers are not mutated',()=>{const snapshot=JSON.stringify(fixture.frames);const a=extractModelFeatures(fixture.frames,fixture.rep,fixture.previous);const future={t:fixture.rep.end/1000+1,p:Array.from({length:17},()=>[999,999,1])};const b=extractModelFeatures([...fixture.frames,future],fixture.rep,fixture.previous);assert.deepEqual(a,b);assert.equal(JSON.stringify(fixture.frames),snapshot);});
