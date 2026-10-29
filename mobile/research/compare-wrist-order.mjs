// Paired development regression: change support endpoint ordering only, no fitting.
import fs from 'node:fs';import path from 'node:path';import zlib from 'node:zlib';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
import {assessPullupTop,measureTopProxy} from '../app/pullup-top.mjs';
import {measureAutomaticBottom} from '../app/pullup-bottom.mjs';
import {PullupPhaseEngine} from '../app/pullup-phases.mjs';
import {matchEvents} from './stream-criterion-helpers.mjs';
const [out,baseline,...traceFolders]=process.argv.slice(2);
assert(out&&baseline,'Usage: node compare-wrist-order.mjs OUT FROZEN_APP_FOLDER [TRACE_FOLDER...]');assert(!fs.existsSync(out),'Use a new output version.');
const inputs={},sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=file=>{const raw=fs.readFileSync(file);inputs[file]=sha(raw);return JSON.parse(raw);};
fs.mkdirSync(out,{recursive:true});
// The phase/angle helper is unchanged by this patch; freeze that dependency too.
for(const name of ['pullup-top.mjs','pullup-bottom.mjs','pose-face.mjs','pullup-engine.mjs','engine.mjs']){
 const source=fs.existsSync(path.join(baseline,name))?path.join(baseline,name):'mobile/app/'+name;
 const dest=path.join(out,'before',name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(source,dest);inputs[source]=sha(fs.readFileSync(source));
}
const before=await import(pathToFileURL(path.resolve(out,'before/pullup-top.mjs'))),bottomBefore=await import(pathToFileURL(path.resolve(out,'before/pullup-bottom.mjs')));
const prior=read('mobile/app/models/pullup-top-prior.json');
function compare(frames){
 const engine=new PullupPhaseEngine(),events=[];
 for(let i=0;i<frames.length;i++){
  const f=frames[i],n=engine.ascents.length;engine.update(f.landmarks,f.now,f.width,f.height);
  if(engine.ascents.length>n){
   const rep=engine.ascents.at(-1),prefix=frames.slice(0,i+1),old=before.assessPullupTop(prefix,rep,prior),next=assessPullupTop(prefix,rep,prior);
   events.push({...rep,before:old,after:next,bottomBefore:bottomBefore.measureAutomaticBottom(prefix,rep),bottomAfter:measureAutomaticBottom(prefix,rep),
    referenceBefore:before.measureTopProxy(prefix,rep.sampleStart,rep.top).reference,referenceAfter:measureTopProxy(prefix,rep.sampleStart,rep.top).reference});
  }
 }return {events,cycles:engine.count};
}
const base='pullups/dataset_mediapipe_gpu',selected=read(base+'/human-reviews/static-front-v2/results.json').rows.filter(r=>r.accepted),jobs=new Map(read(base+'/manifest.json').jobs.map(j=>[j.id,j]));
const rows=[],runs=[],traces=[];
for(const id of new Set(selected.map(r=>r.scene))){
 const job=jobs.get(id);assert(job.samples.every(s=>s.split!=='test'));
 const file=base+'/poses/'+id+'.json.gz',raw=fs.readFileSync(file),cache=JSON.parse(zlib.gunzipSync(raw));inputs[file]=sha(raw);assert.equal(cache.fingerprint,job.fingerprint);
 const result=compare(cache.frames),samples=selected.filter(r=>r.scene===id),refs=samples.map(r=>({bottom:r.phase.start*1000,top:r.phase.top*1000})),pairs=new Map(matchEvents(refs,result.events,{bottomMs:Infinity,topMs:400}));
 for(let i=0;i<samples.length;i++)rows.push({uid:samples[i].uid,group:samples[i].group,label:samples[i].labels.top_below_bar,event:pairs.has(i)?result.events[pairs.get(i)]:null});
 runs.push({scene:id,ascents:result.events.length,cycles:result.cycles});
}
for(const folder of traceFolders)for(const name of fs.readdirSync(folder).filter(n=>n.endsWith('.json')).sort()){
 const file=path.join(folder,name),run=read(file);if(!run.frames)continue;traces.push({file,...compare(run.frames)});
}
function table(side){const result={normal:{above:0,below:0,uncertain:0,unavailable:0},error:{above:0,below:0,uncertain:0,unavailable:0},unmatched:0};for(const r of rows){result[r.label?'error':'normal'][r.event?.[side].state??'unavailable']++;if(!r.event)result.unmatched++;}return result;}
const summary={before:table('before'),after:table('after'),changes:rows.filter(r=>r.event?.before.state!==r.event?.after.state).map(r=>({uid:r.uid,before:r.event.before.state,after:r.event.after.state})),
 traceChanges:traces.flatMap(r=>r.events.filter(e=>e.before.state!==e.after.state).map(e=>({file:r.file,index:e.index,before:e.before.state,after:e.after.state,jitterBefore:e.referenceBefore?.jitterPixels,jitterAfter:e.referenceAfter?.jitterPixels}))) };
const sources=['mobile/research/compare-wrist-order.mjs','mobile/app/pullup-top.mjs','mobile/app/pullup-bottom.mjs','mobile/app/pullup-phases.mjs','mobile/app/pullup-engine.mjs','mobile/app/pose-face.mjs','mobile/research/stream-criterion-helpers.mjs'];
for(const file of sources){const dest=path.join(out,'sources',file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(file,dest);}
fs.writeFileSync(path.join(out,'protocol.json'),JSON.stringify({inputs,sources:Object.fromEntries(sources.map(p=>[p,sha(fs.readFileSync(p))])),testUsed:false,fitting:false,
 scope:'Same fixed 50 static/front development examples, same cached frames, same phase events/matching/labels and same thresholds. Compare frozen semantic hand endpoints with image-ordered endpoints. All unmatched and abstentions retained. Fresh runtime traces are diagnostic replays, not new independent people.'},null,2)+'\n');
fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({summary,runs,rows,traces},null,2)+'\n');console.log(JSON.stringify(summary,null,2));
