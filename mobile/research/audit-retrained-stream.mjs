// Held-out replay of the current online counter + both classifiers.
// No fitting or threshold selection. Cached MediaPipe poses, not a phone benchmark.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PullupEngine} from '../app/pullup-engine.mjs';
import {PullupPhaseEngine} from '../app/pullup-phases.mjs';
import {PullupAnalysisSession} from '../app/pullup-rules.mjs';
import {PullupModelSession,extractModelFeatures,classifyFeatures} from '../app/pullup-model.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const phase=process.argv.includes('--phase');
const dir=path.resolve(process.argv.slice(2).find(a=>!a.startsWith('--'))??path.join(root,'pullups/dataset_mediapipe_gpu'));
const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));
const old=JSON.parse(fs.readFileSync(path.join(root,'mobile/app/models/pullup-hgb.json')));
const trained=JSON.parse(fs.readFileSync(path.join(dir,'model/pullup-hgb.json')));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const jobs=manifest.jobs.filter(j=>j.samples.every(s=>s.split==='test'));
const iou=(a,b,c,d)=>Math.max(0,Math.min(b,d)-Math.max(a,c))/(Math.max(b,d)-Math.min(a,c));
const targets=['partial','swing'];
const stats={};
for(const target of targets)stats[target]={labeled:0,positive:0,matched:0,matchedPositive:0,
  old:{tp:0,fp:0,tn:0,fn:0,abstained:0,abstainedPositive:0},
  retrained:{tp:0,fp:0,tn:0,fn:0,abstained:0,abstainedPositive:0}};
const runs=[];
for(const job of jobs){
 const cached=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir,'poses',job.id+'.json.gz'))));
 if(cached.fingerprint!==job.fingerprint)throw Error('Cache provenance mismatch: '+job.id);
 const engine=new (phase?PullupPhaseEngine:PullupEngine)(),session=new (phase?PullupAnalysisSession:PullupModelSession)(old),cycles=[];
 const invalidReasons={},phases={};let validFrames=0;
 for(const f of cached.frames){
  const before=engine.count,result=engine.update(f.landmarks,f.now,f.width,f.height);
  session.observe(f.landmarks,f.now,f.width,f.height,result.phase);
  phases[result.phase]=(phases[result.phase]??0)+1;
  if(result.valid)validFrames++;else invalidReasons[result.message]=(invalidReasons[result.message]??0)+1;
  if(engine.count>before){
   const rep=engine.completed.at(-1);
   const features=extractModelFeatures(session.frames,rep,session.previous);
   const previousDecision=session.classify(rep);
   cycles.push({rep,old:previousDecision,retrained:classifyFeatures(trained,features),match:null});
  }
 }
 // Descending interval IoU with one-to-one assignment, fixed cutoff 0.5.
 const pairs=[];
 cycles.forEach((c,i)=>job.samples.forEach((s,j)=>{
  const overlap=iou(c.rep.sampleStart/1000,c.rep.end/1000,+s.start,+s.end);
  if(overlap>=.5)pairs.push({i,j,overlap});
 }));
 pairs.sort((a,b)=>b.overlap-a.overlap||a.i-b.i||a.j-b.j);
 const usedCycles=new Set(),usedLabels=new Set();
 for(const pair of pairs){
  if(usedCycles.has(pair.i)||usedLabels.has(pair.j))continue;
  usedCycles.add(pair.i);usedLabels.add(pair.j);
  const sample=job.samples[pair.j];
  cycles[pair.i].match={uid:sample.uid,iou:pair.overlap,labels:Object.fromEntries(targets.map(t=>[t,+sample[t]]))};
 }
 for(const target of targets){
  const st=stats[target];
  for(const sample of job.samples)if(+sample[target]>=0){st.labeled++;st.positive+=+sample[target];}
  for(const cycle of cycles){
   const y=cycle.match?.labels[target];if(y===undefined||y<0)continue;
   st.matched++;st.matchedPositive+=y;
   for(const name of ['old','retrained']){
    const decision=cycle[name].targets[target],s=st[name];
    if(decision.state==='unavailable'){s.abstained++;s.abstainedPositive+=y;continue;}
    const positive=decision.state==='flagged';s[y?(positive?'tp':'fn'):(positive?'fp':'tn')]++;
   }
  }
 }
 runs.push({id:job.id,group:job.samples[0].group,delegate:cached.delegate??job.delegate??'CPU',
  labeledWindows:job.samples.length,frames:cached.frames.length,validFrames,invalidReasons,phases,
  matched:usedCycles.size,unmatchedLabels:job.samples.filter((s,i)=>!usedLabels.has(i)).map(s=>s.uid),cycles});
 console.log(job.id,'cycles',cycles.length,'matched',usedCycles.size,'labels',job.samples.length);
}
for(const st of Object.values(stats))for(const name of ['old','retrained']){
 const s=st[name];s.n=s.tp+s.fp+s.tn+s.fn;
 s.precision=s.tp+s.fp?s.tp/(s.tp+s.fp):0;
 s.recallOnScoredPositives=s.tp+s.fn?s.tp/(s.tp+s.fn):null;
 s.f1=2*s.tp+s.fp+s.fn?2*s.tp/(2*s.tp+s.fp+s.fn):0;
 s.foundFractionOfAllLabeledPositives=st.positive?s.tp/st.positive:null;
}
const summary={segments:runs.length,groups:new Set(runs.map(r=>r.group)).size,
 labeledWindows:runs.reduce((s,r)=>s+r.labeledWindows,0),cycles:runs.reduce((s,r)=>s+r.cycles.length,0),
 matched:runs.reduce((s,r)=>s+r.matched,0),stats};
const result={counter:phase?'phase':'original',protocol:'Held-out cached-pose sequential replay at 25 fps; one-to-one interval IoU >= 0.5; unchanged model thresholds.',
 limitation:'Annotated intervals are not an exhaustive set of all movements. Unmatched cycles are unscored, not automatically false detections. Clipped segment starts, boundary differences and pose/counter failures can cause unmatched labels. This is not actual phone throughput or an all-CPU replay. Test is diagnostic only; do not tune against these labels.',
 modelHashes:{old:old.sourceSha256,retrained:trained.sourceSha256},
 codeHashes:{counter:sha(path.join(root,'mobile/app',phase?'pullup-phases.mjs':'pullup-engine.mjs')),features:sha(path.join(root,'mobile/app/pullup-model.mjs')),analysis:sha(path.join(root,'mobile/app/pullup-rules.mjs'))},summary,runs};
fs.writeFileSync(path.join(dir,'model',phase?'phase-stream-test-audit.json':'stream-test-audit.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(summary,null,2));
