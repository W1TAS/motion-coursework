import {visibleFacePoints} from '../app/pose-face.mjs';

export const FACE_AUDIT_RULES=Object.freeze({windowMs:200,minFrames:3,minCoverage:.8,
 maxFrameGapMs:80,maxPointGapMs:120,maxRelativeJump:.12,confidence:.45});
export const FACE_CUES=Object.freeze({nose:[0],mouth:[9,10],eyes:[2,5],ears:[7,8]});
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const middle=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
function bodyReference(f){
 const p=f.landmarks;
 const valid=i=>p?.[i]&&Number.isFinite(p[i].x)&&Number.isFinite(p[i].y)&&Math.min(p[i].visibility??0,p[i].presence??1)>=.45;
 if(![11,12,23,24].every(valid))return null;
 const pixel=i=>({x:p[i].x*f.width,y:p[i].y*f.height});
 const shoulder=middle(pixel(11),pixel(12)),hip=middle(pixel(23),pixel(24)),scale=distance(shoulder,hip);
 return scale>f.height*.03?{shoulder,scale}:null;
}
export function auditFaceWindow(frames,startMs,topMs){
 const cfg=FACE_AUDIT_RULES;
 if(!Number.isFinite(startMs)||!Number.isFinite(topMs)||startMs>=topMs)return {state:'invalid_phase'};
 const begin=Math.max(startMs,topMs-cfg.windowMs);
 const local=frames.filter(f=>f.now>=begin-1e-3&&f.now<=topMs+1e-3).sort((a,b)=>a.now-b.now);
 const rows=local.map(f=>({now:f.now,points:new Map(visibleFacePoints(f.landmarks,f.width,f.height).map(p=>[p.id,p])),body:bodyReference(f)}));
 const maxGap=a=>a.length>1?Math.max(...a.slice(1).map((r,i)=>r.now-a[i].now)):null;
 const windowCovered=rows.length>=cfg.minFrames&&rows[0].now<=begin+40+1e-3&&rows.at(-1).now>=topMs-40-1e-3&&maxGap(rows)<=cfg.maxFrameGapMs+1e-3;
 const parts={};
 for(const [name,ids]of Object.entries(FACE_CUES)){
  const good=rows.filter(r=>ids.every(i=>r.points.has(i))).map(r=>{
   const point=ids.map(i=>r.points.get(i)).reduce((a,p)=>({x:a.x+p.x/ids.length,y:a.y+p.y/ids.length}),{x:0,y:0});
   return {now:r.now,relative:r.body?{x:(point.x-r.body.shoulder.x)/r.body.scale,y:(point.y-r.body.shoulder.y)/r.body.scale}:null};
  });
  const jumps=[];
  for(let i=1;i<good.length;i++)if(good[i].now-good[i-1].now<=cfg.maxFrameGapMs+1e-3&&good[i].relative&&good[i-1].relative)jumps.push({value:distance(good[i].relative,good[i-1].relative),from:good[i-1].now,to:good[i].now});
  const coverage=rows.length?good.length/rows.length:0;
  const available=windowCovered&&good.length>=cfg.minFrames&&coverage>=cfg.minCoverage&&maxGap(good)<=cfg.maxPointGapMs+1e-3;
  const largest=jumps.slice().sort((a,b)=>b.value-a.value)[0],maxRelativeJump=largest?.value??null;
  // A screening flag, not a measured landmark error or exercise verdict.
  parts[name]={validFrames:good.length,coverage,available,relativeComparisons:jumps.length,maxRelativeJump,
   maxJumpTimes:largest?[largest.from,largest.to]:null,
   jumpFlag:maxRelativeJump===null?null:maxRelativeJump>cfg.maxRelativeJump,
   stableCandidate:available&&jumps.length>=2&&maxRelativeJump<=cfg.maxRelativeJump};
 }
 const anyFrames=rows.filter(r=>r.points.size>0).length;
 return {state:'audited',frames:rows.length,windowCovered,beginMs:begin,topMs,
  anyFaceFrames:anyFrames,anyFaceAvailable:windowCovered&&anyFrames>=cfg.minFrames&&anyFrames/rows.length>=cfg.minCoverage,
  perPointValidFrames:Object.fromEntries(Array.from({length:11},(_,i)=>[i,rows.filter(r=>r.points.has(i)).length])),parts,
  availableCue:Object.keys(FACE_CUES).find(k=>parts[k].available)??null,
 stableCue:Object.keys(FACE_CUES).find(k=>parts[k].stableCandidate)??null};
}

export function summarizeFaceAudits(audits){
 const count=fn=>audits.filter(a=>a.state==='audited'&&fn(a)).length;
 return {windows:audits.length,invalidPhases:audits.filter(a=>a.state!=='audited').length,noFrames:count(a=>a.frames===0),
  windowCovered:count(a=>a.windowCovered),anyFaceAvailable:count(a=>a.anyFaceAvailable),
  anyCueAvailable:count(a=>a.availableCue!==null),anyCueStableCandidate:count(a=>a.stableCue!==null),
  noFaceAtAll:count(a=>a.frames>0&&a.anyFaceFrames===0),
  parts:Object.fromEntries(Object.keys(FACE_CUES).map(k=>[k,{available:count(a=>a.parts[k].available),
   jumpFlag:count(a=>a.parts[k].jumpFlag===true),stableCandidate:count(a=>a.parts[k].stableCandidate)}]))};
}
