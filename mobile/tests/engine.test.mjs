import test from 'node:test';import assert from 'node:assert/strict';
import {ExerciseEngine,examplePose,measurePose,angle} from '../app/engine.mjs';
const update=(e,a,t)=>e.update(examplePose(a),t,480,480);
function frames(e,a,start,n=6){for(let i=0;i<n;i++)update(e,a,start+i*100);return start+n*100;}
function rep(e,start=0){let t=frames(e,170,start);t=frames(e,130,t,3);t=frames(e,80,t);t=frames(e,130,t,3);return frames(e,170,t);}
test('angles use pixel aspect ratio and degenerate joints fail closed',()=>{assert.equal(angle({x:0,y:1},{x:0,y:0},{x:1,y:0}),90);assert.ok(Number.isNaN(angle({x:0,y:0},{x:0,y:0},{x:1,y:0})));const p=examplePose(90);p.forEach(v=>v.x*=.75);assert.ok(Math.abs(measurePose(p,640,480).elbow-90)<1e-6);});
test('two complete cycles count twice, holding at the top adds nothing',()=>{const e=new ExerciseEngine();const t=rep(e);rep(e,t);frames(e,170,t+2400,20);assert.equal(e.count,2);});
test('starting at the bottom cannot count a first partial repetition',()=>{const e=new ExerciseEngine();let t=frames(e,80,0,10);frames(e,170,t);assert.equal(e.count,0);rep(e,t+600);assert.equal(e.count,1);});
test('incomplete descent never counts',()=>{const e=new ExerciseEngine();let t=frames(e,170,0);t=frames(e,120,t,10);frames(e,170,t);assert.equal(e.count,0);});
test('single-frame angle noise cannot complete a repetition',()=>{const e=new ExerciseEngine();frames(e,170,0);update(e,80,600);frames(e,170,700);assert.equal(e.count,0);});
test('missing landmarks discard the unfinished cycle',()=>{const e=new ExerciseEngine();let t=frames(e,170,0);t=frames(e,80,t);e.update(null,t,480,480);frames(e,170,t+100);assert.equal(e.count,0);});
test('pause and long gaps discard the unfinished cycle',()=>{for(const pause of [true,false]){const e=new ExerciseEngine();let t=frames(e,170,0);t=frames(e,80,t);if(pause)e.pause();frames(e,170,t+2000);assert.equal(e.count,0);}});
test('upright or bent-body poses are rejected',()=>{const p=examplePose(170);for(const i of [23,24,25,26,27,28]){p[i].x=.2;p[i].y=.75;}assert.equal(measurePose(p,480,480).valid,false);const b=examplePose(90);b[23].y=b[24].y=.12;assert.equal(measurePose(b,480,480).straight,false);});
test('uncertain or out-of-frame joints do not provide a valid pose',()=>{for(const key of ['visibility','x']){const p=examplePose(170);p[15][key]=p[16][key]=0;assert.equal(measurePose(p,480,480).valid,false);}});
test('plank confirms for 600ms; missing frames, pause and return add no time',()=>{
 const e=new ExerciseEngine('plank'),p=examplePose(90,true);
 for(let t=0;t<=1000;t+=100)e.update(p,t,480,480);
 assert.ok(Math.abs(e.seconds-.4)<1e-8);
 e.update(null,1100,480,480);
 for(let t=1200;t<=1800;t+=100)e.update(p,t,480,480);
 assert.ok(Math.abs(e.seconds-.4)<1e-8);
 e.update(p,1900,480,480);assert.ok(Math.abs(e.seconds-.5)<1e-8);
 e.pause();e.update(p,10000,480,480);assert.ok(Math.abs(e.seconds-.5)<1e-8);
});
test('straight-arm holds do not count as forearm plank',()=>{const e=new ExerciseEngine('plank');for(let t=0;t<2000;t+=100)update(e,170,t);assert.equal(e.seconds,0);});
test('switching visible sides mid-cycle resets it',()=>{const e=new ExerciseEngine();frames(e,170,0);frames(e,80,600);for(let t=1200;t<1800;t+=100){const p=examplePose(170);for(const i of [11,13,15,23,25,27])p[i].visibility=.1;e.update(p,t,480,480);}assert.equal(e.count,0);});

function held(p){const e=new ExerciseEngine('plank');for(let t=0;t<=2000;t+=100)e.update(p,t,480,480);return e;}
test('lying flat with bent arms cannot start the plank timer',()=>{
 const p=examplePose(90,true);
 for(const ids of [[11,13,15,23,25,27],[12,14,16,24,26,28]]){
  const [s,e,w,h,k,a]=ids;p[s].y=.6;p[e]={...p[e],x:.2,y:.65};p[w]={...p[w],x:.07,y:.65};p[h].y=.61;p[k].y=.62;p[a].y=.63;
 }
 assert.equal(measurePose(p,480,480).straight,true);assert.equal(held(p).seconds,0);
});
test('propped shoulders with pelvis resting at support level are rejected',()=>{
 const p=examplePose(90,true);for(const i of [11,12])p[i].y=.48;for(const i of [13,14,15,16])p[i].y=.60;for(const i of [23,24,25,26,27,28])p[i].y=.54;
 assert.equal(measurePose(p,480,480).straight,true);assert.equal(held(p).seconds,0);
});
test('dropping torso stops time immediately and requires new confirmation',()=>{
 const e=held(examplePose(90,true)),before=e.seconds;
 const low=examplePose(90,true);for(const i of [11,12,23,24,25,26,27,28])low[i].y=.58;
 e.update(low,2100,480,480);assert.equal(e.seconds,before);
 for(let t=2200;t<=2800;t+=100)e.update(examplePose(90,true),t,480,480);
 assert.equal(e.seconds,before);
});
test('plank decision survives horizontal mirror, translation and scale',()=>{
 for(const mirror of [false,true])for(const scale of [.7,1]){
  const p=examplePose(90,true).map(v=>({...v,x:(mirror?1-v.x:v.x)*scale+.05,y:v.y*scale+.05}));
  assert.ok(held(p).seconds>1);
 }
});
test('short isolated suitable poses cannot accumulate plank time',()=>{
 const e=new ExerciseEngine('plank');for(let t=0;t<4000;t+=100)e.update(t%500===400?null:examplePose(90,true),t,480,480);
 assert.equal(e.seconds,0);
});

test('continuous fast cycles count without holding at either extreme',()=>{
 for(const fps of [10,15,30]){
  const e=new ExerciseEngine();let t=0;
  for(;t<400;t+=1000/fps)update(e,170,t);
  const start=t,period=800;
  for(;t<=start+period*5+300;t+=1000/fps){const elapsed=Math.min(t-start,period*5),a=125+45*Math.cos(2*Math.PI*elapsed/period);update(e,a,t);}
  assert.equal(e.count,5,`fps=${fps}`);
 }
});
test('single-frame bottom spikes never count even when repeated',()=>{
 const e=new ExerciseEngine();for(let t=0;t<5000;t+=50)update(e,t%500===250?80:170,t);assert.equal(e.count,0);
});
test('a very short cycle cannot be revived by a later top hold',()=>{
 const e=new ExerciseEngine();for(const [t,a]of [[0,170],[50,170],[100,130],[150,80],[200,130],[250,150],[300,170]])update(e,a,t);
 for(let t=350;t<1500;t+=50)update(e,170,t);assert.equal(e.count,0);
});
test('fast incomplete cycles still do not count',()=>{
 const e=new ExerciseEngine();for(let t=0;t<5000;t+=50)update(e,145+25*Math.cos(t/800*2*Math.PI),t);assert.equal(e.count,0);
});
