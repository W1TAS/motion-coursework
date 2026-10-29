import test from 'node:test';import assert from 'node:assert/strict';
import {assessPullupTop} from '../app/pullup-top.mjs';
import {measureTopProxy} from '../research/pullup-top-proxy.mjs';
import {wristPriorReference,measureFaceHeight} from '../research/actual-bar-height.mjs';
const prior={empiricalFractionRange:[.086,.22]};
function frames(y=.35){return Array.from({length:41},(_,i)=>{
 const p=Array.from({length:33},()=>({x:.5,y,visibility:1,presence:1}));
 for(const [id,x,y]of [[11,.4,.4],[12,.6,.4],[23,.42,.7],[24,.58,.7],[15,.3,.2],[16,.7,.2]])p[id]={...p[id],x,y};
 return {now:i*40,width:640,height:640,landmarks:p};
});}
const rep={sampleStart:200,top:1000,bottomReference:{state:'observed'}};
test('runtime preserves the compared research mouth result and does not use following descent',()=>{
 for(const y of [.35,.145,.05]){
  const f=frames(y),expected=measureFaceHeight(f,rep.sampleStart,rep.top,wristPriorReference(measureTopProxy(f,rep.sampleStart,rep.top),prior));
  const result=assessPullupTop(f,rep,prior);assert.equal(result.state,expected.mouth.state);assert.deepEqual(result.mouth,expected.mouth);
  for(const row of f.filter(f=>f.now>rep.top))for(const i of [0,9,10])row.landmarks[i].y=.001;
  assert.deepEqual(assessPullupTop(f,rep,prior),result);
 }
});
test('missing nose does not hide a usable mouth; missing mouth and lost onset abstain',()=>{
 const f=frames();for(const row of f)row.landmarks[0].visibility=0;
 assert.equal(assessPullupTop(f,rep,prior).state,'below');
 for(const row of f)row.landmarks[9].visibility=0;
 assert.equal(assessPullupTop(f,rep,prior).state,'unavailable');
 assert.equal(assessPullupTop(frames(),{...rep,bottomReference:{state:'unavailable'}},prior).state,'unavailable');
 assert.equal(assessPullupTop(frames(),rep,null).state,'unavailable');
});
test('one hallucinated high face and an unstable initial wrist reference cannot produce a passed top',()=>{
 const f=frames();f[15].landmarks[9].y=f[15].landmarks[10].y=.001;
 assert.equal(assessPullupTop(f,rep,prior).state,'below');
 for(let i=0;i<11;i++)if(i%2)f[i].landmarks[15].y+=.2;
 assert.equal(assessPullupTop(f,rep,prior).state,'unavailable');
});
function atCadence(fps,y=.35){return frames(y).map((f,i)=>({...f,now:i*1000/fps}));}
test('10–20 processed fps can provide three real observations without a held apex',()=>{
 for(const fps of [20,15,12,10,9])for(const [y,state]of [[.35,'below'],[.05,'above']]){
  const f=atCadence(fps,y),r=assessPullupTop(f,{sampleStart:f[5].now,top:f[25].now},prior);
  assert.equal(r.state,state,`${fps} fps, y=${y}`);
  assert.ok(Math.abs(r.sampling.estimatedFps-fps)<.001);
 }
});
test('sparse sampling widens temporal uncertainty; one high point never passes the top',()=>{
 const f=atCadence(10),r={sampleStart:f[5].now,top:f[25].now};
 f[24].landmarks[9].y=f[24].landmarks[10].y=.001;
 const answer=assessPullupTop(f,r,prior);assert.notEqual(answer.state,'above');
 assert.ok(answer.mouth.temporalUncertaintyPixels>0);
});
test('extremely sparse or missing observations still abstain with an explicit reason',()=>{
 const f=atCadence(5),r=assessPullupTop(f,{sampleStart:f[5].now,top:f[25].now},prior);
 assert.equal(r.state,'unavailable');assert.equal(r.reasonCode,'low_frame_rate');assert.match(r.reason,/5 кадр\/с/);
 const missing=atCadence(10);for(const f of missing)f.landmarks[9].visibility=0;
 assert.equal(assessPullupTop(missing,{sampleStart:500,top:2500},prior).state,'unavailable');
});
