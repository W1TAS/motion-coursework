// Looser event matching prevents a late bottom from hiding its classification error.
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {initialBottom2D,scaledFaceState} from './stream-criterion-helpers.mjs';
import {measureTopProxy} from './pullup-top-proxy.mjs';
const base='pullups/dataset_mediapipe_gpu',human=base+'/human-reviews';
const prior=JSON.parse(fs.readFileSync(human+'/top-proxy-v1/bar-offset-audit-v1/torso-prior.json'));
for(const name of ['stream-criteria-v1','stream-ascent-v1']){
 const results=JSON.parse(fs.readFileSync(human+'/'+name+'/results.json')),caches=new Map(),rows=[];
 const metrics={total:results.rows.length,matched:0,bottom:{TP:0,FN:0,FP:0,TN:0,unavailable:0},
  upper:{belowError:0,belowNormal:0,aboveError:0,aboveNormal:0,uncertain:0,unavailable:0}};
 for(const r of results.rows){
  assert.notEqual(r.split,'test');
  const rep=r.topOnlyMatch; let bottom=null,upper=null;
  if(rep){
   metrics.matched++;
   if(!caches.has(r.jobId)){
    const bytes=fs.readFileSync(base+'/poses/'+r.jobId+'.json.gz');
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),r.rawCacheSha256);
    caches.set(r.jobId,JSON.parse(zlib.gunzipSync(bytes)).frames);
   }
   const frames=caches.get(r.jobId).filter(f=>f.now<=rep.emittedAt);
   bottom=initialBottom2D(frames,rep.sampleStart,rep.top);
   upper=scaledFaceState(measureTopProxy(frames,rep.sampleStart,rep.top),prior);
  }
  if(bottom?.state==='measured')metrics.bottom[r.labels.bottom_incomplete?(bottom.predictedError?'TP':'FN'):(bottom.predictedError?'FP':'TN')]++;
  else metrics.bottom.unavailable++;
  const state=upper?.state??'unavailable';
  if(['above','below'].includes(state))metrics.upper[state+(r.labels.top_below_bar?'Error':'Normal')]++;
  else metrics.upper[state]++;
  rows.push({uid:r.uid,group:r.group,labels:r.labels,bottom,upper,
   bottomOffsetMs:rep?rep.sampleStart-r.reference.bottom:null,topOffsetMs:rep?rep.top-r.reference.top:null});
 }
 const report={schema:1,reviewSha256:results.reviewSha256,testUsed:false,
  matching:'Top within ±400ms, ordered one-to-one, no bottom constraint. The same event with a wrong bottom remains in the assessment.',
  limitation:'Reference tops mostly automatic; precision of additional unreviewed detected events cannot be established from this subset.',metrics,rows};
 fs.writeFileSync(human+'/'+name+'/top-matched-diagnostic.json',JSON.stringify(report,null,2)+'\n');
 console.log(name,JSON.stringify(metrics), 'falseBottom',rows.filter(r=>r.bottom?.predictedError&&!r.labels.bottom_incomplete).map(r=>r.uid));
}
