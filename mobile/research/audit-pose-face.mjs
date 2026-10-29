// Existing body-model face coordinates only. No fitting, new model or test replay.
import fs from 'node:fs';import zlib from 'node:zlib';import crypto from 'node:crypto';import assert from 'node:assert/strict';
import {auditFaceWindow,summarizeFaceAudits,FACE_AUDIT_RULES,FACE_CUES} from './pose-face-quality.mjs';
import {measureTopProxy} from './pullup-top-proxy.mjs';
import {scaledFaceState} from './stream-criterion-helpers.mjs';

const args=process.argv.slice(2);assert(args.length===0||args.length===2&&args[0]==='--out');
const version=args[1]??'pose-face-audit-v2';assert(/^[a-z0-9-]+$/.test(version));
const base='pullups/dataset_mediapipe_gpu',out=base+'/human-reviews/'+version;
assert(!fs.existsSync(out),'Output exists. Use a new version; never overwrite experiments.');
const read=p=>JSON.parse(fs.readFileSync(p)),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const manifestRaw=fs.readFileSync(base+'/manifest.json'),reviewRaw=fs.readFileSync(base+'/human-reviews/criterion-labels.json');
const phaseRaw=fs.readFileSync(base+'/ascent-v1/manifest.json');
const reviews=JSON.parse(reviewRaw),skipped=new Set(reviews.skipped.map(r=>r.uid));
const screened=new Map(reviews.rows.filter(r=>r.split!=='test'&&!skipped.has(r.uid)&&
 (r.input_screening?.result==='accepted'||(['front','front_oblique'].includes(r.facing)&&r.pose_quality==='usable'))).map(r=>[r.uid,r]));
const phases=new Map(JSON.parse(phaseRaw).rows.filter(r=>r.split!=='test').map(r=>[r.uid,r]));
const priorPath=base+'/human-reviews/top-proxy-v1/bar-offset-audit-v1/torso-prior.json',priorRaw=fs.readFileSync(priorPath),prior=JSON.parse(priorRaw);
const protocol={schema:1,testUsed:false,rules:FACE_AUDIT_RULES,cues:FACE_CUES,
 input:'All original train+val full pose caches. Only final 200ms up to frozen automatic top; following descent excluded. Test caches are never opened.',
 confidence:'Exactly the app display filter (visibility/presence >= .45, finite in-image coordinates). Availability does not establish anatomical correctness or front view.',
 stability:'Adjacent cue position relative to shoulders / torso length, gap <=80ms; >.12 is a diagnostic jump flag, not validated ground truth.',
 fallback:'Nose, then mouth midpoint, then eyes midpoint, then ears midpoint. Cues evaluated independently; no fabricated chin or change of coordinate meaning.',
 labels:'Original partial labels not used to score upper-height technique. Latest strict criterion labels used only for descriptive proxy comparison.',
 proxy:'Unchanged wrist/nose/mouth geometry and frozen torso offset prior from nine approximate scenes. Above is unresolved, never a correct-repetition verdict.',
 manualPhases:'Separate diagnostic only where canonical reviewed phase_times exist; no automatic references relabeled as human.',
 hashes:{manifest:sha(manifestRaw),phases:sha(phaseRaw),reviews:sha(reviewRaw),prior:sha(priorRaw)},
 sources:Object.fromEntries(['mobile/research/audit-pose-face.mjs','mobile/research/pose-face-quality.mjs','mobile/app/pose-face.mjs',
  'mobile/research/pullup-top-proxy.mjs','mobile/research/stream-criterion-helpers.mjs'].map(p=>[p,sha(fs.readFileSync(p))]))};
