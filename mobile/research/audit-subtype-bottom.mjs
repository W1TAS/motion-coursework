// Fixed-rule diagnostic on screened subtype labels, never a training/test score.
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {measurePullup, PULLUP_RULES} from '../app/pullup-engine.mjs';

const base='pullups/dataset_mediapipe_gpu',dir=base+'/human-reviews';
const bytes=fs.readFileSync(dir+'/criterion-labels.json'),reviews=JSON.parse(bytes);
const context=JSON.parse(fs.readFileSync(dir+'/partial-subtypes-screening-context.json'));
const metadata=new Map(JSON.parse(fs.readFileSync(base+'/ascent-v1/manifest.json')).rows.map(r=>[r.uid,r]));
const sources=new Map();
for(const job of JSON.parse(fs.readFileSync(base+'/manifest.json')).jobs)
 for(const sample of job.samples)sources.set(sample.uid,{job,sample});
const cache=new Map(),rows=[];
const median=a=>{const s=a.slice().sort((a,b)=>a-b),mid=Math.floor(s.length/2);return s.length%2?s[mid]:(s[mid-1]+s[mid])/2;};
const measure=f=>{const m=measurePullup(f.landmarks,f.width,f.height);return m.valid&&m.arms===2?m.elbow:null;};
for(const review of reviews.rows){
 if(review.input_screening?.source_sha256!==context.source_sha256)continue;
 const {job,sample}=sources.get(review.uid),phase=metadata.get(review.uid);
 assert.notEqual(sample.split,'test');assert.equal(review.group,sample.group);
 if(!cache.has(job.id)){
  const raw=fs.readFileSync(base+'/poses/'+job.id+'.json.gz'),data=JSON.parse(zlib.gunzipSync(raw));
  assert.equal(data.fingerprint,job.fingerprint);
  cache.set(job.id,{frames:data.frames,sha256:crypto.createHash('sha256').update(raw).digest('hex')});
 }
 const {frames,sha256}=cache.get(job.id),start=phase.start,top=phase.top,end=phase.full_end;
 assert(start<top&&top<end);
 // Same unconfirmed start shown in this subtype packet. Do not relabel it human.
 const local=frames.filter(f=>f.now/1000>=start-.12-1e-6&&f.now/1000<=Math.min(start+.12,top)+1e-6);
 const valid=local.map(measure).filter(Number.isFinite);
 const covered=local.length>=3&&local[0].now/1000<=start+.04&&local.at(-1).now/1000>=start-.04;
 const initial=covered&&valid.length>=3&&valid.length/local.length>=.8?median(valid):null;
 const cycle=frames.filter(f=>f.now/1000>=start-1e-6&&f.now/1000<=end+1e-6);
 const cycleAngles=cycle.map(measure).filter(Number.isFinite);
 const full=cycleAngles.length>=6&&cycleAngles.length/cycle.length>=.8?Math.max(...cycleAngles):null;
 const ascent=cycle.filter(f=>f.now/1000<=top+1e-6),ascentAngles=ascent.map(measure).filter(Number.isFinite);
 const ascentMax=ascentAngles.length>=6&&ascentAngles.length/ascent.length>=.8?Math.max(...ascentAngles):null;
 rows.push({uid:review.uid,group:review.group,split:review.split,label:review.targets.bottom_incomplete,
  initialMedian2d:initial,ascentMax2d:ascentMax,fullCycleMax2d:full,phaseOrigin:'legacy_automatic_not_human',
  phase:{bottom:start,top,fullEnd:end},initialQuality:{frames:local.length,bothArmsValid:valid.length},rawCacheSha256:sha256});
}
assert.equal(rows.length,51);
const cutoff=PULLUP_RULES.fullExtension;
function summarize(selected,key){
 const usable=selected.filter(r=>Number.isFinite(r[key])),out={total:selected.length,available:usable.length,unavailable:selected.length-usable.length,TP:0,FN:0,FP:0,TN:0};
 for(const r of usable){assert([0,1].includes(r.label));const predicted=r[key]<cutoff;out[r.label?(predicted?'TP':'FN'):(predicted?'FP':'TN')]++;}
 out.positiveGroups=[...new Set(usable.filter(r=>r.label===1).map(r=>r.group))].length;
 out.negativeGroups=[...new Set(usable.filter(r=>r.label===0).map(r=>r.group))].length;
 return out;
}
const paired=rows.filter(r=>Number.isFinite(r.initialMedian2d)&&Number.isFinite(r.fullCycleMax2d)&&Number.isFinite(r.ascentMax2d));
const groups=[...new Set(rows.map(r=>r.group))].sort();
const report={schema:1,reviewSha256:crypto.createHash('sha256').update(bytes).digest('hex'),screeningSourceSha256:context.source_sha256,
 protocol:'Same screened clips and fixed 150-degree reference. Initial median uses raw 2D pose within ±120ms of the proposed bottom, before this top. Full-cycle maximum is a diagnostic reference including the following descent, not the deployed model output.',
 thresholdDegrees:cutoff,groups:groups.length,
 initial:summarize(rows,'initialMedian2d'),fullCycle:summarize(rows,'fullCycleMax2d'),ascentMax:summarize(rows,'ascentMax2d'),
 paired:{initial:summarize(paired,'initialMedian2d'),ascentMax:summarize(paired,'ascentMax2d'),fullCycle:summarize(paired,'fullCycleMax2d')},
 pairedRescues:{descentOnly:paired.filter(r=>r.label===1&&r.initialMedian2d<cutoff&&r.ascentMax2d<cutoff&&r.fullCycleMax2d>=cutoff).length,
  laterWithinAscent:paired.filter(r=>r.label===1&&r.initialMedian2d<cutoff&&r.ascentMax2d>=cutoff).length},
 byGroup:groups.map(group=>({group,initial:summarize(rows.filter(r=>r.group===group),'initialMedian2d'),fullCycle:summarize(rows.filter(r=>r.group===group),'fullCycleMax2d')})),
 limitations:['Targeted partial-positive development examples, not a representative or independent test.',
 '42 of 51 clips share one source channel; clip counts overstate independent evidence.',
 'Phase timestamps remain automatic. The initial local window may miss the actual initial bottom.',
 'Two visible arms and short-window coverage do not prove a correct skeleton or identity.',
 '2D projected angles depend on the view; no metric 3D data are present in these original caches.',
 'No threshold selected, classifier trained or application model replaced on these answers.'],rows};
fs.writeFileSync(dir+'/subtype-bottom-audit.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({groups:report.groups,initial:report.initial,fullCycle:report.fullCycle,paired:report.paired,pairedRescues:report.pairedRescues},null,2));
