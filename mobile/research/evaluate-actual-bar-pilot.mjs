import fs from 'node:fs';import zlib from 'node:zlib';import crypto from 'node:crypto';import assert from 'node:assert/strict';
import {actualBarReference,wristPriorReference,measureFaceHeight,BAR_PILOT_RULES} from './actual-bar-height.mjs';
const args=process.argv.slice(2);assert(args.length===0||args.length===2&&args[0]==='--pilot');
const version=args[1]??'actual-bar-pilot-v2';assert(/^[a-z0-9-]+$/.test(version));
const base='pullups/dataset_mediapipe_gpu',folder=base+'/human-reviews/'+version;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),read=p=>JSON.parse(fs.readFileSync(p));
const raw=fs.readFileSync(folder+'/selection.json'),selection=JSON.parse(raw),calRaw=fs.readFileSync(folder+'/calibration.json'),cal=JSON.parse(calRaw);
assert.equal(cal.selectionSha256,sha(raw));assert(!fs.existsSync(folder+'/results.json'),'Results exist; use a new pilot directory.');
const auditRaw=fs.readFileSync(base+'/human-reviews/pose-face-audit-v2/rows.json.gz');assert.equal(selection.protocol.auditSha256,sha(auditRaw));
const audit=new Map(JSON.parse(zlib.gunzipSync(auditRaw)).rows.map(r=>[r.uid,r]));
const priorRaw=fs.readFileSync(base+'/human-reviews/top-proxy-v1/bar-offset-audit-v1/torso-prior.json'),prior=JSON.parse(priorRaw);
const cals=new Map(cal.rows.map(r=>[r.scene,r]));
const protocol={schema:1,testUsed:false,parameters:BAR_PILOT_RULES,selectionSha256:sha(raw),calibrationSha256:sha(calRaw),
 priorSha256:sha(priorRaw),fitting:false,
 comparison:'A: frozen wrist proxy from prior audit; B: common face sampler + validated initial wrist/offset reference, without late wrist gating; C: same sampler + image bar. Compare B/C on identical accepted camera scenes. Report attempted scenes and all abstentions.',
 interpretation:'Only nose/mouth relative height. Above is unresolved, never a correct chin or repetition verdict. Agent calibration with approximate uncertainty, targeted development scenes and previous prior images overlap: not independent test accuracy.',
 sources:Object.fromEntries(['mobile/research/evaluate-actual-bar-pilot.mjs','mobile/research/actual-bar-height.mjs',
  'mobile/app/pose-face.mjs','mobile/research/pullup-top-proxy.mjs','pullups/prepare_actual_bar_pilot.py'].map(p=>[p,sha(fs.readFileSync(p))]))};
const rows=[],scenes=[];
for(const s of selection.scenes){
 const c=cals.get(s.id);assert(c);const reference=actualBarReference(c);
 const bytes=fs.readFileSync(base+'/poses/'+s.id+'.json.gz');assert.equal(sha(bytes),s.cacheSha256);
 const frames=JSON.parse(zlib.gunzipSync(bytes)).frames;
 scenes.push({id:s.id,number:s.number,reviewed:s.samples.length,reference});
 for(const sample of s.samples){
  const old=audit.get(sample.uid);assert(old&&old.screened&&old.split!=='test');
  const start=sample.start*1000,top=sample.top*1000;
  rows.push({uid:sample.uid,group:old.group,scene:s.id,label:old.topLabel,phase:sample,
   sceneAccepted:reference.state==='ready',
   A_frozen:old.shiftedPeakMouth,
   B_commonWrist:measureFaceHeight(frames,start,top,wristPriorReference(old.proxy,prior)),
   C_actualBar:measureFaceHeight(frames,start,top,reference)});
 }
}
const summarize=(input,key)=>{
 const table={normal:{below:0,above:0,uncertain:0,unavailable:0},error:{below:0,above:0,uncertain:0,unavailable:0}};
 for(const r of input){assert([0,1].includes(r.label));const state=key==='A_frozen'?r[key].state:r[key].mouth?.state??'unavailable';table[r.label?'error':'normal'][state]++;}
 return table;
};
const methods=['A_frozen','B_commonWrist','C_actualBar'],accepted=rows.filter(r=>r.sceneAccepted);
const summary={attemptedScenes:scenes.length,acceptedScenes:scenes.filter(s=>s.reference.state==='ready').length,
 reviewed:rows.length,evaluatedInAcceptedScenes:accepted.length,groups:new Set(accepted.map(r=>r.group)).size,
 sceneRefusals:scenes.filter(s=>s.reference.state!=='ready'),
 attemptedAll:Object.fromEntries(methods.map(k=>[k,summarize(rows,k)])),
 pairedAccepted:Object.fromEntries(methods.map(k=>[k,summarize(accepted,k)])),
 newPossibleFalseWarnings:accepted.filter(r=>r.label===0&&r.C_actualBar.mouth?.state==='below').map(r=>r.uid)};
fs.writeFileSync(folder+'/measurement-protocol.json',JSON.stringify(protocol,null,2)+'\n');
fs.writeFileSync(folder+'/results.json',JSON.stringify({summary,scenes,rows},null,2)+'\n');
for(const p of Object.keys(protocol.sources)){const to=folder+'/sources/'+p;fs.mkdirSync(to.slice(0,to.lastIndexOf('/')),{recursive:true});fs.copyFileSync(p,to);}
console.log(JSON.stringify(summary,null,2));
