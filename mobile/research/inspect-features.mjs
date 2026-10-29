import fs from 'node:fs';import {measurePose} from './baseline-engine-0.1.2.mjs';
for(const id of process.argv.slice(2)){
 const data=JSON.parse(fs.readFileSync(`mobile/research/poses/${id}.json`));
 for(const t of (id==='773312'?[60,70,80,90,100,110,120,130,150,180,200,220]:[15,20,25,30,35,40,45,50,60,70,80,90,100,110,120,130,140,150,160,170])){
 const f=data.find(f=>f.now>=t*1000);if(!f?.landmarks)continue;const m=measurePose(f.landmarks,f.width,f.height);if(!m.valid){console.log(id,t,m.message);continue;}
 const p=f.landmarks.map(v=>({...v,x:v.x*f.width/f.height}));const ids=m.side==='left'?[11,13,15,23,25,27]:[12,14,16,24,26,28];const [s,e,w,h,k,a]=ids.map(i=>p[i]);const L=Math.hypot(a.x-s.x,a.y-s.y),U=Math.hypot(s.x-e.x,s.y-e.y);
 const height=q=>((a.y-e.y)*(q.x-e.x)-(a.x-e.x)*(q.y-e.y))*Math.sign(a.x-e.x)/Math.hypot(a.x-e.x,a.y-e.y)/L;
 console.log(id,t,JSON.stringify({elbow:Math.round(m.elbow),body:Math.round(m.body),knee:Math.round(m.knee),shoulderRise:(e.y-s.y)/L,armVertical:(e.y-s.y)/U,hip:height(h),kneeHeight:height(k)}));
 }
}
