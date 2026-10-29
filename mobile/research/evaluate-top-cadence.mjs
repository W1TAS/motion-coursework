// Simulate sparse processing of fixed development streams, not new phone accuracy.
import fs from 'node:fs';import zlib from 'node:zlib';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
import {assessPullupTop,TOP_SAMPLING_RULES} from '../app/pullup-top.mjs';
import {PullupPhaseEngine} from '../app/pullup-phases.mjs';
import {matchEvents} from './stream-criterion-helpers.mjs';
const base='pullups/dataset_mediapipe_gpu',out=base+'/human-reviews/top-cadence-v1';
assert(!fs.existsSync(out),'Use a new version; never overwrite experiment results.');
const inputs={},sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=p=>{const b=fs.readFileSync(p);inputs[p]=sha(b);return JSON.parse(b);};
const frozen=base+'/human-reviews/app-top-integration-v1/sources/mobile/app/pullup-top.mjs';
const old=await import(pathToFileURL(process.cwd()+'/'+frozen));inputs[frozen]=sha(fs.readFileSync(frozen));
const prior=read('mobile/app/models/pullup-top-prior.json');
const selected=read(base+'/human-reviews/static-front-v2/results.json').rows.filter(r=>r.accepted);
const jobs=new Map(read(base+'/manifest.json').jobs.map(j=>[j.id,j]));
function thin(frames,fps){
 if(!fps)return frames;
 const result=[];let i=0,last=-1;
 for(let t=frames[0].now;t<=frames.at(-1).now;t+=1000/fps){
  while(i+1<frames.length&&Math.abs(frames[i+1].now-t)<=Math.abs(frames[i].now-t))i++;
  if(i!==last){result.push(frames[i]);last=i;}
 }
 return result;
}
const rows=[],runs=[];
for(const id of new Set(selected.map(r=>r.scene))){
 const job=jobs.get(id);assert(job.samples.every(r=>r.split!=='test'));
 const raw=fs.readFileSync(base+'/poses/'+id+'.json.gz'),cache=JSON.parse(zlib.gunzipSync(raw));
 assert.equal(cache.fingerprint,job.fingerprint);inputs[base+'/poses/'+id+'.json.gz']=sha(raw);
 const samples=selected.filter(r=>r.scene===id),refs=samples.map(r=>({bottom:r.phase.start*1000,top:r.phase.top*1000}));
 for(const fps of [null,15,12,10,5]){
  const frames=thin(cache.frames,fps),engine=new PullupPhaseEngine(),events=[];
  const profile=fps===null?'native':String(fps);
  for(const f of frames){
   const n=engine.ascents.length;engine.update(f.landmarks,f.now,f.width,f.height);
   if(engine.ascents.length>n){
    const rep=engine.ascents.at(-1),causal=frames.filter(r=>r.now<=f.now);
    const before=old.assessPullupTop(causal,rep,prior),after=assessPullupTop(causal,rep,prior);
    if(fps===null)assert.equal(after.state,before.state,id+' native');
    events.push({...rep,before,after});
   }
  }
  const pairs=new Map(matchEvents(refs,events,{bottomMs:Infinity,topMs:400}));
  for(let i=0;i<samples.length;i++){
   const e=pairs.has(i)?events[pairs.get(i)]:null;
   rows.push({uid:samples[i].uid,group:samples[i].group,profile,label:samples[i].labels.top_below_bar,
    matched:Boolean(e),before:e?.before??{state:'unavailable',reason:'unmatched'},after:e?.after??{state:'unavailable',reason:'unmatched'}});
  }
  runs.push({id,profile,processed:frames.length,ascents:engine.ascents.length,fullCycles:engine.count,matched:pairs.size});
 }
}
function table(input,key){
 const t={normal:{below:0,above:0,uncertain:0,unavailable:0},error:{below:0,above:0,uncertain:0,unavailable:0},unmatched:0,noSustainedPeak:0};
 for(const r of input){t[r.label?'error':'normal'][r[key].state]++;if(!r.matched)t.unmatched++;if(r[key].reason==='Не найден устойчивый верх')t.noSustainedPeak++;}
 return t;
}
const summary=Object.fromEntries(['native','15','12','10','5'].map(profile=>{
 const input=rows.filter(r=>r.profile===profile);
 return [profile,{n:input.length,before:table(input,'before'),after:table(input,'after'),
  recoveredFromPeakFailure:input.filter(r=>r.before.reason==='Не найден устойчивый верх'&&r.after.state!=='unavailable').length,
  newNormalWarnings:input.filter(r=>r.label===0&&r.after.state==='below'&&r.before.state!=='below').map(r=>r.uid)}];
}));
const sources=['mobile/research/evaluate-top-cadence.mjs','mobile/app/pullup-top.mjs','mobile/app/pullup-phases.mjs','mobile/app/pullup-engine.mjs','mobile/app/pose-face.mjs','mobile/research/stream-criterion-helpers.mjs'];
const protocol={testUsed:false,fitting:false,inputs,rules:TOP_SAMPLING_RULES,sources:Object.fromEntries(sources.map(p=>[p,sha(fs.readFileSync(p))])),
 scope:'Same fixed 50 static/front development labels. Drop original frames to a uniform target grid, no interpolation. Old/new use identical causal frames, identical detected events and matching. Native states must remain equal. This simulates processing cadence, not fresh MediaPipe tracking or Android throughput. All unmatched, uncertain and unavailable cases retained.'};
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(out+'/protocol.json',JSON.stringify(protocol,null,2)+'\n');
fs.writeFileSync(out+'/results.json',JSON.stringify({summary,runs,rows},null,2)+'\n');
for(const p of sources){const to=out+'/sources/'+p;fs.mkdirSync(to.slice(0,to.lastIndexOf('/')),{recursive:true});fs.copyFileSync(p,to);}
console.log(JSON.stringify(summary,null,2));
