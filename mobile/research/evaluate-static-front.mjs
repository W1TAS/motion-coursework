// Freeze scene eligibility before evaluating unchanged development predictions.
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {measureTopProxy} from './pullup-top-proxy.mjs';
import {initialBottom2D} from './stream-criterion-helpers.mjs';
import {wristPriorReference,measureFaceHeight} from './actual-bar-height.mjs';

export function screenScenes(evidence,views){
 const audit=new Map(views.rows.map(r=>[r.scene,r]));
 assert.equal(audit.size,evidence.scenes.length);
 return evidence.scenes.map(s=>{
  const v=audit.get(s.id);assert(v&&v.allReviewedStartsAndTopsChecked);
  assert.equal(v.reviewedImageSha256,s.imageSha256);
  const reasons=[];
  if(s.camera.state!=='near_static')reasons.push('camera_'+s.camera.state);
  if(!['front','front_oblique'].includes(v.view))reasons.push('view_'+v.view);
  return {id:s.id,group:s.group,accepted:reasons.length===0,reasons,view:v.view,
   camera:s.camera,samples:s.samples.map(r=>r.uid)};
 });
}

export function binaryMetrics(rows,label,prediction){
 const m={total:rows.length,known:0,unknownLabel:0,TP:0,FN:0,FP:0,TN:0,unmatched:0,unavailable:0};
 for(const r of rows){
  const y=label(r);if(y!==0&&y!==1){m.unknownLabel++;continue;}m.known++;
  const p=prediction(r);
  if(p?.state==='unmatched'){m.unmatched++;continue;}
  if(p?.state!=='measured'||typeof p.predictedError!=='boolean'){m.unavailable++;continue;}
  m[y?(p.predictedError?'TP':'FN'):(p.predictedError?'FP':'TN')]++;
 }
 m.scored=m.TP+m.FN+m.FP+m.TN;
 m.precision=m.TP+m.FP?m.TP/(m.TP+m.FP):null;
 m.recallOnScoredErrors=m.TP+m.FN?m.TP/(m.TP+m.FN):null;
 return m;
}

export function heightTable(rows,field){
 const m={normal:{below:0,above:0,uncertain:0,unavailable:0},error:{below:0,above:0,uncertain:0,unavailable:0},unknown:0};
 for(const r of rows){
  const y=r.labels.top_below_bar;if(y!==0&&y!==1){m.unknown++;continue;}
  const state=r[field]?.mouth?.state??r[field]?.state??'unavailable';
  assert(['below','above','uncertain','unavailable'].includes(state));m[y?'error':'normal'][state]++;
 }
 return m;
}

export function legacyPrediction(row,model,target){
 if(!row.legacy)return {state:'unmatched'};
 const p=row.legacy[model]?.targets?.[target];
 return ['flagged','not_detected'].includes(p?.state)?
  {state:'measured',predictedError:p.state==='flagged'}:{state:'unavailable'};
}

