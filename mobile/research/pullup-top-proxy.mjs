// Research geometry: wrist reference versus nose/mouth. Neither point is a chin.
export const TOP_PROXY_PROTOCOL=Object.freeze({version:'wrist-face-proxy-v1',visibility:.45,
 referenceBeforeMs:200,referenceAfterMs:200,topBeforeMs:200,minFrames:3,minCoverage:.8,
 maxReferenceJitterTorso:.12,maxWristDriftTorso:.25,nearLineTorso:.04,minPixelTolerance:2});
const q=(a,p)=>{const s=a.slice().sort((x,y)=>x-y),k=(s.length-1)*p;return s[Math.floor(k)]+(s[Math.ceil(k)]-s[Math.floor(k)])*(k%1);};
const valid=(p)=>p&&['x','y'].every(k=>Number.isFinite(p[k]))&&p.x>0&&p.x<1&&p.y>0&&p.y<1&&Math.min(p.visibility??0,p.presence??1)>=TOP_PROXY_PROTOCOL.visibility;
const pixel=(p,f)=>({x:p.x*f.width,y:p.y*f.height});
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
export function signedAboveLine(point,a,b){
 if(a.x>b.x)[a,b]=[b,a];
 const length=distance(a,b);
 return length>1e-6?((b.y-a.y)*(point.x-a.x)-(b.x-a.x)*(point.y-a.y))/length:null;
}
export function lineState(clearance,tolerance){
 return clearance>tolerance?'above':clearance< -tolerance?'below':'near';
}
function body(f){
 const p=f.landmarks;
 if(!p||![11,12,15,16,23,24].every(i=>valid(p[i])))return null;
 const shoulder=pixel({x:(p[11].x+p[12].x)/2,y:(p[11].y+p[12].y)/2},f);
 const hip=pixel({x:(p[23].x+p[24].x)/2,y:(p[23].y+p[24].y)/2},f);
 const torso=distance(shoulder,hip),left=pixel(p[15],f),right=pixel(p[16],f);
 if(torso<f.height*.03||hip.y<=shoulder.y||distance(left,right)<torso*.5)return null;
 return {left,right,torso};
}
export function measureTopProxy(frames,startMs,topMs){
 const cfg=TOP_PROXY_PROTOCOL,fail=(reason,extra={})=>({state:'unavailable',reason,protocol:cfg.version,...extra});
 if(!Number.isFinite(startMs)||!Number.isFinite(topMs)||topMs<=startMs)return fail('invalid_phase_bounds');
 const referenceFrames=frames.filter(f=>f.now>=startMs-cfg.referenceBeforeMs&&f.now<=Math.min(topMs,startMs+cfg.referenceAfterMs));
 const reference=referenceFrames.map(body).filter(Boolean);
 if(reference.length<cfg.minFrames||reference.length/referenceFrames.length<cfg.minCoverage)return fail('reference_wrists_unavailable');
 const torso=q(reference.map(r=>r.torso),.5);
 const endpoint=side=>({x:q(reference.map(r=>r[side].x),.5),y:q(reference.map(r=>r[side].y),.5)});
 const left=endpoint('left'),right=endpoint('right');
 const jitter=q(reference.map(r=>Math.max(distance(r.left,left),distance(r.right,right))),.9);
 const tolerance=Math.max(cfg.nearLineTorso*torso,cfg.minPixelTolerance,2*jitter);
 const referenceInfo={left,right,torsoPixels:torso,jitterPixels:jitter,tolerancePixels:tolerance,
  frames:reference.length,width:referenceFrames[0].width,height:referenceFrames[0].height};
 if(jitter>cfg.maxReferenceJitterTorso*torso)return fail('reference_wrists_unstable',{reference:referenceInfo});
 const measured=[];
 for(const f of frames){
  if(f.now<startMs||f.now>topMs)continue;
  const b=body(f),p=f.landmarks;
  if(!b||![0,9,10].every(i=>valid(p[i])))continue;
  if(Math.max(distance(b.left,left),distance(b.right,right))>cfg.maxWristDriftTorso*torso)continue;
  const nose=pixel(p[0],f),mouth=pixel({x:(p[9].x+p[10].x)/2,y:(p[9].y+p[10].y)/2},f);
  // The tracked face must belong between these hands. This is a geometry gate,
  // not identity verification or proof of a front view.
  const lo=Math.min(left.x,right.x)-torso*.2,hi=Math.max(left.x,right.x)+torso*.2;
  if(nose.x<lo||nose.x>hi||mouth.y<nose.y)continue;
  measured.push({now:f.now,nose:signedAboveLine(nose,left,right),mouth:signedAboveLine(mouth,left,right)});
 }
 const topFrames=frames.filter(f=>f.now>=Math.max(startMs,topMs-cfg.topBeforeMs)&&f.now<=topMs);
 const top=measured.filter(f=>f.now>=topMs-cfg.topBeforeMs);
 if(top.length<cfg.minFrames||top.length/topFrames.length<cfg.minCoverage)return fail('top_face_or_wrists_unavailable',{reference:referenceInfo});
 const result=sample=>Object.fromEntries(['nose','mouth'].map(name=>{
  const clearance=q(sample.map(f=>f[name]),.5);
  return [name,{clearancePixels:clearance,clearanceTorso:clearance/torso,state:lineState(clearance,tolerance)}];
 }));
 let peak=null;
 for(let i=2;i<measured.length;i++){
  const triple=measured.slice(i-2,i+1);
  if(triple[2].now-triple[0].now>100)continue;
  const candidate=result(triple);
  if(!peak||candidate.mouth.clearancePixels>peak.mouth.clearancePixels)peak={...candidate,timeMs:triple[1].now};
 }
 return {state:'measured',protocol:cfg.version,reference:referenceInfo,top:result(top),peak,
  quality:{topFrames:topFrames.length,topValid:top.length},
  scope:'Nose/mouth versus a frozen wrist line; not measured bar position or chin height.'};
}
