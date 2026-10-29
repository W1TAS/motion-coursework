// Research inputs for separate human criteria; not an APK model replacement.
import {measurePullup} from '../app/pullup-engine.mjs';
import {mapFrame,extractModelFeatures} from '../app/pullup-model.mjs';
const quantile=(a,q)=>{const s=a.slice().sort((a,b)=>a-b);const p=(s.length-1)*q;return s[Math.floor(p)]+(s[Math.ceil(p)]-s[Math.floor(p)])*(p%1);};
export const BOTTOM_FEATURES=['bottom_elbow_median','bottom_elbow_p10','bottom_elbow_p90'];
export function criterionFeatures(frames,review){
 const times=review.phase_times??{},result={};
 // The lower point of THIS ascent, never the most extended elbow later on descent.
 if(review.targets.bottom_incomplete!==null&&Number.isFinite(times.bottom)){
  const local=frames.filter(f=>Math.abs(f.now/1000-times.bottom)<=.12+1e-6);
  const measured=local.map(f=>measurePullup(f.landmarks,f.width,f.height)).filter(m=>m.valid);
  const covered=local.length>=3&&local[0].now/1000<=times.bottom+.04&&local.at(-1).now/1000>=times.bottom-.04;
  const elbows=measured.map(m=>m.elbow);
  const quality={frames:local.length,usable:measured.length,bothArms:measured.filter(m=>m.arms===2).length};
  if(covered&&measured.length>=3&&measured.length/local.length>=.8){
   result.bottom_incomplete={status:'available',features:[quantile(elbows,.5),quantile(elbows,.1),quantile(elbows,.9)],quality};
  }else result.bottom_incomplete={status:'unavailable',reason:'Lower-point pose missing or unstable',quality};
 }else result.bottom_incomplete={status:'unavailable',reason:'No observed label or lower timestamp'};
 if(review.targets.swing_ascent!==null&&Number.isFinite(times.bottom)&&Number.isFinite(times.top)&&times.top>times.bottom){
  const end=times.top,begin=times.bottom;
  const prefix=frames.filter(f=>f.now/1000>=begin-.5&&f.now/1000<=end+1e-6);
  const covered=prefix.length>0&&prefix[0].now/1000<=begin+.04&&prefix.at(-1).now/1000>=end-.04;
  const extracted=covered?extractModelFeatures(prefix.map(f=>mapFrame(f.landmarks,f.now,f.width,f.height)),{sampleStart:begin*1000,end:end*1000},[]):null;
  const q=extracted?.quality;
  const valid=q&&q.nanFrac<=.15&&q.confidence>=.45&&q.wristMove<=1&&q.maxGap<=.6&&q.bodyJump<=.2&&q.legs>=.8;
  result.swing_ascent=valid?{status:'available',features:extracted.features.slice(16),quality:q}:
   {status:'unavailable',reason:'Ascent or leg landmarks incomplete',quality:q??null};
 }else result.swing_ascent={status:'unavailable',reason:'No observed label or ascent boundaries'};
 // The skeleton contains neither the bar nor a chin landmark. Do not silently
 // substitute elbow flexion for this human target or train on manual answers as inputs.
 result.top_below_bar={status:'requires_additional_input',reason:'Need verified bar/face measurements; skeleton-only elbow range is not this criterion'};
 return result;
}
