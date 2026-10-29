// Experimental candidate promoted unchanged from the frozen research geometry.
import {visibleFacePoints} from './pose-face.mjs';
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

export const BAR_PILOT_RULES=Object.freeze({minFrames:3,minCoverage:.8,topWindowMs:200,
 peakSpanMs:100,maxGapMs:120,nearTorso:.04,minPixelTolerance:2,maxAnchorDriftAt640:6});
const median=a=>{const s=a.slice().sort((x,y)=>x-y);return (s[Math.floor((s.length-1)/2)]+s[Math.ceil((s.length-1)/2)])/2;};
const fail=reason=>({state:'unavailable',reason});
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

export function assessPullupTop(frames, rep, prior){
 const unavailable=reason=>({state:'unavailable',reason,experimental:true});
 if(!prior||!Array.isArray(prior.empiricalFractionRange)||prior.empiricalFractionRange.length!==2||
    !prior.empiricalFractionRange.every(Number.isFinite))return unavailable('Нет параметров экспериментального правила');
 if(rep.bottomReference?.state==='unavailable')return unavailable('Начало потеряно после сбоя отслеживания');
 const measurement=measureTopProxy(frames,rep.sampleStart,rep.top),r=measurement.reference;
 if(!r||['reference_wrists_unavailable','reference_wrists_unstable'].includes(measurement.reason))
  return unavailable(measurement.reason==='reference_wrists_unstable'?'Неустойчивое положение кистей в начале':'Не видны обе кисти в начале');
 const reference={state:'ready',kind:'frozen_wrist_plus_prior',width:r.width,height:r.height,
  a:{x:r.left.x/r.width,y:r.left.y/r.height},b:{x:r.right.x/r.width,y:r.right.y/r.height},
  offsetPixels:prior.empiricalFractionRange.map(x=>x*r.torsoPixels)};
 const result=measureFaceHeight(frames,rep.sampleStart,rep.top,reference);
 const messages={few_frames:'Мало кадров подъёма',incomplete_ascent_window:'Начало или верх не попали в обработанные кадры',
  image_format_changed:'Размер изображения изменился во время движения',body_scale_unavailable:'Не видны плечи и таз',
  face_coverage:'Недостаточно устойчивых точек рта',no_sustained_peak:'Не найден устойчивый верх',invalid_phases:'Не определены фазы'};
 if(result.state!=='measured')return unavailable(messages[result.reason]??'Недостаточно данных для оценки высоты');
 if(result.mouth.state==='unavailable')return {...result,...unavailable(messages[result.mouth.reason]??'Недостаточно точек рта')};
 return {...result,state:result.mouth.state,experimental:true,
  scope:'Рот относительно расчётного уровня по кистям. Подбородок и реальная перекладина не обнаруживаются.'};
}
