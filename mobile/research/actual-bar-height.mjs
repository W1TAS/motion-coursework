import {visibleFacePoints} from '../app/pose-face.mjs';
import {signedAboveLine} from './pullup-top-proxy.mjs';

export const BAR_PILOT_RULES=Object.freeze({minFrames:3,minCoverage:.8,topWindowMs:200,
 peakSpanMs:100,maxGapMs:120,nearTorso:.04,minPixelTolerance:2,maxAnchorDriftAt640:6});
const median=a=>{const s=a.slice().sort((x,y)=>x-y);return (s[Math.floor((s.length-1)/2)]+s[Math.ceil((s.length-1)/2)])/2;};
const normalized=(p,w,h)=>({x:p[0]/w,y:p[1]/h});
const fail=reason=>({state:'unavailable',reason});
export function actualBarReference(calibration){
 if(calibration?.status!=='proposed'||!calibration.initial)return fail(calibration?.reason??'bar_ambiguous');
 const c=calibration,a={x:c.initial.a[0],y:c.initial.a[1]},b={x:c.initial.b[0],y:c.initial.b[1]};
 if(![c.width,c.height,c.readingUncertaintyPixels,a.x,a.y,b.x,b.y].every(Number.isFinite)||c.width<=0||c.height<=0||c.readingUncertaintyPixels<0||Math.abs(a.x-b.x)<10)return fail('invalid_calibration');
 if(c.validation?.length!==2)return fail('camera_not_checked');
 const drift=Math.max(...c.validation.flatMap(v=>[v.a,v.b].map(p=>Math.abs(signedAboveLine({x:p[0],y:p[1]},a,b)))));
 if(!Number.isFinite(drift))return fail('invalid_validation');
 if(drift>BAR_PILOT_RULES.maxAnchorDriftAt640*c.height/640)return {...fail('bar_moves_in_image'),anchorDriftPixels:drift};
 const uncertainty=c.readingUncertaintyPixels+drift;
 return {state:'ready',kind:'image_bar_agent_calibration',a:normalized(c.initial.a,c.width,c.height),b:normalized(c.initial.b,c.width,c.height),
  width:c.width,height:c.height,offsetPixels:[-uncertainty,uncertainty],anchorDriftPixels:drift,
  uncertaintyPixels:uncertainty,scope:'Approximate visible upper bar edge; three image anchors, not independent human ground truth.'};
}
export function wristPriorReference(measurement,prior){
 const r=measurement?.reference;
 if(!r||['reference_wrists_unavailable','reference_wrists_unstable'].includes(measurement.reason))return fail(measurement?.reason??'wrist_reference_missing');
 return {state:'ready',kind:'frozen_wrist_plus_prior',width:r.width,height:r.height,
  a:{x:r.left.x/r.width,y:r.left.y/r.height},b:{x:r.right.x/r.width,y:r.right.y/r.height},
  offsetPixels:prior.empiricalFractionRange.map(x=>x*r.torsoPixels)};
}
function torso(f){
 const p=f.landmarks,valid=i=>p?.[i]&&Number.isFinite(p[i].x)&&Number.isFinite(p[i].y)&&Math.min(p[i].visibility??0,p[i].presence??1)>=.45;
 if(![11,12,23,24].every(valid))return null;
 const mid=(a,b)=>({x:(p[a].x+p[b].x)/2*f.width,y:(p[a].y+p[b].y)/2*f.height});
 const sh=mid(11,12),hip=mid(23,24),length=Math.hypot(sh.x-hip.x,sh.y-hip.y);
 return hip.y>sh.y&&length>f.height*.03?length:null;
}
// Both candidate references use the same face observations and peak operator.
// No wrist coordinates enter the actual-bar branch or the face sampler.
export function measureFaceHeight(frames,startMs,topMs,reference){
 if(reference?.state!=='ready')return fail(reference?.reason??'reference_missing');
 if(!Number.isFinite(startMs)||!Number.isFinite(topMs)||topMs<=startMs)return fail('invalid_phases');
 const cfg=BAR_PILOT_RULES,local=frames.filter(f=>f.now>=startMs-1e-3&&f.now<=topMs+1e-3).sort((a,b)=>a.now-b.now);
 if(local.length<cfg.minFrames)return fail('few_frames');
 if(local[0].now>startMs+40+1e-3||local.at(-1).now<topMs-40-1e-3)return fail('incomplete_ascent_window');
 if(local.some(f=>Math.abs(f.width/f.height-reference.width/reference.height)>.001))return fail('image_format_changed');
 const scaleFrames=frames.filter(f=>Math.abs(f.now-startMs)<=200&&f.now<=topMs),scales=scaleFrames.map(torso).filter(x=>x!==null);
 if(scales.length<cfg.minFrames)return fail('body_scale_unavailable');
 const scale=median(scales),tolerance=Math.max(cfg.minPixelTolerance,scale*cfg.nearTorso);
 const points=local.map(f=>({f,p:new Map(visibleFacePoints(f.landmarks,f.width,f.height).map(p=>[p.id,p]))}));
 const results={};
 for(const [cue,ids]of [['nose',[0]],['mouth',[9,10]]]){
  const good=points.filter(r=>ids.every(i=>r.p.has(i))).map(({f,p})=>{
   const point=ids.reduce((a,i)=>({x:a.x+p.get(i).x/ids.length,y:a.y+p.get(i).y/ids.length}),{x:0,y:0});
   const a={x:reference.a.x*f.width,y:reference.a.y*f.height},b={x:reference.b.x*f.width,y:reference.b.y*f.height};
   const clearance=signedAboveLine(point,a,b),unit=f.height/reference.height;
   return {now:f.now,lo:clearance-reference.offsetPixels[1]*unit,hi:clearance-reference.offsetPixels[0]*unit};
  });
  const end=local.filter(f=>f.now>=Math.max(startMs,topMs-cfg.topWindowMs)),endGood=good.filter(f=>f.now>=Math.max(startMs,topMs-cfg.topWindowMs));
  const gap=good.length>1?Math.max(...good.slice(1).map((r,i)=>r.now-good[i].now)):Infinity;
  if(good.length<cfg.minFrames||good.length/local.length<cfg.minCoverage||endGood.length<cfg.minFrames||endGood.length/end.length<cfg.minCoverage||gap>cfg.maxGapMs||good.at(-1).now<topMs-40-1e-3){results[cue]=fail('face_coverage');continue;}
  let peak=null;
  for(let i=2;i<good.length;i++){
   const triple=good.slice(i-2,i+1);if(triple[2].now-triple[0].now>cfg.peakSpanMs)continue;
   const lo=median(triple.map(r=>r.lo)),hi=median(triple.map(r=>r.hi));
   if(!peak||lo+hi>peak.lo+peak.hi)peak={lo,hi,timeMs:triple[1].now};
  }
  if(!peak){results[cue]=fail('no_sustained_peak');continue;}
  results[cue]={state:peak.hi< -tolerance?'below':peak.lo>tolerance?'above':'uncertain',timeMs:peak.timeMs,
   clearanceIntervalPixels:[peak.lo,peak.hi],tolerancePixels:tolerance,validFrames:good.length,totalFrames:local.length};
 }
 return {state:'measured',referenceKind:reference.kind,torsoPixels:scale,...results,
  scope:'Existing nose/mouth point versus a reference line; above never certifies chin-over-bar height or correct technique.'};
}