function main(){
 const version=process.argv[2]??'static-front-v1';assert(/^[a-z0-9-]+$/.test(version));
 const base='pullups/dataset_mediapipe_gpu',folder=base+'/human-reviews/'+version;
 assert(!fs.existsSync(folder+'/results.json'),'Use a new directory for a new evaluation.');
 const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),inputs={};
 const read=p=>{const raw=fs.readFileSync(p);inputs[p]=sha(raw);return JSON.parse(raw);};
 const evidence=read(folder+'/screening-evidence.json'),views=read(folder+'/views.json');
 assert.equal(views.evidenceSha256,inputs[folder+'/screening-evidence.json']);
 const scenes=screenScenes(evidence,views),accepted=new Set(scenes.filter(s=>s.accepted).flatMap(s=>s.samples));
 assert(!fs.existsSync(folder+'/selection.json'),'Selection is already frozen.');
 fs.writeFileSync(folder+'/selection.json',JSON.stringify({schema:1,testUsed:false,scenes,acceptedUids:[...accepted]},null,2)+'\n');
 const auditPath=base+'/human-reviews/pose-face-audit-v2/rows.json.gz',auditRaw=fs.readFileSync(auditPath);
 inputs[auditPath]=sha(auditRaw);
 const packet=read(folder+'/protocol.json');assert.equal(packet.auditSha256,sha(auditRaw));
 const audit=JSON.parse(zlib.gunzipSync(auditRaw)).rows.filter(r=>r.screened);
 const canonical=read(base+'/human-reviews/criterion-labels.json'),reviews=new Map(canonical.rows.map(r=>[r.uid,r]));
 const prior=read(base+'/human-reviews/top-proxy-v1/bar-offset-audit-v1/torso-prior.json');
 const stream=read(base+'/human-reviews/stream-bottom-quality-v1/results.json'),streamRows=new Map(stream.rows.map(r=>[r.uid,r]));
 const legacy=read(base+'/human-reviews/legacy-stream-regression-v1/results.json'),cycles=new Map();
 for(const run of legacy.runs)for(const c of run.cycles)if(c.match)cycles.set(c.match,c);
 const jobs=new Map(read(base+'/manifest.json').jobs.map(j=>[j.id,j]));
 const rows=[];
 for(const s of evidence.scenes){
  const job=jobs.get(s.id);assert(job.samples.every(r=>r.split!=='test'));
  const bytes=fs.readFileSync(base+'/poses/'+s.id+'.json.gz');assert.equal(sha(bytes),s.cacheSha256);
  const frames=JSON.parse(zlib.gunzipSync(bytes)).frames;
  for(const sample of s.samples){
   const old=audit.find(r=>r.uid===sample.uid),r=reviews.get(sample.uid),st=streamRows.get(sample.uid),cycle=cycles.get(sample.uid);
   assert(old&&r&&st&&r.split!=='test');assert.equal(r.targets.top_below_bar,old.topLabel);
   assert.equal(st.rawCacheSha256,s.cacheSha256);assert.equal(st.label,r.targets.bottom_incomplete);
   const start=old.phase.start*1000,top=old.phase.top*1000;
   const event=st.event,causal=event?frames.filter(f=>f.now<=event.confirmedAt):[];
   const automaticProxy=event?measureTopProxy(causal,event.sampleStart,event.top):null;
   rows.push({uid:r.uid,group:r.group,split:r.split,scene:s.id,accepted:accepted.has(r.uid),labels:r.targets,
    phase:old.phase,topFrozen:old.shiftedPeakMouth,
    topCommon:measureFaceHeight(frames,start,top,wristPriorReference(old.proxy,prior)),
    topAutomatic:event?measureFaceHeight(causal,event.sampleStart,event.top,wristPriorReference(automaticProxy,prior)):{state:'unavailable',reason:'unmatched'},
    bottomPrepared:initialBottom2D(frames,start,top),
    bottomStream:!event?{state:'unmatched'}:event.measured?.state==='measured'?
     {state:'measured',predictedError:event.measured.angle2d<150,angle:event.measured.angle2d}:event.measured,
    legacy:cycle?{deployed:cycle.deployed,retrained:cycle.retrained}:null});
  }
 }
 assert.equal(rows.length,audit.length);
 const partial=r=>[r.labels.bottom_incomplete,r.labels.top_below_bar].every(y=>y===0||y===1)?Number(Boolean(r.labels.bottom_incomplete||r.labels.top_below_bar)):null;
 const summarize=input=>({n:input.length,scenes:new Set(input.map(r=>r.scene)).size,groups:new Set(input.map(r=>r.group)).size,
  splits:Object.fromEntries(['train','val'].map(split=>[split,input.filter(r=>r.split===split).length])),
  top:Object.fromEntries(['topFrozen','topCommon','topAutomatic'].map(k=>[k,heightTable(input,k)])),
  bottomPrepared:binaryMetrics(input,r=>r.labels.bottom_incomplete,r=>r.bottomPrepared),
  bottomStream:binaryMetrics(input,r=>r.labels.bottom_incomplete,r=>r.bottomStream),
  classifiers:Object.fromEntries(['deployed','retrained'].map(model=>[model,{
   partial:binaryMetrics(input,partial,r=>legacyPrediction(r,model,'partial')),
   swing:binaryMetrics(input,r=>r.labels.swing_ascent,r=>legacyPrediction(r,model,'swing'))}]))});
 const kept=rows.filter(r=>r.accepted),counts=new Map();
 for(const r of rows)counts.set(r.group,(counts.get(r.group)??0)+1);
 const largest=[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0][0];
 const summary={before:summarize(rows),after:summarize(kept),excluded:summarize(rows.filter(r=>!r.accepted)),
  withoutLargest:{excludedGroup:largest,before:summarize(rows.filter(r=>r.group!==largest)),after:summarize(kept.filter(r=>r.group!==largest))},
  byGroup:[...counts].map(([group,n])=>({group,before:n,after:kept.filter(r=>r.group===group).length})),
  exclusions:scenes.filter(s=>!s.accepted)};
 const sources=['mobile/research/evaluate-static-front.mjs','pullups/prepare_static_front_screen.py',
  'mobile/research/actual-bar-height.mjs','mobile/research/pullup-top-proxy.mjs','mobile/research/stream-criterion-helpers.mjs','mobile/app/pose-face.mjs','mobile/app/pullup-engine.mjs'];
 const protocol={schema:1,testUsed:false,fitting:false,inputs,sources:Object.fromEntries(sources.map(p=>[p,sha(fs.readFileSync(p))])),
  scope:'Prepared legacy-automatic phases versus frozen streaming events; no test data, threshold tuning, model training, or app change. Eligibility frozen before this evaluation.',
  height:'Existing mouth/nose proxy; above is not a chin or correct repetition verdict. Report below/above/uncertain/unavailable by criterion label, never accuracy obtained by treating unknown as normal.',
  classifiers:'Frozen existing HGB predictions matched to full cycles by historical IoU>=.5. Scored against updated criterion labels: partial=bottom_error OR top_error only if both labels known. Different event matching than criterion branch; comparisons are descriptive, not paired algorithm accuracy.',
  limitations:'Agent visual view screening and sampled background diagnostic are not a validated camera classifier. Development and previously seen model data; selected criterion reviews, severe channel concentration. Original 2D caches do not validate the app 3D branch or fresh phone pose inference.'};
 fs.writeFileSync(folder+'/evaluation-protocol.json',JSON.stringify(protocol,null,2)+'\n');
 fs.writeFileSync(folder+'/results.json',JSON.stringify({summary,rows},null,2)+'\n');
 for(const p of sources){const to=folder+'/sources/'+p;fs.mkdirSync(to.slice(0,to.lastIndexOf('/')),{recursive:true});fs.copyFileSync(p,to);}
 console.log(JSON.stringify(summary,null,2));
}
if(import.meta.main)main();
