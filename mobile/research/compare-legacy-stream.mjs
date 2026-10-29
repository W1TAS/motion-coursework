// Retrospective development regression, not a fresh held-out accuracy estimate.
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {PullupPhaseEngine as Baseline} from './baseline-phases-0.1.9.mjs';
import {PullupPhaseEngine} from '../app/pullup-phases.mjs';
import {PullupModelSession,extractModelFeatures,classifyFeatures} from '../app/pullup-model.mjs';

const args=process.argv.slice(2);assert(args.length===0||args.length===2&&args[0]==='--out');
const version=args[1]??'legacy-stream-regression-v1';assert(/^[a-z0-9-]+$/.test(version));
const base='pullups/dataset_mediapipe_gpu',out=base+'/human-reviews/'+version;
const bytes=p=>fs.readFileSync(p),read=p=>JSON.parse(bytes(p));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const deployedPath='mobile/app/models/pullup-hgb.json',retrainedPath=base+'/model/pullup-hgb.json';
const deployed=read(deployedPath),retrained=read(retrainedPath);
const protocol={schema:1,testUsed:false,split:'original train + val; no split or label edits',
 input:'Every chronological pose cache belonging entirely to development. No reference phases enter the detectors.',
 regression:'Frozen 0.1.9 full-cycle detector versus current; assert identical full-cycle fields, then use identical legacy HGB features and thresholds.',
 classifierComparison:'Deployed versus previously retrained HGB on the same detected full cycles; fixed one-to-one interval IoU >= 0.5 against original labels.',
 limitations:['Development replay, not independent generalization accuracy.',
  'Original partial labels merge initial and upper errors; they cannot score the new bottom criterion separately.',
  'Unmatched movements lack exhaustive labels and are not automatically false positives.',
  'Original pose caches lack world landmarks and do not validate 3D measurement or phone throughput.'],
 manifestSha256:sha(bytes(base+'/manifest.json')),
 models:{deployed:sha(bytes(deployedPath)),retrained:sha(bytes(retrainedPath))},
 sourceSha256:Object.fromEntries(['mobile/research/compare-legacy-stream.mjs','mobile/research/baseline-phases-0.1.9.mjs',
  'mobile/app/pullup-phases.mjs','mobile/app/pullup-model.mjs'].map(p=>[p,sha(bytes(p))]))};
if(fs.existsSync(out+'/protocol.json'))assert.deepEqual(read(out+'/protocol.json'),protocol,'Use a new output version.');
const fresh=()=>({tp:0,fp:0,tn:0,fn:0,abstained:0,abstainedPositive:0});
const stats=Object.fromEntries(['partial','swing'].map(t=>[t,{known:0,positive:0,matched:0,matchedPositive:0,deployed:fresh(),retrained:fresh()}]));
const iou=(a,b,c,d)=>Math.max(0,Math.min(b,d)-Math.max(a,c))/(Math.max(b,d)-Math.min(a,c));
const runs=[];
for(const job of read(base+'/manifest.json').jobs){
 if(!job.samples.every(s=>s.split!=='test'))continue;
 const raw=bytes(base+'/poses/'+job.id+'.json.gz'),cache=JSON.parse(zlib.gunzipSync(raw));
 assert.equal(cache.fingerprint,job.fingerprint);
 const before=new Baseline(),current=new PullupPhaseEngine(),session=new PullupModelSession(deployed),cycles=[];
 for(const f of cache.frames){
  before.update(f.landmarks,f.now,f.width,f.height);
  const count=current.count,result=current.update(f.landmarks,f.now,f.width,f.height);
  session.observe(f.landmarks,f.now,f.width,f.height,result.phase);
  if(current.count>count){
   const rep=current.completed.at(-1),extracted=extractModelFeatures(session.frames,rep,session.previous);
   cycles.push({rep,deployed:session.classify(rep),retrained:classifyFeatures(retrained,extracted)});
  }
 }
 assert.deepEqual(current.completed.map(({ascentIndex,contextStart,bottomReference,...r})=>r),before.completed,job.id);
 const pairs=[];cycles.forEach((c,i)=>job.samples.forEach((s,j)=>{
  const overlap=iou(c.rep.sampleStart/1000,c.rep.end/1000,+s.start,+s.end);
  if(overlap>=.5)pairs.push({i,j,overlap});
 }));
 pairs.sort((a,b)=>b.overlap-a.overlap||a.i-b.i||a.j-b.j);
 const usedC=new Set(),usedS=new Set();
 for(const p of pairs){if(usedC.has(p.i)||usedS.has(p.j))continue;usedC.add(p.i);usedS.add(p.j);cycles[p.i].match=job.samples[p.j].uid;}
 const samples=new Map(job.samples.map(s=>[s.uid,s]));
 for(const target of Object.keys(stats)){
  const st=stats[target];
  for(const s of job.samples)if([0,1].includes(+s[target])){st.known++;st.positive+=+s[target];}
  for(const c of cycles){const y=+samples.get(c.match)?.[target];if(![0,1].includes(y))continue;
   st.matched++;st.matchedPositive+=y;
   for(const name of ['deployed','retrained']){const d=c[name].targets[target],s=st[name];
    if(d.state==='unavailable'){s.abstained++;s.abstainedPositive+=y;}
    else s[y?(d.state==='flagged'?'tp':'fn'):(d.state==='flagged'?'fp':'tn')]++;
   }
  }
 }
 runs.push({id:job.id,groups:[...new Set(job.samples.map(s=>s.group))],cacheSha256:sha(raw),
  frames:cache.frames.length,windows:job.samples.length,fullCycles:cycles.length,ascents:current.ascents.length,
  matched:usedC.size,unmatchedLabels:job.samples.filter((s,i)=>!usedS.has(i)).map(s=>s.uid),cycles});
}
for(const st of Object.values(stats))for(const name of ['deployed','retrained']){
 const s=st[name];s.scored=s.tp+s.fp+s.fn+s.tn;s.precision=s.tp+s.fp?s.tp/(s.tp+s.fp):null;
 s.recallOnScoredPositives=s.tp+s.fn?s.tp/(s.tp+s.fn):null;
 s.f1=2*s.tp+s.fp+s.fn?2*s.tp/(2*s.tp+s.fp+s.fn):0;
 s.foundFractionOfAllLabeledPositives=st.positive?s.tp/st.positive:null;
}
const summary={streams:runs.length,groups:new Set(runs.flatMap(r=>r.groups)).size,
 windows:runs.reduce((n,r)=>n+r.windows,0),frames:runs.reduce((n,r)=>n+r.frames,0),
 fullCycles:runs.reduce((n,r)=>n+r.fullCycles,0),ascents:runs.reduce((n,r)=>n+r.ascents,0),
 matched:runs.reduce((n,r)=>n+r.matched,0),fullCycleDifferences:0,stats};
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(out+'/protocol.json',JSON.stringify(protocol,null,2)+'\n');
fs.writeFileSync(out+'/results.json',JSON.stringify({summary,runs},null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
