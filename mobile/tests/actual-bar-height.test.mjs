import test from 'node:test';import assert from 'node:assert/strict';
import {actualBarReference,wristPriorReference,measureFaceHeight} from '../research/actual-bar-height.mjs';
function calibration(){return {status:'proposed',width:640,height:640,readingUncertaintyPixels:3,
 initial:{a:[100,128],b:[540,128]},validation:[{a:[100,128],b:[540,128]},{a:[100,128],b:[540,128]}]};}
function frames(y=.3){return Array.from({length:31},(_,i)=>{
 const p=Array.from({length:33},()=>({x:.5,y,visibility:1,presence:1}));
 for(const [id,x,y]of [[11,.4,.4],[12,.6,.4],[23,.42,.7],[24,.58,.7],[15,.3,.2],[16,.7,.2]])p[id]={...p[id],x,y};
 return {now:i*40,width:640,height:640,landmarks:p};
});}
test('fixed calibration rejects camera motion and ambiguous bars, not merely bad wrists',()=>{
 assert.equal(actualBarReference(calibration()).state,'ready');
 const moving=calibration();moving.validation[1].a[1]+=20;moving.validation[1].b[1]+=20;
 assert.equal(actualBarReference(moving).reason,'bar_moves_in_image');
 assert.equal(actualBarReference({status:'ambiguous',reason:'occlusion'}).reason,'occlusion');
});
test('actual bar measurement is independent of all wrist positions and confidences',()=>{
 const f=frames(),reference=actualBarReference(calibration()),before=measureFaceHeight(f,200,1000,reference);
 for(const r of f)for(const i of [15,16])r.landmarks[i]={x:99,y:-3,visibility:0,presence:0};
 assert.deepEqual(measureFaceHeight(f,200,1000,reference),before);assert.equal(before.mouth.state,'below');
});
test('mouth remains measurable without the nose; no chin or correct-repetition verdict is invented',()=>{
 const f=frames();for(const r of f)r.landmarks[0].visibility=0;
 const r=measureFaceHeight(f,200,1000,actualBarReference(calibration()));
 assert.equal(r.nose.state,'unavailable');assert.equal(r.mouth.state,'below');assert.equal(r.chin,undefined);assert.equal(r.correct,undefined);
});
test('a single high point and later descent cannot create a sustained peak',()=>{
 const f=frames();f[15].landmarks[9].y=f[15].landmarks[10].y=.01;
 const reference=actualBarReference(calibration()),r=measureFaceHeight(f,200,1000,reference);
 assert.equal(r.mouth.state,'below');
 for(const p of f.filter(p=>p.now>1000))for(const i of [0,9,10])p.landmarks[i].y=.001;
 assert.deepEqual(measureFaceHeight(f,200,1000,reference),r);
});
test('image scaling and endpoint order preserve the state; a near mouth remains uncertain',()=>{
 const f=frames(.2),ref=actualBarReference(calibration());
 assert.equal(measureFaceHeight(f,200,1000,ref).mouth.state,'uncertain');
 const large=f.map(r=>({...r,width:1280,height:1280}));
 assert.equal(measureFaceHeight(large,200,1000,ref).mouth.state,'uncertain');
 const flipped={...ref,a:ref.b,b:ref.a};assert.deepEqual(measureFaceHeight(f,200,1000,flipped),measureFaceHeight(f,200,1000,ref));
});
test('the controlled wrist prior keeps initial-reference failures separate',()=>{
 const prior={empiricalFractionRange:[.1,.2]};
 assert.equal(wristPriorReference({reason:'reference_wrists_unstable',reference:{}},prior).state,'unavailable');
 assert.equal(wristPriorReference({state:'unavailable',reason:'top_face_or_wrists_unavailable',
  reference:{width:640,height:640,left:{x:100,y:128},right:{x:540,y:128},torsoPixels:200}},prior).state,'ready');
});
test('a truncated ascent cannot claim coverage merely because its remaining frames are good',()=>{
 const f=frames().filter(r=>r.now>=800);
 assert.equal(measureFaceHeight(f,200,1000,actualBarReference(calibration())).reason,'incomplete_ascent_window');
});
