// Development-only streaming diagnostic. No labels or phase times enter engines.
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {PullupPhaseEngine as Baseline} from './baseline-phases-0.1.9.mjs';
import {PullupPhaseEngine} from '../app/pullup-phases.mjs';
import {measureAutomaticBottom} from '../app/pullup-bottom.mjs';
import {initialBottom2D,matchEvents} from './stream-criterion-helpers.mjs';

const args=process.argv.slice(2);assert(args.length===0||args.length===2&&args[0]==='--out');
const version=args[1]??'stream-bottom-quality-v1';assert(/^[a-z0-9-]+$/.test(version));
const base='pullups/dataset_mediapipe_gpu',out=base+'/human-reviews/'+version;
const read=p=>JSON.parse(fs.readFileSync(p)),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const raw=fs.readFileSync(base+'/human-reviews/criterion-labels.json'),reviews=JSON.parse(raw);
const skipped=new Set(reviews.skipped.map(r=>r.uid));
const eligible=new Map(reviews.rows.filter(r=>!skipped.has(r.uid)&&r.split!=='test'&&
 (r.input_screening?.result==='accepted'||(['front','front_oblique'].includes(r.facing)&&r.pose_quality==='usable'))).map(r=>[r.uid,r]));
const phases=new Map(read(base+'/ascent-v1/manifest.json').rows.map(r=>[r.uid,r]));
const protocol={schema:1,reviewSha256:sha(raw),testUsed:false,
 input:'Full chronological original pose caches for strictly screened development examples. No cuts or reference times passed to detectors.',
 matching:'Ordered one-to-one top ±400ms, with no bottom constraint, so onset mistakes remain in classification.',
 bottom:'Fixed 150-degree 2D diagnostic, both arms. New app measurement searches robust initial medians only, within the current tracking/ascent context. No 3D fabricated.',
 gate:'After interruption, a settled mid-ascent pose does not establish the original bottom. An observed descent-to-ascent turn or return restores eligibility.',
 limitations:['Targeted correlated development subset; not overall accuracy.',
 'Original caches lack world landmarks: app 3D decisions are not validated by this 2D diagnostic.',
 'Most reference tops are automatic. Additional unmatched events lack full human labels.'],
 sourceSha256:Object.fromEntries(['mobile/app/pullup-phases.mjs','mobile/app/pullup-bottom.mjs','mobile/research/baseline-phases-0.1.9.mjs','mobile/research/stream-criterion-helpers.mjs','mobile/research/evaluate-ascent-bottom.mjs'].map(p=>[p,sha(fs.readFileSync(p))]))};
if(fs.existsSync(out+'/protocol.json'))assert.deepEqual(read(out+'/protocol.json'),protocol,'Use a new output version.');
const rows=[],streams=[];
for(const job of read(base+'/manifest.json').jobs){
 const samples=job.samples.filter(s=>eligible.has(s.uid));if(!samples.length)continue;
 assert(job.samples.every(s=>s.split!=='test'));
 const bytes=fs.readFileSync(base+'/poses/'+job.id+'.json.gz'),cache=JSON.parse(zlib.gunzipSync(bytes));
 assert.equal(cache.fingerprint,job.fingerprint);
 const baseline=new Baseline(),engine=new PullupPhaseEngine(),events=[];
 for(const f of cache.frames){
  baseline.update(f.landmarks,f.now,f.width,f.height);
  const before=engine.ascents.length;engine.update(f.landmarks,f.now,f.width,f.height);
  for(const event of engine.ascents.slice(before)){
   const prefix=cache.frames.filter(p=>p.now<=f.now);
   const unrestricted={...event,bottomReference:{...event.bottomReference,state:'observed'}};
   events.push({...event,raw:initialBottom2D(prefix,event.sampleStart,event.top),
    recovered:measureAutomaticBottom(prefix,unrestricted),measured:measureAutomaticBottom(prefix,event)});
  }
 }
 // Adding an event/quality flag must never change the legacy full-cycle stream.
 const projection=engine.completed.map(({ascentIndex,contextStart,bottomReference,...r})=>r);
 assert.deepEqual(projection,baseline.completed,`Full-cycle regression: ${job.id}`);
 const refs=samples.map(s=>({bottom:phases.get(s.uid).start*1000,top:phases.get(s.uid).top*1000}));
 const topMatches=new Map(matchEvents(refs,events,{bottomMs:Infinity,topMs:400}));
 const strict=matchEvents(refs,events);
 for(let i=0;i<samples.length;i++){
  const sample=samples[i],review=eligible.get(sample.uid),event=topMatches.has(i)?events[topMatches.get(i)]:null;
  assert.equal(review.group,sample.group);assert([0,1].includes(review.targets.bottom_incomplete));
  rows.push({uid:sample.uid,group:sample.group,label:review.targets.bottom_incomplete,jobId:job.id,
   reference:{...refs[i],origin:'legacy_automatic_not_human'},event,rawCacheSha256:sha(bytes)});
 }
 streams.push({id:job.id,frames:cache.frames.length,fullCycles:engine.count,ascents:events.length,
  reviewed:samples.length,matchedTop:topMatches.size,matchedBoth:strict.length,rawCacheSha256:sha(bytes)});
}
function metrics(subset,field){
 const m={total:subset.length,TP:0,FN:0,FP:0,TN:0,unmatched:0,poseUnavailable:0,onsetLost:0};
 for(const r of subset){
  if(!r.event){m.unmatched++;continue;}
  const value=r.event[field];
  if(value.state!=='measured'){
   if(field==='measured'&&r.event.bottomReference.state==='unavailable')m.onsetLost++;
   else m.poseUnavailable++;
   continue;
  }
  const angle=field==='raw'?value.angle:value.angle2d;
  m[r.label?(angle<150?'TP':'FN'):(angle<150?'FP':'TN')]++;
 }
 return m;
}
assert.equal(rows.length,eligible.size);
const groups=[...new Set(rows.map(r=>r.group))],largest=groups.sort((a,b)=>rows.filter(r=>r.group===b).length-rows.filter(r=>r.group===a).length)[0];
const summary={reviewed:rows.length,groups:groups.length,streams:streams.length,
 fullCycles:streams.reduce((n,s)=>n+s.fullCycles,0),ascents:streams.reduce((n,s)=>n+s.ascents,0),
 matchedTop:streams.reduce((n,s)=>n+s.matchedTop,0),matchedBoth:streams.reduce((n,s)=>n+s.matchedBoth,0),
 raw:metrics(rows,'raw'),recovered:metrics(rows,'recovered'),measured:metrics(rows,'measured'),
 falsePositives:rows.filter(r=>r.event?.measured.state==='measured'&&r.event.measured.angle2d<150&&!r.label).map(r=>r.uid),
 withoutLargest:{excluded:largest,measured:metrics(rows.filter(r=>r.group!==largest),'measured')},
 onsetLossByClass:{error:rows.filter(r=>r.label&&r.event?.bottomReference.state==='unavailable').length,
 normal:rows.filter(r=>!r.label&&r.event?.bottomReference.state==='unavailable').length}};
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(out+'/protocol.json',JSON.stringify(protocol,null,2)+'\n');
fs.writeFileSync(out+'/results.json',JSON.stringify({summary,streams,rows},null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
