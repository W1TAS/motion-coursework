// Run from repository root. Frozen development diagnostic, not a test-set score.
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {PullupPhaseEngine,PHASE_RULES} from '../app/pullup-phases.mjs';
import {TOP_PROXY_PROTOCOL,measureTopProxy} from './pullup-top-proxy.mjs';
import {initialBottom2D,matchEvents,scaledFaceState} from './stream-criterion-helpers.mjs';

assert(process.argv.slice(2).every(a=>a==='--ascent-events'),'Only --ascent-events is supported');
const ascentEvents=process.argv.includes('--ascent-events');
const base='pullups/dataset_mediapipe_gpu',out=base+'/human-reviews/'+(ascentEvents?'stream-ascent-v1':'stream-criteria-v1');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const read=path=>JSON.parse(fs.readFileSync(path));
const raw=fs.readFileSync(base+'/human-reviews/criterion-labels.json'),reviews=JSON.parse(raw);
const excluded=new Set(reviews.skipped.map(r=>r.uid));
const eligible=reviews.rows.filter(r=>!excluded.has(r.uid)&&r.split!=='test'&&
 (r.input_screening?.result==='accepted'||(['front','front_oblique'].includes(r.facing)&&r.pose_quality==='usable')));
const selected=new Map(eligible.map(r=>[r.uid,r]));
const metadata=new Map(read(base+'/ascent-v1/manifest.json').rows.map(r=>[r.uid,r]));
const jobs=read(base+'/manifest.json').jobs.filter(j=>j.samples.some(s=>selected.has(s.uid)));
const prior=read(base+'/human-reviews/top-proxy-v1/bar-offset-audit-v1/torso-prior.json');
const protocol={schema:1,reviewSha256:sha(raw),testUsed:false,
 input:'All chronological original 2D pose frames of each selected development job, without cutting at reference phases. These jobs are selected for reviewed examples, not random unseen recordings.',
 matching:{method:'Ordered one-to-one maximum cardinality, then minimum absolute timing error; labels never used.',bottomMs:500,topMs:400},
 prepared:'Legacy automatic bottom/top for every example; human times evaluated separately on their available subset.',
 bottom:'Both arms, median initial ±120ms, >=3 valid frames, >=80% coverage, fixed 150 degrees.',
 phaseRules:PHASE_RULES,topProxy:TOP_PROXY_PROTOCOL,barPrior:prior,
 topScope:'Facial proxy, not chin; fixed nine-scene geometry prior, no label fitting. Empirical offset range is not a confidence interval. Some geometry calibration scenes overlap this development subset.',
 runtimeLimit:'Original caches have no world landmarks. This does not validate the app 3D bottom branch or live-camera pose inference.',
 sourceSha256:Object.fromEntries(['mobile/app/pullup-phases.mjs','mobile/app/pullup-engine.mjs','mobile/research/pullup-top-proxy.mjs','mobile/research/stream-criterion-helpers.mjs'].map(p=>[p,sha(fs.readFileSync(p))]))};
