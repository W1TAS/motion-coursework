import fs from 'node:fs';import zlib from 'node:zlib';import crypto from 'node:crypto';
import {repairIsolatedPoseOutliers,OUTLIER_PROTOCOL} from './pose-outliers.mjs';
import {PullupPhaseEngine} from '../app/pullup-phases.mjs';
import {measureInitialBottom} from '../app/pullup-bottom.mjs';
const dir='pullups/dataset_mediapipe_gpu/human-reviews/expanded-3d';
const selection=JSON.parse(fs.readFileSync(dir+'/selection.json'));
const exclusions=new Map(JSON.parse(fs.readFileSync(dir+'/results.json')).rows.map(r=>[r.uid,r.exclusion]));
const labels=JSON.parse(fs.readFileSync('pullups/dataset_mediapipe_gpu/human-reviews/criterion-labels.json'));
const byUid=new Map(labels.rows.map(r=>[r.uid,r]));
function phases(frames,job){
 const engine=new PullupPhaseEngine();for(const f of frames)engine.update(f.landmarks,f.now,f.width,f.height);
 const start=+job.sample.start,end=+job.sample.end;
 const iou=r=>Math.max(0,Math.min(r.end/1000,end)-Math.max(r.sampleStart/1000,start))/(Math.max(r.end/1000,end)-Math.min(r.sampleStart/1000,start));
 const matching=engine.completed.filter(r=>Math.abs(r.sampleStart/1000-start)<=.5&&r.top/1000>=start&&r.top/1000<=end+.2&&iou(r)>=.3);
 return {cycles:engine.completed.length,matched:matching.length>0};
}
const rows=[];
for(const job of selection.jobs){
 const cachePath=dir+'/poses/'+job.uid.replaceAll(':','_')+'-lite.json.gz',bytes=fs.readFileSync(cachePath);
 const cache=JSON.parse(zlib.gunzipSync(bytes));
 if(cache.identity.sourceFingerprint!==job.sourceFingerprint)throw Error('Cache mismatch');
 const result=repairIsolatedPoseOutliers(cache.frames),review=byUid.get(job.uid);
 const bottom=review?.phase_times?.bottom;
 const measurement=Number.isFinite(bottom)?{
  before:measureInitialBottom(cache.frames,bottom*1000),after:measureInitialBottom(result.frames,bottom*1000),
  label:review.targets.bottom_incomplete,facing:review.facing,
  annotationSource:review.phase_annotation_sources?.bottom?.kind??'manual_legacy'}:null;
 rows.push({uid:job.uid,group:job.group,exclusion:exclusions.get(job.uid)??null,rawCacheSha256:crypto.createHash('sha256').update(bytes).digest('hex'),
  frameCount:cache.frames.length,correctedPoints:result.corrections.length,
  correctedFrames:new Set(result.corrections.map(c=>c.frame)).size,
  before:phases(cache.frames,job),after:phases(result.frames,job),bottom:measurement,corrections:result.corrections});
}
function summarize(rows){const changed=rows.filter(r=>r.correctedPoints);return {clips:rows.length,changedClips:changed.length,
 correctedFrames:rows.reduce((n,r)=>n+r.correctedFrames,0),totalFrames:rows.reduce((n,r)=>n+r.frameCount,0),
 correctedPoints:rows.reduce((n,r)=>n+r.correctedPoints,0),
 matchedBefore:rows.filter(r=>r.before.matched).length,matchedAfter:rows.filter(r=>r.after.matched).length,
 cyclesBefore:rows.reduce((n,r)=>n+r.before.cycles,0),cyclesAfter:rows.reduce((n,r)=>n+r.after.cycles,0),
 changedPhaseOutputs:rows.filter(r=>JSON.stringify(r.before)!==JSON.stringify(r.after)).map(r=>r.uid)};}
const summary=summarize(rows),eligible=summarize(rows.filter(r=>!r.exclusion));
const report={protocol:OUTLIER_PROTOCOL,summary,eligible,
 limitation:'Exploratory development audit, no human outlier labels. Corrections are hypotheses, not verified tracking improvements. Phase matching uses legacy windows and is not accuracy. No test data, threshold tuning, cache writes, training or deployment. Whole-body jumps and camera movement are intentionally not repaired. Offline future-frame context requires up to 160ms lookahead at 25fps.',rows};
fs.writeFileSync(dir+'/pose-outlier-audit.json',JSON.stringify(report,null,2));console.log(JSON.stringify({raw:summary,eligible},null,2));
