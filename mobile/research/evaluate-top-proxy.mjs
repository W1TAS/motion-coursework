import fs from 'node:fs';import zlib from 'node:zlib';import crypto from 'node:crypto';import assert from 'node:assert/strict';
import {TOP_PROXY_PROTOCOL,measureTopProxy} from './pullup-top-proxy.mjs';
const base='pullups/dataset_mediapipe_gpu',out=base+'/human-reviews/top-proxy-v1';
const reviewBytes=fs.readFileSync(base+'/human-reviews/criterion-labels.json'),reviews=JSON.parse(reviewBytes);
const gate=JSON.parse(fs.readFileSync(base+'/human-reviews/bottom-baseline-v1/eligibility.json'));
assert.equal(gate.reviewSha256,crypto.createHash('sha256').update(reviewBytes).digest('hex'));
const eligible=new Set(gate.rows.filter(r=>r.status==='accepted').map(r=>r.uid));
const metadata=new Map(JSON.parse(fs.readFileSync(base+'/ascent-v1/manifest.json')).rows.map(r=>[r.uid,r]));
const source=new Map();for(const job of JSON.parse(fs.readFileSync(base+'/manifest.json')).jobs)for(const sample of job.samples)source.set(sample.uid,{job,sample});
const rows=[],caches=new Map();
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(out+'/protocol.json',JSON.stringify({parameters:TOP_PROXY_PROTOCOL,reviewSha256:gate.reviewSha256,
 input:'Same 62 strictly screened development windows; automatic start/top for all, no following descent. Wrist reference near initial bottom; nose and midpoint of mouth only. No chin or image bar detector.',
 fitting:'No thresholds or offsets fitted on these labels. All variants descriptive, not selected using this packet.',testUsed:false},null,2)+'\n');
for(const review of reviews.rows){
 if(!eligible.has(review.uid))continue;
 const {job,sample}=source.get(review.uid),phase=metadata.get(review.uid);
 assert.notEqual(sample.split,'test');assert.equal(sample.group,review.group);
 if(!caches.has(job.id)){
  const bytes=fs.readFileSync(base+'/poses/'+job.id+'.json.gz'),cache=JSON.parse(zlib.gunzipSync(bytes));assert.equal(cache.fingerprint,job.fingerprint);
  caches.set(job.id,{...cache,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
 }
 const cache=caches.get(job.id),measurement=measureTopProxy(cache.frames,phase.start*1000,phase.top*1000);
 rows.push({uid:review.uid,group:review.group,split:review.split,label:review.targets.top_below_bar,
  sourceVideo:job.video,jobId:job.id,phase:{bottom:phase.start,top:phase.top,fullEnd:phase.full_end,origin:'legacy_automatic_not_human'},
  rawCacheSha256:cache.sha256,measurement});
}
assert.equal(rows.length,62);
function summarize(rows,when,point){
 const r={total:rows.length,unavailable:0,near:0,TP:0,FN:0,FP:0,TN:0};
 for(const row of rows){
  const state=row.measurement[when]?.[point]?.state;
  if(!state){r.unavailable++;continue;}if(state==='near'){r.near++;continue;}
  const predicted=state==='below';r[row.label===1?(predicted?'TP':'FN'):(predicted?'FP':'TN')]++;
 }
 return r;
}
const summary={};for(const when of ['top','peak'])for(const point of ['nose','mouth'])summary[when+'_'+point]=summarize(rows,when,point);
const groups=[...new Set(rows.map(r=>r.group))];
const report={schema:1,reviewSha256:gate.reviewSha256,protocol:TOP_PROXY_PROTOCOL,testUsed:false,summary,
 unavailableReasons:Object.fromEntries([...new Set(rows.filter(r=>r.measurement.state==='unavailable').map(r=>r.measurement.reason))].map(reason=>[reason,rows.filter(r=>r.measurement.reason===reason).length])),
 byGroup:groups.map(group=>({group,n:rows.filter(r=>r.group===group).length,top_mouth:summarize(rows.filter(r=>r.group===group),'top','mouth')})),
 limitations:['Targeted development subset, 55 upper-height errors and only seven normal tops; not representative test accuracy.',
 'Nose and mouth are facial proxies. Their crossing cannot prove chin-over-bar height.',
 'The wrist line is only an estimated bar level and can be offset by grip, pose errors and projection.',
 'Automatic top timestamps can be wrong; peak scans only this ascent and uses median triples.',
 'Disagreement is not evidence that the prior human label is wrong. Raw labels remain unchanged.'],rows};
fs.writeFileSync(out+'/results.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({summary,reasons:report.unavailableReasons,normals:rows.filter(r=>r.label===0).map(r=>({uid:r.uid,state:r.measurement.state,top:r.measurement.top,reason:r.measurement.reason}))},null,2));
