import {test} from 'node:test';
import assert from 'node:assert/strict';
import {signedAboveLine,lineState,measureTopProxy} from '../research/pullup-top-proxy.mjs';
function frame(now,headY=.12){
 const p=Array.from({length:33},()=>({x:.5,y:.5,visibility:1,presence:1}));
 for(const i of [11,12])p[i].y=.35;
 for(const i of [23,24])p[i].y=.65;
 p[15]={...p[15],x:.3,y:.2};p[16]={...p[16],x:.7,y:.2};
 p[0].y=headY;p[9].y=p[10].y=headY+.04;
 return {now,landmarks:p,width:1000,height:1000};
}
const sample=()=>Array.from({length:31},(_,i)=>frame(i*40,i*40<700?.3:.12));
test('signed distance is invariant to endpoint ordering and handles tilted lines',()=>{
 assert.equal(signedAboveLine({x:1,y:0},{x:0,y:1},{x:2,y:1}),1);
 assert.equal(signedAboveLine({x:1,y:0},{x:2,y:1},{x:0,y:1}),1);
 assert(signedAboveLine({x:1,y:0},{x:0,y:0},{x:2,y:2})>0);
 assert.equal(lineState(1,2),'near');assert.equal(lineState(-3,2),'below');
});
test('reference and face are measured separately, without inventing chin position',()=>{
 const r=measureTopProxy(sample(),200,1000);
 assert.equal(r.state,'measured');assert.equal(r.top.nose.state,'above');assert.equal(r.top.mouth.state,'above');
 assert.equal(r.chin,undefined);assert.equal(r.reference.left.y,200);
});
test('following descent cannot change the line or apex measurements',()=>{
 const frames=sample(),first=measureTopProxy(frames,200,1000);
 for(const f of frames.filter(f=>f.now>1000)){f.landmarks[0].y=.01;f.landmarks[9].y=f.landmarks[10].y=.02;f.landmarks[15].y=.8;}
 assert.deepEqual(measureTopProxy(frames,200,1000),first);
});
test('missing face and unstable wrist reference cause abstention',()=>{
 const a=sample();for(const f of a)f.landmarks[0].visibility=0;
 assert.equal(measureTopProxy(a,200,1000).state,'unavailable');
 const b=sample();b.forEach((f,i)=>{if(i%2)f.landmarks[15].y+=.15;});
 assert.equal(measureTopProxy(b,200,1000).reason,'reference_wrists_unstable');
});
test('a nose above the line does not force a mouth above the line',()=>{
 const f=sample();for(const v of f.filter(v=>v.now>=800)){
  v.landmarks[0].y=.18;v.landmarks[9].y=v.landmarks[10].y=.23;
 }
 const r=measureTopProxy(f,200,1000);
 assert.equal(r.top.nose.state,'above');assert.equal(r.top.mouth.state,'below');
});