const rows=[],streams=[];
for(const job of JSON.parse(manifestRaw).jobs){
 if(!job.samples.every(s=>s.split!=='test'))continue;
 const raw=fs.readFileSync(base+'/poses/'+job.id+'.json.gz'),cache=JSON.parse(zlib.gunzipSync(raw));
 assert.equal(cache.fingerprint,job.fingerprint);
 for(const sample of job.samples){
  const phase=phases.get(sample.uid);assert(phase);const review=screened.get(sample.uid);
  const row={uid:sample.uid,group:sample.group,split:sample.split,jobId:job.id,
   phase:{start:phase.start,top:phase.top,origin:'legacy_automatic_not_human'},
   audit:auditFaceWindow(cache.frames,phase.start*1000,phase.top*1000),screened:Boolean(review)};
  if(review){
   assert.equal(review.group,sample.group);row.topLabel=review.targets.top_below_bar;
   row.proxy=measureTopProxy(cache.frames,phase.start*1000,phase.top*1000);
   row.shiftedTopMouth=scaledFaceState(row.proxy,prior,{when:'top',point:'mouth'});
   row.shiftedPeakMouth=scaledFaceState(row.proxy,prior,{when:'peak',point:'mouth'});
   if(Number.isFinite(review.phase_times?.top)&&Number.isFinite(review.phase_times?.bottom)){
    row.reviewedPhase={...review.phase_times,sources:review.phase_annotation_sources??{},temporalStatus:review.temporal_status};
    row.atReviewedTop=auditFaceWindow(cache.frames,review.phase_times.bottom*1000,review.phase_times.top*1000);
   }
  }
  rows.push(row);
 }
 streams.push({id:job.id,frames:cache.frames.length,windows:job.samples.length,cacheSha256:sha(raw)});
}
function summarize(input,field='audit'){
 return summarizeFaceAudits(input.map(r=>r[field]).filter(Boolean));
}
function proxyTable(input,key){
 const table={normal:{below:0,above:0,uncertain:0,unavailable:0},error:{below:0,above:0,uncertain:0,unavailable:0},unknown:0};
 for(const r of input){if(![0,1].includes(r.topLabel)){table.unknown++;continue;}table[r.topLabel?'error':'normal'][r[key].state]++;}
 return table;
}
const strict=rows.filter(r=>r.screened);assert.equal(strict.length,screened.size);
const groupCounts=Object.fromEntries([...new Set(strict.map(r=>r.group))].map(g=>[g,strict.filter(r=>r.group===g).length]));
const largest=Object.keys(groupCounts).sort((a,b)=>groupCounts[b]-groupCounts[a]||a.localeCompare(b))[0];
const summary={development:{...summarize(rows),streams:streams.length,groups:new Set(rows.map(r=>r.group)).size,
  frames:streams.reduce((n,r)=>n+r.frames,0)},
 bySplit:Object.fromEntries(['train','val'].map(s=>[s,summarize(rows.filter(r=>r.split===s))])),
 screened:{...summarize(strict),groups:Object.keys(groupCounts).length},
 reviewedPhases:summarize(strict,'atReviewedTop'),
 withoutLargest:{excluded:largest,...summarize(strict.filter(r=>r.group!==largest))},
 byGroup:Object.entries(groupCounts).map(([g,n])=>({group:g,n,...summarize(strict.filter(r=>r.group===g))})),
 proxy:{available:strict.filter(r=>r.proxy.state==='measured').length,
  reasons:strict.reduce((a,r)=>{const key=r.proxy.state==='measured'?'measured':r.proxy.reason;a[key]=(a[key]??0)+1;return a;},{}),
  shiftedTopMouth:proxyTable(strict,'shiftedTopMouth'),shiftedPeakMouth:proxyTable(strict,'shiftedPeakMouth'),
  normalFlaggedAtPeak:strict.filter(r=>r.topLabel===0&&r.shiftedPeakMouth.state==='below').map(r=>r.uid)},
 jumpCandidates:rows.filter(r=>r.audit.parts?.nose?.jumpFlag).map(r=>({uid:r.uid,group:r.group,screened:r.screened,
  jump:r.audit.parts.nose.maxRelativeJump})).sort((a,b)=>b.jump-a.jump)};
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(out+'/protocol.json',JSON.stringify(protocol,null,2)+'\n');
fs.writeFileSync(out+'/summary.json',JSON.stringify(summary,null,2)+'\n');
fs.writeFileSync(out+'/rows.json.gz',zlib.gzipSync(JSON.stringify({streams,rows})));
for(const p of Object.keys(protocol.sources)){const target=out+'/sources/'+p;fs.mkdirSync(target.slice(0,target.lastIndexOf('/')),{recursive:true});fs.copyFileSync(p,target);}
console.log(JSON.stringify({development:summary.development,screened:summary.screened,reviewedPhases:summary.reviewedPhases,withoutLargest:summary.withoutLargest,proxy:summary.proxy},null,2));
