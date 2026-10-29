import test from 'node:test';import assert from 'node:assert/strict';
import {measureInitialBottom,measureAutomaticBottom,worldElbowAngles,experimentalBottomDecision} from '../app/pullup-bottom.mjs';
import {PullupAnalysisSession} from '../app/pullup-rules.mjs';
function frame(t,degrees=140){
 const p=Array.from({length:33},()=>({x:.5,y:.7,z:999,visibility:1,presence:1}));
 const w=Array.from({length:33},()=>({x:0,y:0,z:0}));
 for(const[s,e,k,h,sign]of [[11,13,15,23,-1],[12,14,16,24,1]]){
  const x=.5+sign*.09;p[s]={...p[s],x,y:.38};p[e]={...p[e],x:x+sign*.05,y:.26};p[k]={...p[k],x,y:.14};p[h]={...p[h],x,y:.65};
  w[s]={x:1,y:0,z:0};w[e]={x:0,y:0,z:0};w[k]={x:Math.cos(degrees*Math.PI/180),y:Math.sin(degrees*Math.PI/180),z:0};
 }
 return {now:t,width:480,height:480,landmarks:p,worldLandmarks:w};
}
test('3D angle is invariant to world rotation, translation and scale',()=>{
 const f=frame(1000,165),g=structuredClone(f);
 g.worldLandmarks=g.worldLandmarks.map(p=>({x:3+2*p.z,y:-4+2*p.y,z:1-2*p.x}));
 for(const a of worldElbowAngles(g))assert.ok(Math.abs(a-165)<1e-9);
 assert.deepEqual(worldElbowAngles(f),worldElbowAngles(g));
});
test('missing world coordinates never fall back to image z or a negative label',()=>{
 const frames=[960,1000,1040].map(t=>({...frame(t),worldLandmarks:null}));
 const m=measureInitialBottom(frames,1000);assert.equal(m.state,'measured');assert.equal(m.angle3d,null);
 assert.equal(experimentalBottomDecision(m).state,'unavailable');
 const f=frame(1000);f.worldLandmarks[13].x=NaN;assert.equal(worldElbowAngles(f),null);
 f.worldLandmarks[13].x=0;f.landmarks[15].visibility=.1;assert.equal(worldElbowAngles(f),null);
});
test('initial bottom excludes later descent and rejects missing temporal coverage',()=>{
 const frames=[920,960,1000,1040,1080].map(t=>frame(t,140));
 const a=measureInitialBottom(frames,1000),b=measureInitialBottom([...frames,frame(3000,180)],1000);
 assert.deepEqual(a,b);assert.equal(experimentalBottomDecision(a).state,'flagged');
 assert.equal(measureInitialBottom([frame(1300),frame(1340),frame(1380)],1000).state,'unavailable');
});
test('automatic bottom corrects late onset without borrowing previous or next repetitions',()=>{
 const rep={sampleStart:1240,start:1400,top:2000};const frames=[];
 for(let t=700;t<=2100;t+=40)frames.push(frame(t,t<=1100?165:130));
 const corrected=measureAutomaticBottom(frames,rep);
 assert.ok(corrected.angle3d>160);assert.ok(corrected.timeMs>=rep.sampleStart-350);
 const bent=frames.map(f=>frame(f.now,130));
 const before=measureAutomaticBottom(bent,rep);
 const after=measureAutomaticBottom([frame(600,180),...bent,frame(2300,180),frame(2340,180),frame(2380,180)],rep);
 assert.deepEqual(before,after);assert.equal(experimentalBottomDecision(after).state,'flagged');
});
test('one spurious extended frame cannot turn a bent bottom into normal',()=>{
 const frames=[];for(let t=700;t<=1400;t+=40)frames.push(frame(t,t===1020?179:130));
 const m=measureAutomaticBottom(frames,{sampleStart:1200,start:1400,top:2000});
 assert.ok(Math.abs(m.angle3d-130)<1e-8);
});
test('session drops duplicate timestamps, bounds history, and clears 3D data on reset',()=>{
 const session=new PullupAnalysisSession({models:{}});
 for(const t of [0,40,40,25000]){const f=frame(t);session.observe(f.landmarks,t,480,480,'waiting',f.worldLandmarks);}
 assert.equal(session.bottomFrames.length,1);assert.equal(session.bottomFrames[0].now,25000);
 session.reset();assert.equal(session.bottomFrames.length,0);
});
test('initial measurement requires both arms, temporal context and stable wrists',()=>{
 const frames=[920,960,1000,1040,1080].map(t=>frame(t));
 const occluded=structuredClone(frames);for(const f of occluded)f.landmarks[13].visibility=.1;
 assert.equal(measureInitialBottom(occluded,1000).state,'unavailable');
 assert.equal(measureInitialBottom(frames.slice(2),1000).state,'unavailable');
 const jump=structuredClone(frames);jump[2].landmarks[15].x+=.12;
 assert.equal(measureInitialBottom(jump,1000).state,'unavailable');
});
test('a consistent full-body left/right label swap is not mistaken for unstable support points',()=>{
 const original=[920,960,1000,1040,1080].map(t=>frame(t,165)),swapped=structuredClone(original);
 for(let k=0;k<swapped.length;k+=2)for(const [a,b]of [[11,12],[13,14],[15,16],[23,24]])for(const name of ['landmarks','worldLandmarks']){
  const p=swapped[k][name];[p[a],p[b]]=[p[b],p[a]];
 }
 assert.deepEqual(measureInitialBottom(swapped,1000),measureInitialBottom(original,1000));
});
test('lost onset is not replaced by a later extended arm or by a previous tracking segment',()=>{
 const frames=[];for(let t=700;t<=1400;t+=40)frames.push(frame(t,165));
 const rep={sampleStart:1200,start:1400,top:2000,bottomReference:{state:'unavailable',origin:'settled',interruption:'tracking_gap'}};
 assert.equal(measureAutomaticBottom(frames,rep).state,'unavailable');
 const limited={...rep,bottomReference:{state:'observed'},contextStart:1320};
 assert.equal(measureAutomaticBottom(frames,limited).state,'unavailable');
});
test('2D caches remain measurable without inventing a 3D verdict',()=>{
 const frames=[];for(let t=700;t<=1400;t+=40)frames.push({...frame(t),worldLandmarks:null});
 const m=measureAutomaticBottom(frames,{sampleStart:1200,start:1400,top:2000});
 assert.equal(m.state,'measured');assert.equal(m.angle3d,null);
 assert.equal(experimentalBottomDecision(m).state,'unavailable');
});
test('a stable earlier top cannot substitute for an unstable lower position',()=>{
 const frames=[];
 for(let t=700;t<=1400;t+=40){
  const f=frame(t,130);
  if(t<1100)for(const i of [11,12,13,14,23,24])f.landmarks[i].y-=.16;
  else f.landmarks[15].x+=(t%80===60?.12:-.12);
  frames.push(f);
 }
 const m=measureAutomaticBottom(frames,{sampleStart:1200,start:1400,top:2000,
  bottomReference:{state:'observed',height:(.38-.14)/.27}});
 assert.equal(m.state,'unavailable');
});