if(ascentEvents){
 protocol.event='Existing rising→returning confirmation, emitted immediately; no need to wait for the next bottom, no threshold changes. Not a full-cycle count.';
 protocol.sourceSha256['mobile/research/evaluate-stream-criteria.mjs']=sha(fs.readFileSync('mobile/research/evaluate-stream-criteria.mjs'));
}
// Refuse to silently overwrite a result after input or implementation changes.
if(fs.existsSync(out+'/protocol.json'))assert.deepEqual(read(out+'/protocol.json'),protocol,'Use a new versioned output folder for changed inputs/code.');
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(out+'/protocol.json',JSON.stringify(protocol,null,2)+'\n');
const rows=[],streams=[];
for(const job of jobs){
 assert(job.samples.every(s=>s.split!=='test'),'Never read a reserved-test pose cache');
 const bytes=fs.readFileSync(base+'/poses/'+job.id+'.json.gz'),cache=JSON.parse(zlib.gunzipSync(bytes));
 assert.equal(cache.fingerprint,job.fingerprint);
 const engine=new PullupPhaseEngine(),detections=[];
 for(const f of cache.frames){
  const n=engine.completed.length;
  const before=engine.phase;
  engine.update(f.landmarks,f.now,f.width,f.height);
  if(ascentEvents){
   // The existing movement thresholds already confirm a passed upper point.
   // Publish that event now; no end-of-file flush or future lower point is used.
   if(before==='rising'&&engine.phase==='returning'){
    const c=engine.cycle;
    detections.push({index:detections.length+1,start:c.start,sampleStart:c.sampleStart,
     top:c.peak.t,minElbow:c.minElbow,maxElbow:c.maxElbow,lift:c.lift,emittedAt:f.now,
     event:'ascent_top_confirmed_not_full_return'});
   }
  }else for(const rep of engine.completed.slice(n))detections.push({...rep,emittedAt:f.now});
 }
 const samples=job.samples.filter(s=>selected.has(s.uid));
 const prepared=samples.map(s=>{const p=metadata.get(s.uid);return {bottom:p.start*1000,top:p.top*1000};});
 const pairs=new Map(matchEvents(prepared,detections));
 const topPairs=new Map(matchEvents(prepared,detections,{bottomMs:Infinity,topMs:400}));
 const humanSamples=samples.filter(s=>selected.get(s.uid).phase_times?.bottom!=null&&selected.get(s.uid).phase_times?.top!=null);
 const humanRefs=humanSamples.map(s=>{const p=selected.get(s.uid).phase_times;return {bottom:p.bottom*1000,top:p.top*1000};});
 const humanPairs=new Map(matchEvents(humanRefs,detections));
 const humanMatches=new Map(humanSamples.map((s,i)=>[s.uid,humanPairs.has(i)?detections[humanPairs.get(i)]:null]));
 const assess=(bottom,top,emittedAt=Infinity)=>{
  const frames=cache.frames.filter(f=>f.now<=emittedAt);
  const upper=measureTopProxy(frames,bottom,top);
  return {bottom:initialBottom2D(frames,bottom,top),upper,
   scaledTopMouth:scaledFaceState(upper,prior),scaledTopMouthPoint:scaledFaceState(upper,prior,{range:false}),
   scaledPeakMouth:scaledFaceState(upper,prior,{when:'peak'})};
 };
 for(let i=0;i<samples.length;i++){
  const sample=samples[i],r=selected.get(sample.uid),ref=prepared[i];
  assert.equal(sample.group,r.group);
  const rep=pairs.has(i)?detections[pairs.get(i)]:null;
  const topRep=topPairs.has(i)?detections[topPairs.get(i)]:null;
  const humanRep=humanMatches.get(sample.uid),p=r.phase_times;
  rows.push({uid:sample.uid,group:sample.group,split:sample.split,jobId:job.id,labels:r.targets,
   reference:{...ref,origin:'legacy_automatic_not_human'},humanReference:p??null,
   matched:rep,topOnlyMatch:topRep,humanMatch:humanRep??null,
   timing:rep?{bottomOffsetMs:rep.sampleStart-ref.bottom,topOffsetMs:rep.top-ref.top,emissionDelayMs:rep.emittedAt-rep.top}:null,
   prepared:assess(ref.bottom,ref.top),automatic:rep?assess(rep.sampleStart,rep.top,rep.emittedAt):null,
   human:p?.bottom!=null&&p?.top!=null?assess(p.bottom*1000,p.top*1000):null,
   automaticHumanMatched:humanRep?assess(humanRep.sampleStart,humanRep.top,humanRep.emittedAt):null,
   cacheStartMs:cache.frames[0].now,cacheEndMs:cache.frames.at(-1).now,rawCacheSha256:sha(bytes)});
 }
 streams.push({id:job.id,groups:[...new Set(samples.map(s=>s.group))],sourceVideo:job.video,
  fps:job.fps,delegate:job.delegate,frames:cache.frames.length,startMs:cache.frames[0].now,endMs:cache.frames.at(-1).now,
  reviewed:samples.length,matched:pairs.size,topOnlyMatched:topPairs.size,detections,
  unfinished:engine.cycle?{phase:engine.phase,sampleStart:engine.cycle.sampleStart,top:engine.cycle.peak.t}:null,
  rawCacheSha256:sha(bytes)});
}
assert.equal(rows.length,selected.size);
function summary(subset,mode){
 const metrics={total:subset.length,bottom:{TP:0,FN:0,FP:0,TN:0,unavailable:0},
  scaledTopMouth:{belowError:0,belowNormal:0,aboveError:0,aboveNormal:0,uncertain:0,unavailable:0},
  scaledTopMouthPoint:{belowError:0,belowNormal:0,aboveError:0,aboveNormal:0,uncertain:0,unavailable:0}};
 for(const r of subset){
  const m=r[mode],g=m?.bottom,label=r.labels.bottom_incomplete;
  if(g?.state!=='measured')metrics.bottom.unavailable++;
  else metrics.bottom[label?(g.predictedError?'TP':'FN'):(g.predictedError?'FP':'TN')]++;
  for(const field of ['scaledTopMouth','scaledTopMouthPoint']){
   const state=m?.[field]?.state??'unavailable',u=metrics[field];
   if(state==='below'||state==='above')u[state+(r.labels.top_below_bar?'Error':'Normal')]++;
   else u[state]++;
  }
 }
 return metrics;
}
const groups=[...new Set(rows.map(r=>r.group))],counts=new Map(groups.map(g=>[g,rows.filter(r=>r.group===g).length]));
const largest=[...counts].sort((a,b)=>b[1]-a[1])[0][0];
const humanRows=rows.filter(r=>r.human);
const summaryReport={reviewed:rows.length,groups:groups.length,streams:streams.length,
 totalFrames:streams.reduce((n,s)=>n+s.frames,0),matched:rows.filter(r=>r.matched).length,
 topOnlyMatched:rows.filter(r=>r.topOnlyMatch).length,
 prepared:summary(rows,'prepared'),automatic:summary(rows,'automatic'),
 commonPrepared:summary(rows.filter(r=>r.matched),'prepared'),
 human:{total:humanRows.length,matched:humanRows.filter(r=>r.humanMatch).length,reference:summary(humanRows,'human'),automatic:summary(humanRows,'automaticHumanMatched')},
 withoutLargestGroup:{excluded:largest,n:rows.filter(r=>r.group!==largest).length,prepared:summary(rows.filter(r=>r.group!==largest),'prepared'),automatic:summary(rows.filter(r=>r.group!==largest),'automatic')},
 byGroup:groups.map(g=>({group:g,total:counts.get(g),matched:rows.filter(r=>r.group===g&&r.matched).length,topOnlyMatched:rows.filter(r=>r.group===g&&r.topOnlyMatch).length})),
 unmatched:rows.filter(r=>!r.matched).map(r=>({uid:r.uid,reference:r.reference,topOnlyMatch:r.topOnlyMatch,humanReference:r.humanReference,jobId:r.jobId}))};
fs.writeFileSync(out+'/results.json',JSON.stringify({schema:1,reviewSha256:protocol.reviewSha256,testUsed:false,summary:summaryReport,streams,rows},null,2)+'\n');
console.log(JSON.stringify(summaryReport,null,2));
