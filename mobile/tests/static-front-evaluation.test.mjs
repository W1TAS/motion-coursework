import test from 'node:test';
import assert from 'node:assert/strict';
import {screenScenes,binaryMetrics,heightTable,legacyPrediction} from '../research/evaluate-static-front.mjs';

test('camera unknown, rear and large oblique scenes cannot enter a strict subset',()=>{
 const pairs=[['near_static','front',true],['near_static','front_oblique',true],
  ['unknown','front',false],['moving','front',false],['near_static','back',false],['near_static','large_oblique',false]];
 const evidence={scenes:pairs.map(([camera],i)=>({id:String(i),camera:{state:camera},imageSha256:String(i),samples:[{uid:'rep'+i}]}))};
 const views={rows:pairs.map(([,view],i)=>({scene:String(i),view,reviewedImageSha256:String(i),allReviewedStartsAndTopsChecked:true}))};
 assert.deepEqual(screenScenes(evidence,views).map(r=>r.accepted),pairs.map(r=>r[2]));
});
test('unknown labels and unmeasured or unmatched attempts are never silently scored as normal',()=>{
 const rows=[{y:1,p:{state:'measured',predictedError:true}},{y:0,p:{state:'measured',predictedError:false}},
  {y:null,p:{state:'measured',predictedError:false}},{y:1,p:{state:'unmatched'}},{y:0,p:{state:'unavailable'}}];
 const r=binaryMetrics(rows,r=>r.y,r=>r.p);
 assert.equal(r.total,5);assert.equal(r.known,4);assert.equal(r.unknownLabel,1);
 assert.equal(r.scored,2);assert.equal(r.TP,1);assert.equal(r.TN,1);assert.equal(r.FN,0);
 assert.equal(r.unmatched,1);assert.equal(r.unavailable,1);
});
test('upper uncertainty and missing observations remain separate from above and below',()=>{
 const rows=['above','uncertain','unavailable','below'].map(state=>({labels:{top_below_bar:0},cue:{mouth:{state}}}));
 assert.deepEqual(heightTable(rows,'cue').normal,{below:1,above:1,uncertain:1,unavailable:1});
});
test('classifier not_detected is a measured negative, distinct from unavailable and unmatched',()=>{
 for(const state of ['flagged','not_detected','unavailable']){
  const r=legacyPrediction({legacy:{deployed:{targets:{partial:{state}}}}},'deployed','partial');
  assert.equal(r.state,state==='unavailable'?'unavailable':'measured');
  if(state!=='unavailable')assert.equal(r.predictedError,state==='flagged');
 }
 assert.equal(legacyPrediction({legacy:null},'deployed','partial').state,'unmatched');
});
