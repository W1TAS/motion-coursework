import fs from 'node:fs';import {PullupEngine} from '../app/pullup-engine.mjs';import {PullupModelSession,extractModelFeatures} from '../app/pullup-model.mjs';
const model=JSON.parse(fs.readFileSync('mobile/app/models/pullup-hgb.json'));const cases=[],runs=[];
for(let i=1;i<=3;i++){
 const frames=JSON.parse(fs.readFileSync(`mobile/research/poses/pullup-stream-${i}.json`)),engine=new PullupEngine(),session=new PullupModelSession(model),results=[];
 for(const f of frames){
  const before=engine.count,r=engine.update(f.landmarks,f.now,f.width,f.height);session.observe(f.landmarks,f.now,f.width,f.height,r.phase);
  if(engine.count>before){const rep=engine.completed.at(-1),features=extractModelFeatures(session.frames,rep,session.previous);
   cases.push({id:`${i}-${rep.index}`,frames:session.frames.slice(),rep,previous:session.previous.slice(),features:features?.features??null});
   const start=performance.now(),decision=session.classify(rep);results.push({rep,decision,elapsedMs:performance.now()-start});
  }
 }
 runs.push({id:i,processedFrames:frames.length,duration:frames.at(-1).now/1000,results});
 console.log(i,results.map(r=>({rep:r.rep.index,rules:r.rep.amplitude,partial:r.decision.targets.partial,swing:r.decision.targets.swing,ms:Math.round(r.elapsedMs)})));
}
fs.writeFileSync('mobile/research/stream-model-evaluation.json',JSON.stringify({note:'Development replay; no thresholds fitted; cached MediaPipe frames, not independent accuracy evaluation',modelSha256:model.sourceSha256,runs},null,2));
fs.writeFileSync('mobile/research/stream-feature-fixtures.json',JSON.stringify(cases));
