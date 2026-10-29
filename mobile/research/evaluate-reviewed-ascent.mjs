// Audit frozen new reviews against identical Lite caches; no fitting or deployment.
import fs from 'node:fs';import zlib from 'node:zlib';import crypto from 'node:crypto';
import {measureInitialBottom,worldElbowAngles} from '../app/pullup-bottom.mjs';
import {measurePullup} from '../app/pullup-engine.mjs';
import {criterionFeatures} from './criterion-features.mjs';
import {PullupPhaseEngine} from '../app/pullup-phases.mjs';
const dir='pullups/dataset_mediapipe_gpu/human-reviews/expanded-3d';
const packet=JSON.parse(fs.readFileSync(dir+'/review-selection.json'));
const reviewBytes=fs.readFileSync('pullups/dataset_mediapipe_gpu/human-reviews/criterion-labels.json');
const reviews=JSON.parse(reviewBytes),byUid=new Map(reviews.rows.map(r=>[r.uid,r]));
const jobs=new Map(JSON.parse(fs.readFileSync(dir+'/selection.json')).jobs.map(j=>[j.uid,j]));
const skipped=new Set(reviews.skipped.map(r=>r.uid)),rows=[];
for(const item of packet.items){
 const review=byUid.get(item.id),row={uid:item.id,status:skipped.has(item.id)?'skipped_back':review?'complete':'incomplete'};
 if(!review){rows.push(row);continue;}
 const job=jobs.get(item.id),bytes=fs.readFileSync(dir+'/poses/'+item.id.replaceAll(':','_')+'-lite.json.gz');
 const cache=JSON.parse(zlib.gunzipSync(bytes));
 if(job.sample.split==='test'||cache.identity.sourceFingerprint!==job.sourceFingerprint||cache.identity.start!==job.start||cache.identity.end!==job.end)throw Error('Wrong cache provenance');
 const frames=cache.frames,t=review.phase_times.bottom*1000;
 const local=measureInitialBottom(frames,t),nearest=frames.slice().sort((a,b)=>Math.abs(a.now-t)-Math.abs(b.now-t))[0];
 const single=Math.abs(nearest.now-t)<=40?measurePullup(nearest.landmarks,nearest.width,nearest.height):null;
 const world=single?.valid?worldElbowAngles(nearest):null;
 const inputs=criterionFeatures(frames,review),engine=new PullupPhaseEngine();
 for(const f of frames)engine.update(f.landmarks,f.now,f.width,f.height);
 const match=engine.completed.find(r=>Math.abs(r.sampleStart-t)<=500&&Math.abs(r.top-review.phase_times.top*1000)<=400);
 Object.assign(row,{group:review.group,facing:review.facing,poseQuality:review.pose_quality,labels:review.targets,
  phases:review.phase_times,phaseAnnotationSources:review.phase_annotation_sources,
  initialBottom:{single2d:single?.valid?single.elbow:null,single3d:world?(world[0]+world[1])/2:null,
   median2d:local.angle2d??null,median3d:local.angle3d??null,usableFrames:local.frames??0},
  ascentFeaturesStatus:inputs.swing_ascent.status,automaticFullCycleMatched:!!match,
  rawCacheSha256:crypto.createHash('sha256').update(bytes).digest('hex')});
 rows.push(row);
}
function summarize(rows){
 const complete=rows.filter(r=>r.status==='complete'),out={clips:rows.length,complete:complete.length,
  skippedBack:rows.filter(r=>r.status==='skipped_back').length,incomplete:rows.filter(r=>r.status==='incomplete').length,
  targets:{},bottomMeasurements:{},ascentFeaturesAvailable:complete.filter(r=>r.ascentFeaturesStatus==='available').length,
  automaticFullCycleMatched:complete.filter(r=>r.automaticFullCycleMatched).length};
 for(const target of ['bottom_incomplete','top_below_bar','swing_ascent'])out.targets[target]={
  normal:complete.filter(r=>r.labels[target]===0).length,error:complete.filter(r=>r.labels[target]===1).length,unknown:complete.filter(r=>r.labels[target]===null).length};
 for(const mode of ['single2d','single3d','median2d','median3d']){
  const eligible=complete.filter(r=>r.labels.bottom_incomplete!==null),available=eligible.filter(r=>Number.isFinite(r.initialBottom[mode]));
  out.bottomMeasurements[mode]={available:available.length,unavailable:eligible.length-available.length,
   flaggedNormal:available.filter(r=>r.labels.bottom_incomplete===0&&r.initialBottom[mode]<150).length,
   detectedError:available.filter(r=>r.labels.bottom_incomplete===1&&r.initialBottom[mode]<150).length,
   errorExamples:available.filter(r=>r.labels.bottom_incomplete===1).length};
 }
 return out;
}
const summary=summarize(rows),frontal=summarize(rows.filter(r=>r.status==='complete'&&['front','front_oblique'].includes(r.facing)));
const report={protocol:'Human initial bottom ±120ms; swing inputs bottom-to-top only, no following descent. Fixed 150-degree reference, no tuning.',
 reviewSha256:crypto.createHash('sha256').update(reviewBytes).digest('hex'),summary,frontal,
 limitations:['Targeted development clips, one annotator; not a representative or reserved test.',
  'No confirmed bottom-error examples in the new frontal subset: sensitivity, balanced accuracy and model selection cannot be assessed.',
  'Some human phase annotations confirm detector suggestions and are not independent phase references.',
  'Top-height target requires bar/chin image measurements; pose-only extension angles cannot establish it.',
  'Feature availability is not classification accuracy. No model weights or application behavior changed.'],rows};
fs.writeFileSync(dir+'/reviewed-ascent-audit.json',JSON.stringify(report,null,2));console.log(JSON.stringify({summary,frontal},null,2));
