// Development regression for the temporary app rule, without model fitting.
import fs from 'node:fs';import zlib from 'node:zlib';import crypto from 'node:crypto';import assert from 'node:assert/strict';
import {assessPullupTop} from '../app/pullup-top.mjs';
import {PullupAnalysisSession} from '../app/pullup-rules.mjs';
import {PullupPhaseEngine} from '../app/pullup-phases.mjs';
import {matchEvents} from './stream-criterion-helpers.mjs';
const base='pullups/dataset_mediapipe_gpu',folder=base+'/human-reviews/app-top-integration-v1';
assert(!fs.existsSync(folder),'Use a new version; results are immutable.');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),inputs={};
const read=p=>{const raw=fs.readFileSync(p);inputs[p]=sha(raw);return JSON.parse(raw);};
const old=read(base+'/human-reviews/static-front-v2/results.json'),selected=old.rows.filter(r=>r.accepted);
const prior=read('mobile/app/models/pullup-top-prior.json');
const streams=read(base+'/human-reviews/stream-bottom-quality-v1/results.json');
const manifest=read(base+'/manifest.json'),rows=[],runs=[];
for(const id of new Set(selected.map(r=>r.scene))){
 const job=manifest.jobs.find(j=>j.id===id);assert(job.samples.every(s=>s.split!=='test'));
 const bytes=fs.readFileSync(base+'/poses/'+id+'.json.gz'),cache=JSON.parse(zlib.gunzipSync(bytes));
 assert.equal(cache.fingerprint,job.fingerprint);
 const engine=new PullupPhaseEngine(),session=new PullupAnalysisSession(null,prior);
 for(const f of cache.frames){
  const n=engine.ascents.length,m=engine.update(f.landmarks,f.now,f.width,f.height);
  session.observe(f.landmarks,f.now,f.width,f.height,m.phase,f.worldLandmarks);
  if(engine.ascents.length>n)engine.ascents.at(-1).analysis=session.assessAscent(engine.ascents.at(-1));
 }
 const frozen=streams.streams.find(s=>s.id===id);
 assert.equal(engine.count,frozen.fullCycles);assert.equal(engine.ascents.length,frozen.ascents);
 const samples=selected.filter(r=>r.scene===id),refs=samples.map(r=>({bottom:r.phase.start*1000,top:r.phase.top*1000}));
 const pairs=new Map(matchEvents(refs,engine.ascents,{bottomMs:Infinity,topMs:400}));
 for(let i=0;i<samples.length;i++){
  const r=samples[i],prepared=assessPullupTop(cache.frames,{sampleStart:refs[i].bottom,top:refs[i].top},prior);
  assert.equal(prepared.state,r.topCommon.mouth?.state??'unavailable',r.uid);
  rows.push({uid:r.uid,group:r.group,label:r.labels.top_below_bar,prepared,
   automatic:pairs.has(i)?engine.ascents[pairs.get(i)].analysis.topHeight:{state:'unavailable',reason:'unmatched'}});
 }
 runs.push({id,cacheSha256:sha(bytes),fullCycles:engine.count,ascents:engine.ascents.length});
}
const table=field=>{
 const t={normal:{below:0,above:0,uncertain:0,unavailable:0},error:{below:0,above:0,uncertain:0,unavailable:0}};
 for(const r of rows)t[r.label?'error':'normal'][r[field].state]++;
 return t;
};
const sources=['mobile/research/verify-top-integration.mjs','mobile/app/pullup-top.mjs','mobile/app/pullup-rules.mjs','mobile/app/pullup-phases.mjs','mobile/app/pullup-engine.mjs','mobile/app/pullup-bottom.mjs','mobile/app/pullup-model.mjs','mobile/app/pose-face.mjs','mobile/research/stream-criterion-helpers.mjs'];
const protocol={testUsed:false,fitting:false,inputs,sources:Object.fromEntries(sources.map(p=>[p,sha(fs.readFileSync(p))])),
 scope:'50 fixed static/front development examples. Assert identical prepared mouth states and unchanged ascent/full-cycle counts. Automatic app adds onset-loss abstention. Cached 2D, not fresh camera/phone accuracy.'};
fs.mkdirSync(folder,{recursive:true});
const summary={n:rows.length,groups:new Set(rows.map(r=>r.group)).size,prepared:table('prepared'),automatic:table('automatic')};
fs.writeFileSync(folder+'/protocol.json',JSON.stringify(protocol,null,2)+'\n');
fs.writeFileSync(folder+'/results.json',JSON.stringify({summary,runs,rows},null,2)+'\n');
for(const p of sources){const to=folder+'/sources/'+p;fs.mkdirSync(to.slice(0,to.lastIndexOf('/')),{recursive:true});fs.copyFileSync(p,to);}
console.log(JSON.stringify(summary,null,2));
