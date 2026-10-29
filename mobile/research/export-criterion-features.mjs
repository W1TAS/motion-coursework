import fs from 'node:fs';import zlib from 'node:zlib';import crypto from 'node:crypto';
import {criterionFeatures,BOTTOM_FEATURES} from './criterion-features.mjs';
const dir='pullups/dataset_mediapipe_gpu',reviews=JSON.parse(fs.readFileSync(process.argv[2]??dir+'/human-reviews/criterion-labels.json'));
const manifest=JSON.parse(fs.readFileSync(dir+'/manifest.json')),jobs=new Map();
for(const j of manifest.jobs)for(const s of j.samples)jobs.set(s.uid,{job:j,sample:s});
const rows=[],cache=new Map(),counts={};
for(const review of reviews.rows){
 const entry=jobs.get(review.uid);if(!entry||entry.sample.split==='test'||entry.sample.group!==review.group)throw Error('Unknown, mismatched or test review');
 const {job}=entry;
 let frames=[];
 if(Object.values(review.ready_for_phase_features).some(Boolean)){
  if(!cache.has(job.id)){const c=JSON.parse(zlib.gunzipSync(fs.readFileSync(dir+'/poses/'+job.id+'.json.gz')));if(c.fingerprint!==job.fingerprint)throw Error('Cache provenance mismatch');cache.set(job.id,c.frames);}
  frames=cache.get(job.id);
 }
 const inputs=criterionFeatures(frames,review);
 for(const[t,r]of Object.entries(inputs)){counts[t]??={};counts[t][r.status]=(counts[t][r.status]??0)+1;}
 rows.push({uid:review.uid,group:review.group,split:review.split,attempt:review.attempt,labels:review.targets,inputs});
}
const output={schema:1,featureProtocol:'human-phase-v1',bottomFeatures:BOTTOM_FEATURES,
 swingFeatures:'Canonical motion features 16..39, computed on human-marked ascent only',counts,rows,
 limitation:'Research inputs only. No model trained or deployed. Unknown labels excluded per target; source groups must remain separated. Upper-height model disabled pending additional image measurements.',
 reviewHash:crypto.createHash('sha256').update(JSON.stringify(reviews)).digest('hex')};
fs.writeFileSync(dir+'/human-reviews/criterion-features.json',JSON.stringify(output,null,2));console.log(counts);
