import {test} from 'node:test';
import assert from 'node:assert/strict';
import {repairIsolatedPoseOutliers} from '../research/pose-outliers.mjs';
function sequence(){
 const coordinates={11:[.35,.35],12:[.65,.35],13:[.30,.22],14:[.70,.22],15:[.30,.08],16:[.70,.08],
  23:[.40,.65],24:[.60,.65],25:[.4,.8],26:[.6,.8],27:[.4,.95],28:[.6,.95]};
 return Array.from({length:15},(_,n)=>{
  const landmarks=Array.from({length:33},(_,i)=>({x:coordinates[i]?.[0]??.5,y:coordinates[i]?.[1]??.5,z:0,visibility:1,presence:1}));
  return {now:n*40,width:640,height:640,landmarks,worldLandmarks:structuredClone(landmarks)};
 });
}
test('isolated one to three frame elbow spikes are interpolated with provenance and raw intact',()=>{
 for(const length of [1,2,3]){
  const frames=sequence();for(let i=5;i<5+length;i++)for(const key of ['landmarks','worldLandmarks']){
   frames[i][key][13].x+=.3;frames[i][key][13].y+=.25;
  }
  const snapshot=structuredClone(frames),result=repairIsolatedPoseOutliers(frames);
  assert.equal(result.corrections.length,length);assert.deepEqual(frames,snapshot);
  for(let i=5;i<5+length;i++){
   assert.equal(result.frames[i].landmarks[13].x,.3);assert.equal(result.frames[i].worldLandmarks[13].y,.22);
   assert.equal(result.frames[i].landmarks[13].visibility,1);
  }
 }
});
test('smooth rapid motion and coherent whole-skeleton jumps are not repaired as isolated errors',()=>{
 for(const abrupt of [false,true]){
  const frames=sequence();frames.forEach((f,n)=>f.landmarks.forEach(q=>q.y+=abrupt?(n===7?.3:0):.2*Math.sin(n*.7)));
  assert.equal(repairIsolatedPoseOutliers(frames).corrections.length,0);
 }
});
test('missing poses, low confidence and large timestamp gaps are not fabricated',()=>{
 for(const condition of ['missing','confidence','gap']){
  const frames=sequence();frames[7].landmarks[13].x+=.5;
  if(condition==='missing')frames[6].landmarks=null;
  if(condition==='confidence')frames[7].landmarks[13].visibility=.1;
  if(condition==='gap')frames.forEach((f,i)=>f.now=i*300);
  assert.equal(repairIsolatedPoseOutliers(frames).corrections.length,0);
 }
});
