import fs from 'node:fs';import zlib from 'node:zlib';import crypto from 'node:crypto';
import {PullupPhaseEngine} from '../app/pullup-phases.mjs';
import {measureInitialBottom,measureAutomaticBottom} from '../app/pullup-bottom.mjs';
const dir='pullups/dataset_mediapipe_gpu/human-reviews/expanded-3d';
const selection=JSON.parse(fs.readFileSync(dir+'/selection.json'));
const manifest=JSON.parse(fs.readFileSync('pullups/dataset_mediapipe_gpu/manifest.json'));
const testGroups=new Set(manifest.jobs.flatMap(j=>j.samples).filter(s=>s.split==='test').map(s=>s.group));
const exclusions={'Gu22bA5oZ64':'Previously inspected rendered anatomy animation, not human recording'};
const rows=[];
for(const job of selection.jobs){
 if(testGroups.has(job.group)||selection.excluded_groups.includes(job.group))throw Error('Source leakage');
 const data=JSON.parse(zlib.gunzipSync(fs.readFileSync(dir+'/poses/'+job.uid.replaceAll(':','_')+'-lite.json.gz')));
 if(data.identity.sourceFingerprint!==job.sourceFingerprint||data.identity.start!==job.start||data.identity.end!==job.end)throw Error('Wrong pose provenance');
 const frames=data.frames,e=new PullupPhaseEngine();for(const f of frames)e.update(f.landmarks,f.now,f.width,f.height);
 const start=+job.sample.start,end=+job.sample.end;
 const overlap=rep=>{const a=rep.sampleStart/1000,b=rep.end/1000;return Math.max(0,Math.min(b,end)-Math.max(a,start))/(Math.max(b,end)-Math.min(a,start));};
 const rep=e.completed.filter(r=>Math.abs(r.sampleStart/1000-start)<=.5&&r.top/1000>=start&&r.top/1000<=end+.2&&overlap(r)>=.3).sort((a,b)=>overlap(b)-overlap(a))[0];
 const exact=rep?measureInitialBottom(frames,rep.sampleStart):null;
 const corrected=rep?measureAutomaticBottom(frames,rep):null;
 const prefix=rep?frames.filter(f=>f.now<=Math.min(rep.start,rep.top)):[];
 const candidates=rep?prefix.filter(f=>f.now>=rep.sampleStart-350&&f.now<=rep.sampleStart).map(f=>measureInitialBottom(prefix,f.now)).filter(m=>Number.isFinite(m.angle2d)):[];
 const revised2d=candidates.length?Math.max(...candidates.map(m=>m.angle2d)):exact?.angle2d;
 const angles={exact2d:exact?.angle2d??null,exact3d:exact?.angle3d??null,window2d:revised2d??null,window3d:corrected?.angle3d??null};
 rows.push({uid:job.uid,group:job.group,legacyPartial:+job.sample.partial,legacyFacing:job.sample.facing,
  exclusion:exclusions[job.sample.video_id]??null,detectedCycles:e.completed.length,bestIoU:e.completed.length?Math.max(...e.completed.map(overlap)):0,rep:rep??null,iou:rep?overlap(rep):null,angles,
  predictions:Object.fromEntries(Object.entries(angles).map(([k,a])=>[k,Number.isFinite(a)?+(a<150):null]))});
}
function stats(selected){
 const out={n:selected.length,groups:new Set(selected.map(r=>r.group)).size,matched:selected.filter(r=>r.rep).length,variants:{}};
 for(const k of ['exact2d','exact3d','window2d','window3d']){
  const complete=selected.filter(r=>r.predictions[k]!==null),neg=complete.filter(r=>r.legacyPartial===0),pos=complete.filter(r=>r.legacyPartial===1);
  out.variants[k]={available:complete.length,unavailable:selected.length-complete.length,
   legacyNormal:{n:neg.length,flagged:neg.filter(r=>r.predictions[k]===1).length},
   legacyPartial:{n:pos.length,flagged:pos.filter(r=>r.predictions[k]===1).length}};
 }
 const paired=selected.filter(r=>r.predictions.window2d!==null&&r.predictions.window3d!==null);
 out.paired={n:paired.length,groups:new Set(paired.map(r=>r.group)).size,
  normals:paired.filter(r=>r.legacyPartial===0).length,
  normalFlags2d:paired.filter(r=>r.legacyPartial===0&&r.predictions.window2d===1).length,
  normalFlags3d:paired.filter(r=>r.legacyPartial===0&&r.predictions.window3d===1).length,
  disagreements:paired.filter(r=>r.predictions.window2d!==r.predictions.window3d).map(r=>r.uid)};
 return out;
}
const eligible=rows.filter(r=>!r.exclusion);
const result={selectionSha256:crypto.createHash('sha256').update(JSON.stringify(selection)).digest('hex'),
 protocol:'Frozen selection: 100 clips, 65 new development channels; threshold150 unchanged; phase matching bottom±.5s, top inside legacy window+.2s, IoU≥.3. Fixed350ms window from existing prototype, no parameter fitting. Both dimensional variants compare identical frames. Known animation excluded from primary results.',
 limitation:'Legacy partial is NOT bottom-error ground truth. Counts are disagreements with old labels, not verified false positives/recall/accuracy. Facing is an unverified legacy tag. Phase references are legacy windows. Source-group separation from prior manual review is not a new fully annotated test.',
 raw:stats(rows),eligible:stats(eligible),byLegacyFacing:Object.fromEntries(['front','back'].map(f=>[f,stats(eligible.filter(r=>r.legacyFacing===f))])),rows};
fs.writeFileSync(dir+'/results.json',JSON.stringify(result,null,2));console.log(JSON.stringify({raw:result.raw,eligible:result.eligible,byLegacyFacing:result.byLegacyFacing},null,2));
