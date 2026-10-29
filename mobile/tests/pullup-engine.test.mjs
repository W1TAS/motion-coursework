import test from 'node:test';
import assert from 'node:assert/strict';
import {PullupEngine,measurePullup} from '../app/pullup-engine.mjs';
// Symmetric arms with fixed wrists and constant limb lengths. Pixel square input.
function pose(degrees=165,offset=0){
 const p=Array.from({length:33},()=>({x:.5,y:.7,visibility:1,presence:1}));
 const half=degrees*Math.PI/360,arm=.12,dy=2*arm*Math.sin(half),bend=arm*Math.cos(half);
 for(const [s,e,w,h,sign] of [[11,13,15,23,-1],[12,14,16,24,1]]){
  const x=.5+sign*.09+offset;
  p[w]={x,y:.15,visibility:1,presence:1};p[s]={x,y:.15+dy,visibility:1,presence:1};
  p[e]={x:x+sign*bend,y:.15+dy/2,visibility:1,presence:1};p[h]={x,y:.15+dy+.22,visibility:1,presence:1};
 }
 return p;
}
function feed(e,angles,start=0){angles.forEach((a,i)=>e.update(a===null?null:pose(a),start+i*100,480,480));return start+angles.length*100;}
const hang=[165,165,165,165],up=[140,120,100,80,65,65],down=[80,100,120,140,165,165];
test('online count and assessment appear only after return to hang',()=>{const e=new PullupEngine();let t=feed(e,hang);t=feed(e,up,t);assert.equal(e.count,0);assert.equal(e.completed.length,0);feed(e,down,t);assert.equal(e.count,1);assert.equal(e.completed[0].amplitude,'reached');});
test('continuous repetitions count; holding and a partial first movement do not',()=>{const e=new PullupEngine();let t=feed(e,[...up,...down,...hang]);assert.equal(e.count,0);for(let i=0;i<3;i++)t=feed(e,[...up,...down],t);assert.equal(e.count,3);feed(e,Array(40).fill(165),t);assert.equal(e.count,3);});
test('one-frame top glitch and shallow movements are rejected',()=>{const e=new PullupEngine();let t=feed(e,hang);t=feed(e,[140,120,65,165,165,...hang],t);assert.equal(e.count,0);feed(e,[140,130,120,130,140,165,165],t);assert.equal(e.count,0);});
test('loss of pose or long gap cancels unfinished cycle',()=>{for(const missing of [true,false]){const e=new PullupEngine();let t=feed(e,[...hang,...up]);if(missing)t=feed(e,Array(8).fill(null),t);else t+=900;feed(e,down,t);assert.equal(e.count,0);}});
test('pause and reset cannot combine disjoint pieces of video',()=>{const e=new PullupEngine();let t=feed(e,[...hang,...up]);e.pause();t=feed(e,down,t);assert.equal(e.count,0);t=feed(e,[...hang,...up,...down],t);assert.equal(e.count,1);e.reset();assert.equal(e.count,0);assert.deepEqual(e.completed,[]);});
test('backwards and repeated timestamps never add counts',()=>{const e=new PullupEngine();feed(e,[...hang,...up,...down]);const n=e.count;for(let i=0;i<10;i++)feed(e,[...up,...down],0);assert.equal(e.count,n);});
test('wrist displacement and missing arm confidence reject the cycle',()=>{for(const bad of ['move','confidence']){const e=new PullupEngine();let t=feed(e,hang);for(const a of up){const p=pose(a,bad==='move'?.2:0);if(bad==='confidence')p[15].visibility=p[16].visibility=0;e.update(p,t,480,480);t+=100;}feed(e,down,t);assert.equal(e.count,0);}});
test('horizontal body and hands below shoulders fail posture check',()=>{let p=pose();for(const i of [23,24])p[i].y=.2;assert.equal(measurePullup(p,480,480).valid,false);p=pose();for(const i of [15,16])p[i].y=.8;assert.equal(measurePullup(p,480,480).valid,false);});
test('horizontal mirror preserves cycle and result',()=>{const e=new PullupEngine();[...hang,...up,...down].forEach((a,i)=>e.update(pose(a).map(p=>({...p,x:1-p.x})),i*100,480,480));assert.equal(e.count,1);});
