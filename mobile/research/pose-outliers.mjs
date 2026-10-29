// Offline research candidate. Uses future frames; not a camera-stream filter.
// Original caches are immutable. No correction of missing/low-confidence poses.
const joints=[11,12,13,14,15,16,23,24,25,26,27,28];
const bones=[[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],
 [23,24],[23,25],[25,27],[24,26],[26,28]];
const median=a=>a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)];
const valid=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&Math.min(p.visibility??0,p.presence??1)>=.45;
const distance=(a,b,ratio)=>Math.hypot((a.x-b.x)*ratio,a.y-b.y);
const interpolate=(a,b,t)=>({...a,...Object.fromEntries(['x','y','z'].filter(k=>Number.isFinite(a[k])&&Number.isFinite(b[k])).map(k=>[k,a[k]+(b[k]-a[k])*t]))});
function torso(f){
 const p=f.landmarks;if(!p||![11,12,23,24].every(i=>valid(p[i])))return null;
 const r=f.width/f.height;
 return (distance(p[11],p[23],r)+distance(p[12],p[24],r))/2;
}
export const OUTLIER_PROTOCOL=Object.freeze({name:'isolated-pose-outlier-v1',maxFrames:3,maxBracketMs:180,
 minResidualTorso:.35,maxAnchorMotionTorso:.25,maxAnchorResidualTorso:.12,
 boneLengthRatios:[.55,1.6],confidence:.45,scope:'Offline candidate, short isolated joint errors only; no classifier fitting'});
export function repairIsolatedPoseOutliers(frames){
 const corrections=[],claimed=new Set(),p=OUTLIER_PROTOCOL;
 for(let length=p.maxFrames;length>=1;length--)for(let start=2;start+length+1<frames.length;start++){
  const end=start+length,left=start-1,right=end,anchors=[left-1,left,right,right+1];
  if(frames[right].now-frames[left].now>p.maxBracketMs||frames[right].now<=frames[left].now)continue;
  const all=frames.slice(left-1,right+2),ratio=frames[left].width/frames[left].height;
  if(all.some((f,i)=>!f.landmarks||f.width/f.height!==ratio||i&&f.now<=all[i-1].now))continue;
  const sizes=anchors.map(i=>torso(frames[i]));if(sizes.some(v=>!Number.isFinite(v)||v<.03))continue;
  const scale=median(sizes);if(Math.max(...sizes)/Math.min(...sizes)>1.3)continue;
  for(const joint of joints){
   if(Array.from({length},(_,n)=>`${start+n}:${joint}`).some(k=>claimed.has(k)))continue;
   if(all.some(f=>!valid(f.landmarks[joint])))continue;
   const a=frames[left].landmarks[joint],b=frames[right].landmarks[joint];
   const fraction=i=>(frames[i].now-frames[left].now)/(frames[right].now-frames[left].now);
   if(distance(a,b,ratio)>p.maxAnchorMotionTorso*scale)continue;
   if(anchors.some(i=>distance(frames[i].landmarks[joint],interpolate(a,b,fraction(i)),ratio)>p.maxAnchorResidualTorso*scale))continue;
   const neighbours=bones.filter(pair=>pair.includes(joint)).map(pair=>pair.find(v=>v!==joint));
   const lengths=neighbours.map(other=>{
    const ds=anchors.map(i=>valid(frames[i].landmarks[other])?distance(frames[i].landmarks[joint],frames[i].landmarks[other],ratio):null);
    return ds.every(v=>Number.isFinite(v)&&v>.015)?{other,length:median(ds)}:null;
   }).filter(Boolean);
   const candidates=Array.from({length},(_,n)=>start+n);
   if(!lengths.length||candidates.some(i=>{
    const observed=frames[i].landmarks[joint];
    return distance(observed,interpolate(a,b,fraction(i)),ratio)<p.minResidualTorso*scale||
      !lengths.some(({other,length})=>{
       const q=frames[i].landmarks[other];if(!valid(q))return false;
       const r=distance(observed,q,ratio)/length;return r<p.boneLengthRatios[0]||r>p.boneLengthRatios[1];
      });
   }))continue;
   for(const i of candidates){claimed.add(`${i}:${joint}`);corrections.push({frame:i,timeMs:frames[i].now,joint,leftFrame:left,rightFrame:right,
    residualTorso:distance(frames[i].landmarks[joint],interpolate(a,b,fraction(i)),ratio)/scale});}
  }
 }
 const output=frames.map(f=>({...f,landmarks:f.landmarks?.map(q=>({...q}))??null,
  worldLandmarks:f.worldLandmarks?.map(q=>({...q}))??null}));
 for(const c of corrections){
  const t=(frames[c.frame].now-frames[c.leftFrame].now)/(frames[c.rightFrame].now-frames[c.leftFrame].now);
  for(const key of ['landmarks','worldLandmarks']){
   const a=frames[c.leftFrame][key]?.[c.joint],b=frames[c.rightFrame][key]?.[c.joint],raw=frames[c.frame][key]?.[c.joint];
   if(!a||!b||!raw||!['x','y','z'].every(k=>Number.isFinite(a[k])&&Number.isFinite(b[k])&&Number.isFinite(raw[k])))continue;
   const value=interpolate(a,b,t);
   // Preserve original confidence; interpolation does not add evidence.
   output[c.frame][key][c.joint]={...raw,x:value.x,y:value.y,z:value.z};
  }
 }
 return {frames:output,corrections,protocol:p};
}
