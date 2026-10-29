import test from 'node:test';import assert from 'node:assert/strict';
import {auditFaceWindow,summarizeFaceAudits} from '../research/pose-face-quality.mjs';
function frames(){return Array.from({length:6},(_,i)=>{
 const p=Array.from({length:33},()=>({x:.5,y:.2,visibility:1,presence:1}));
 for(const [id,x,y]of [[11,.4,.4],[12,.6,.4],[23,.42,.7],[24,.58,.7]])p[id]={...p[id],x,y};
 return {landmarks:p,now:800+i*40,width:500,height:500};
});}
test('head cues are independent: missing nose and mouth can use eyes without inventing a chin',()=>{
 const f=frames();for(const r of f)for(const i of [0,9,10])r.landmarks[i].visibility=.1;
 const a=auditFaceWindow(f,500,1000);
 assert.equal(a.parts.nose.available,false);assert.equal(a.parts.mouth.available,false);
 assert.equal(a.availableCue,'eyes');assert.equal(a.stableCue,'eyes');
 assert.equal(a.anyFaceAvailable,true);assert.ok(!('chin' in a));
});
test('relative jump measure is invariant to simultaneous body motion and image scale',()=>{
 const f=frames(),moving=structuredClone(f);
 moving.forEach((r,i)=>{for(const p of r.landmarks){p.x+=i*.01;p.y+=i*.02;}r.width*=2;r.height*=2;});
 for(const a of [auditFaceWindow(f,500,1000),auditFaceWindow(moving,500,1000)]){
  assert.ok(a.parts.nose.maxRelativeJump<1e-10);assert.equal(a.parts.nose.stableCandidate,true);
 }
});
test('one jump is flagged and a different cue remains available; no technique label is assigned',()=>{
 const f=frames();f[3].landmarks[0].x+=.1;
 const a=auditFaceWindow(f,500,1000);assert.equal(a.parts.nose.jumpFlag,true);
 assert.equal(a.stableCue,'mouth');assert.ok(a.parts.nose.maxJumpTimes);
 assert.ok(!('correct' in a));assert.ok(!('label' in a));
});
test('later descent does not change a top audit and temporal gaps remain missing',()=>{
 const f=frames(),a=auditFaceWindow(f,500,1000);
 assert.deepEqual(auditFaceWindow([...f,...frames().map(r=>({...r,now:r.now+1000}))],500,1000),a);
 const gap=auditFaceWindow(f.filter(r=>r.now===800||r.now>=960),500,1000);
 assert.equal(gap.windowCovered,false);assert.equal(gap.availableCue,null);
});
test('invalid phases, empty windows and absent face points have separate denominators',()=>{
 const none=frames();for(const f of none)for(let i=0;i<11;i++)f.landmarks[i].visibility=0;
 const s=summarizeFaceAudits([auditFaceWindow([],1,0),auditFaceWindow([],500,1000),auditFaceWindow(none,500,1000)]);
 assert.equal(s.windows,3);assert.equal(s.invalidPhases,1);assert.equal(s.noFrames,1);
 assert.equal(s.noFaceAtAll,1);assert.equal(s.anyCueAvailable,0);
});
