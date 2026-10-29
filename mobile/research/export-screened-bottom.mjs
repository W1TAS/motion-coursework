// Identical automatic phase protocol for all reviewed, screened development clips.
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {measurePullup} from '../app/pullup-engine.mjs';

const base='pullups/dataset_mediapipe_gpu',out=base+'/human-reviews/bottom-baseline-v1';
const raw=fs.readFileSync(base+'/human-reviews/criterion-labels.json'),review=JSON.parse(raw);
const reviewed=new Map(review.rows.map(r=>[r.uid,r])),skipped=new Map(review.skipped.map(r=>[r.uid,r]));
const phases=new Map(JSON.parse(fs.readFileSync(base+'/ascent-v1/manifest.json')).rows.map(r=>[r.uid,r]));
const manifest=JSON.parse(fs.readFileSync(base+'/manifest.json'));
const gate=[],rows=[],coverage={};
function eligibility(sample){
 if(sample.split==='test')return 'reserved_test';
 if(skipped.has(sample.uid))return 'human_excluded';
 const r=reviewed.get(sample.uid);
 if(!r)return 'not_reviewed';
 if(r.input_screening?.result==='accepted'||(['front','front_oblique'].includes(r.facing)&&r.pose_quality==='usable'))return 'accepted';
 return 'review_not_eligible_for_strict_subset';
}
const quantile=(a,q)=>{const s=a.slice().sort((a,b)=>a-b),p=(s.length-1)*q;return s[Math.floor(p)]+(s[Math.ceil(p)]-s[Math.floor(p)])*(p%1);};
for(const job of manifest.jobs){
 let cache;
 for(const sample of job.samples){
  const status=eligibility(sample),r=reviewed.get(sample.uid);
  gate.push({uid:sample.uid,group:sample.group,split:sample.split,status,
   humanFacing:r?.facing??null,humanPoseQuality:r?.pose_quality??null,
   exclusion:skipped.get(sample.uid)??null});
  coverage[status]=(coverage[status]??0)+1;
  if(status!=='accepted')continue;
  assert.notEqual(sample.split,'test');assert.equal(r.group,sample.group);
  if(!cache){
   const bytes=fs.readFileSync(base+'/poses/'+job.id+'.json.gz');
   cache=JSON.parse(zlib.gunzipSync(bytes));assert.equal(cache.fingerprint,job.fingerprint);
   cache.sha256=crypto.createHash('sha256').update(bytes).digest('hex');
  }
  const phase=phases.get(sample.uid),start=phase.start,top=phase.top;
  assert(start<top);
  const local=cache.frames.filter(f=>f.now/1000>=start-.12-1e-6&&f.now/1000<=Math.min(top,start+.12)+1e-6);
  const angles=local.map(f=>measurePullup(f.landmarks,f.width,f.height)).filter(m=>m.valid&&m.arms===2).map(m=>m.elbow);
  const covered=local.length>=3&&local[0].now/1000<=start+.04&&local.at(-1).now/1000>=start-.04;
  const available=covered&&angles.length>=3&&angles.length/local.length>=.8;
  rows.push({uid:sample.uid,group:sample.group,split:sample.split,label:r.targets.bottom_incomplete,
   status:available?'available':'pose_unavailable',features:available?[quantile(angles,.5),quantile(angles,.1),quantile(angles,.9)]:null,
   quality:{frames:local.length,bothArmsValid:angles.length},
   phase:{bottom:start,top,origin:'legacy_automatic_not_human'},
   humanBottomOffsetMs:Number.isFinite(r.phase_times?.bottom)?(r.phase_times.bottom-start)*1000:null,
   rawCacheSha256:cache.sha256});
 }
}
assert.equal(rows.length,62);assert(rows.every(r=>[0,1].includes(r.label)));
const provenance={reviewSha256:crypto.createHash('sha256').update(raw).digest('hex'),testUsed:false};
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(out+'/eligibility.json',JSON.stringify({schema:1,...provenance,coverage,rows:gate,
 note:'Eligibility for a strict experimental subset only. No source video, old label or split deleted/modified. Old automatic facing never treated as human-confirmed.'},null,2)+'\n');
fs.writeFileSync(out+'/inputs.json',JSON.stringify({schema:1,...provenance,features:['initial_median_2d','initial_p10_2d','initial_p90_2d'],
 protocol:'Raw original 2D poses, both arms, initial ±120ms before this top; same automatic phase protocol for all clips. Human times are diagnostic metadata only, never inputs.',rows},null,2)+'\n');
console.log(JSON.stringify({coverage,strict:rows.length,available:rows.filter(r=>r.status==='available').length,groups:new Set(rows.map(r=>r.group)).size},null,2));
