import {measurePullup} from './pullup-engine.mjs';

const median=a=>{const s=a.slice().sort((x,y)=>x-y);return(s[Math.floor((s.length-1)/2)]+s[Math.ceil((s.length-1)/2)])/2;};
// Use metric world coordinates, never normalized image z mixed with pixel x/y.
export function worldElbowAngles(frame){
 const p=frame.worldLandmarks,q=frame.landmarks;
 if(p?.length!==33||q?.length!==33)return null;
 const angles=[];
 for(const[s,e,w]of [[11,13,15],[12,14,16]]){
  if(![s,e,w].every(i=>q[i]&&p[i]&&Math.min(q[i].visibility??0,q[i].presence??1)>=.45&&['x','y','z'].every(k=>Number.isFinite(p[i][k]))))return null;
  const u=['x','y','z'].map(k=>p[s][k]-p[e][k]),v=['x','y','z'].map(k=>p[w][k]-p[e][k]);
  const den=Math.hypot(...u)*Math.hypot(...v);if(den<1e-6)return null;
  angles.push(Math.acos(Math.max(-1,Math.min(1,u.reduce((n,x,i)=>n+x*v[i],0)/den)))*180/Math.PI);
 }
 return angles;
}

export function measureInitialBottom(frames,timeMs){
 if(!Number.isFinite(timeMs))return {state:'unavailable',reason:'Не определено начало подъёма'};
 const local=frames.filter(f=>Math.abs(f.now-timeMs)<=120+1e-3).sort((a,b)=>a.now-b.now);
 const covered=local.length>=3&&local[0].now<=timeMs+40&&local.at(-1).now>=timeMs-40;
 const image=local.map(f=>measurePullup(f.landmarks,f.width,f.height)).filter(m=>m.valid);
 if(!covered||image.length<3||image.length/local.length<.8)return {state:'unavailable',reason:'Недостаточно точек в начале подъёма'};
 const world=local.filter(f=>measurePullup(f.landmarks,f.width,f.height).valid).map(worldElbowAngles).filter(Boolean);
 const worldAvailable=world.length>=3&&world.length/local.length>=.8;
 return {state:'measured',timeMs,angle2d:median(image.map(m=>m.elbow)),
  angle3d:worldAvailable?median(world.map(a=>(a[0]+a[1])/2)):null,
  left3d:worldAvailable?median(world.map(a=>a[0])):null,right3d:worldAvailable?median(world.map(a=>a[1])):null,
  frames:local.length,worldFrames:world.length,
  scope:'Начальная нижняя точка ±120 мс. 3D-поза оценена нейросетью; это не измерение глубины камерой.'};
}

// Research candidate only. Keep unavailable separate from "no error".
// Fixed pre-existing 150° reference, not a threshold tuned on these nine clips.
export function experimentalBottomDecision(measured){
 if(measured?.state!=='measured'||!Number.isFinite(measured.angle3d))return {state:'unavailable',reason:'Нет устойчивой 3D-позы в начале подъёма'};
 return {state:measured.angle3d<150?'flagged':'not_detected',angle:measured.angle3d,threshold:150,
  scope:'Эксперимент: только разгибание рук в начале подъёма; не оценка всего подтягивания.'};
}

export function measureAutomaticBottom(frames,rep){
 if(!Number.isFinite(rep?.sampleStart)||!Number.isFinite(rep?.start)||!Number.isFinite(rep?.top)||rep.start>=rep.top)return {state:'unavailable',reason:'Не определены границы подъёма'};
 // The phase detector has a 350 ms settling context and confirms movement late.
 // Search that context only, not the following return or an entire repetition.
 // Each candidate remains a robust local median, not a single maximum frame.
 const prefix=frames.filter(f=>f.now<=Math.min(rep.start,rep.top));
 const candidates=prefix.filter(f=>f.now>=rep.sampleStart-350&&f.now<=rep.sampleStart)
  .map(f=>measureInitialBottom(prefix,f.now)).filter(m=>Number.isFinite(m.angle3d));
 if(!candidates.length)return measureInitialBottom(prefix,rep.sampleStart);
 candidates.sort((a,b)=>b.angle3d-a.angle3d||Math.abs(a.timeMs-rep.sampleStart)-Math.abs(b.timeMs-rep.sampleStart));
 return {...candidates[0],phaseTimeMs:rep.sampleStart,searchWindowMs:350,
  scope:'Устойчивое разгибание перед подъёмом: поиск в пределах 350 мс, медиана вокруг каждого момента. Спуск после подъёма исключён.'};
}
