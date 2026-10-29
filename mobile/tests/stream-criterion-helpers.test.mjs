import test from 'node:test';
import assert from 'node:assert/strict';
import {matchEvents,scaledFaceState} from '../research/stream-criterion-helpers.mjs';

test('matching maximizes cardinality before nearest timing and never reuses a detection',()=>{
 const refs=[{bottom:0,top:1000},{bottom:200,top:1200}],reps=[{sampleStart:-200,top:800},{sampleStart:40,top:1040}];
 assert.deepEqual(matchEvents(refs,reps,{bottomMs:250,topMs:250}),[[0,0],[1,1]]);
 assert.equal(matchEvents(refs,[reps[1]]).length,1);
 assert.deepEqual(matchEvents([],reps),[]);
});
test('matching requires both the initial point and top within declared tolerance',()=>{
 assert.deepEqual(matchEvents([{bottom:0,top:1000}],[{sampleStart:600,top:1000}]),[]);
 assert.deepEqual(matchEvents([{bottom:0,top:1000}],[{sampleStart:0,top:1401}]),[]);
});
test('normalized offset is resolution invariant and abstains across plausible offsets',()=>{
 const prior={torsoFraction:.16,empiricalFractionRange:[.09,.22]};
 for(const scale of [1,3]){
  const m=c=>({state:'measured',reference:{torsoPixels:100*scale,tolerancePixels:4*scale},top:{mouth:{clearancePixels:c*scale}}});
  assert.equal(scaledFaceState(m(0),prior).state,'below');
  assert.equal(scaledFaceState(m(16),prior).state,'uncertain');
  assert.equal(scaledFaceState(m(30),prior).state,'above');
  assert.equal(scaledFaceState({state:'unavailable'},prior).state,'unavailable');
 }
});
