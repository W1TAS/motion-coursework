// Analyse immutable browser traces without re-running MediaPipe or fitting rules.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
import {PullupPhaseEngine} from '../app/pullup-phases.mjs';
const args=process.argv.slice(2),runtime=args[0]==='--runtime'?args.splice(0,2)[1]:'mobile/app';
const {measureTopProxy,assessPullupTop}=await import(pathToFileURL(path.resolve(runtime,'pullup-top.mjs')));
const [out,...folders]=args;
assert(out&&folders.length,'Usage: node summarize-top-runtime.mjs [--runtime FROZEN_APP] OUT INPUT_FOLDER...');
assert(!fs.existsSync(out),'Use a new output version.');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),inputs={},rows=[];
const priorPath='mobile/app/models/pullup-top-prior.json',priorBytes=fs.readFileSync(priorPath),prior=JSON.parse(priorBytes);inputs[priorPath]=sha(priorBytes);
for(const folder of folders)for(const name of fs.readdirSync(folder).filter(n=>n.endsWith('.json')).sort()){
 const file=path.join(folder,name),bytes=fs.readFileSync(file),run=JSON.parse(bytes);if(!run.frames)continue;
 inputs[file]=sha(bytes);
 const engine=new PullupPhaseEngine(),events=[];
 for(let index=0;index<run.frames.length;index++){
  const f=run.frames[index];
  const before=engine.ascents.length,result=engine.update(f.landmarks,f.now,f.width,f.height);
  if(engine.ascents.length>before){
   const event=engine.ascents.at(-1),answer=assessPullupTop(run.frames.slice(0,index+1),event,prior);
   const reference=measureTopProxy(run.frames.filter(v=>v.now<=f.now),event.sampleStart,event.top).reference;
   events.push({startMs:event.sampleStart,topMs:event.top,confirmedAt:event.confirmedAt,answer,reference});
  }
 }
 const saved=run.events?.map(e=>e.analysis.topHeight)??run.decisions?.filter(d=>d.type==='ascent-decision').map(d=>d.decision.topHeight);
 if(saved){assert.equal(events.length,saved.length,file);events.forEach((e,i)=>assert.deepEqual(e.answer,saved[i],file+' replay'));}
 const gaps=run.frames.slice(1).map((f,i)=>f.now-run.frames[i].now),clockErrors=run.frames.slice(1).map((f,i)=>(f.detectorNow-run.frames[i].detectorNow)-(f.now-run.frames[i].now));
 rows.push({file,profile:run.profile??'actual-app',sample:run.sample??run.meta?.sample,frames:run.frames.length,
  firstTimesMs:run.frames.slice(0,12).map(f=>f.now),firstGapMs:gaps[0],largestGapMs:Math.max(...gaps),
  maxClockDeltaErrorMs:Math.max(...clockErrors.map(Math.abs)),lifecycle:run.lifecycle,
  poseSha256:sha(JSON.stringify(run.frames.map(f=>f.landmarks))),events});
}
const a=rows.find(r=>r.profile==='media'),b=rows.find(r=>r.profile==='media-repeat');
if(a&&b){assert.equal(a.poseSha256,b.poseSha256,'Identical pictures and clocks must reproduce identical pose coordinates');assert.deepEqual(a.events,b.events);}
const sourceFiles=['mobile/research/summarize-top-runtime.mjs','mobile/app/pullup-phases.mjs','mobile/app/pullup-engine.mjs','mobile/app/engine.mjs',path.join(runtime,'pullup-top.mjs'),path.join(runtime,'pose-face.mjs')];
fs.mkdirSync(out,{recursive:true});for(const file of sourceFiles){const to=path.join(out,'sources',file);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(file,to);}
const sourceHashes=Object.fromEntries(sourceFiles.map(f=>[f,sha(fs.readFileSync(f))]));
fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({inputs,sources:sourceHashes,rows,
 scope:'Causal replay must exactly reproduce every stored early-height result. Timestamp-isolation and repeatability diagnosis on selected development demos; no fitting or general accuracy estimate.'},null,2)+'\n');
console.log(JSON.stringify(rows.map(r=>({file:r.file,frames:r.frames,firstGapMs:r.firstGapMs,maxClockDeltaErrorMs:r.maxClockDeltaErrorMs,
 events:r.events.map(e=>({start:e.startMs,top:e.topMs,state:e.answer.state,reason:e.answer.reason,jitter:e.reference?.jitterPixels,
  margin:e.answer.mouth?.clearanceIntervalPixels?.[0]-e.answer.mouth?.tolerancePixels}))})),null,2));
