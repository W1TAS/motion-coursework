// Runtime for the exported, unchanged sklearn HGB classifier. No labels enter inference.
export function predictHGB(model,features){
 let logit=model.baseline;
 for(const tree of model.trees){let i=0;while(!tree[i][0]){const n=tree[i],x=features[n[2]];i=!Number.isFinite(x)?(n[4]?n[5]:n[6]):x<=n[3]?n[5]:n[6];}logit+=tree[i][1];}
 return logit>=0?1/(1+Math.exp(-logit)):Math.exp(logit)/(1+Math.exp(logit));
}
export const COCO_FROM_MP=[0,2,5,7,8,11,12,13,14,15,16,23,24,25,26,27,28];
export const AUX=['rise','rise_rel','nose_top','elb_bot','elb_top','tilt_dev_abs','elb_diff','elb_diff_p90','elb_diff_top','hip_dx_dev','thigh_rr','shin_rr','torso_rr','hipw_rr','knee_ang_min','dur_rel'];
export function percentile(values,q){const a=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!a.length)return NaN;const j=(a.length-1)*q,i=Math.floor(j);return a[i]+(a[Math.ceil(j)]-a[i])*(j-i);}
const median=a=>percentile(a,.5),mean=a=>{a=a.filter(Number.isFinite);return a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN;};
const min=a=>{a=a.filter(Number.isFinite);return a.length?Math.min(...a):NaN;},max=a=>{a=a.filter(Number.isFinite);return a.length?Math.max(...a):NaN;};
const dist=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]),center=(a,b)=>[(a[0]+b[0])/2,(a[1]+b[1])/2];
const angle=(a,b,c,epsilon=0)=>{const u=[a[0]-b[0],a[1]-b[1]],v=[c[0]-b[0],c[1]-b[1]],den=Math.hypot(...u)*Math.hypot(...v);return !epsilon&&den<=1e-8?NaN:Math.acos(Math.max(-1,Math.min(1,(u[0]*v[0]+u[1]*v[1])/(den+epsilon))))*180/Math.PI;};
const evenRound=x=>{const n=Math.floor(x);return x-n===.5?n+(n%2):Math.round(x);};
export function mapFrame(landmarks,time,width,height){
 return {t:time/1000,p:COCO_FROM_MP.map(i=>{const p=landmarks?.[i];return p&&Number.isFinite(p.x)&&Number.isFinite(p.y)?[p.x*width,p.y*height,Math.min(p.visibility??0,p.presence??1)]:[NaN,NaN,0];})};
}
function lowerBound(a,x){let lo=0,hi=a.length;while(lo<hi){const mid=(lo+hi)>>1;if(a[mid]<x)lo=mid+1;else hi=mid;}return lo;}
function interp(t,times,values){const j=lowerBound(times,t);if(!j)return values[0];if(j===times.length)return values.at(-1);const a=j-1;return values[a]+(values[j]-values[a])*(t-times[a])/(times[j]-times[a]);}
function nearestDistance(t,times){const j=lowerBound(times,t);return Math.min(Math.abs(t-times[Math.max(0,j-1)]),Math.abs(t-times[Math.min(j,times.length-1)]));}

export function cleanFrames(frames){
 const times=frames.map(f=>f.t),dt=median(times.slice(1).map((t,i)=>t-times[i]));
 const k=Math.min(frames.length,Math.max(1,evenRound(.1/dt))),out=frames.map(()=>Array.from({length:17},()=>[NaN,NaN]));
 for(let j=0;j<17;j++){
  const ids=frames.flatMap((f,i)=>f.p[j][2]>=.3&&Number.isFinite(f.p[j][0])?[i]:[]);if(ids.length<2)continue;
  const tt=ids.map(i=>times[i]);
  for(let c=0;c<2;c++){
   const vals=ids.map(i=>frames[i].p[j][c]);
   const filled=times.map(t=>nearestDistance(t,tt)<=.2?interp(t,tt,vals):NaN);
   for(let i=0;i<frames.length;i++)if(Number.isFinite(filled[i])){const lo=i-Math.floor(k/2),hi=lo+k;out[i][j][c]=mean(filled.slice(Math.max(0,lo),Math.min(filled.length,hi)));}
  }
 }
 return {p:out,t:times,dt};
}
function series(p,scale){return p.map(P=>{
 const sh=center(P[5],P[6]),hip=center(P[11],P[12]),el=angle(P[5],P[7],P[9],1e-9),er=angle(P[6],P[8],P[10],1e-9);
 return {sh_y:sh[1]/scale,nose_y:P[0][1]/scale,wr_y:(P[9][1]+P[10][1])/2/scale,elb:mean([el,er]),elb_diff:Math.abs(el-er),tilt:Math.atan2(P[5][1]-P[6][1],Math.abs(P[5][0]-P[6][0])+1e-9)*180/Math.PI,hip_dx:Math.abs(hip[0]-sh[0])/scale,thigh:mean([dist(P[11],P[13]),dist(P[12],P[14])])/scale,shin:mean([dist(P[13],P[15]),dist(P[14],P[16])])/scale,torso:dist(hip,sh)/scale,hipw:dist(P[11],P[12])/scale,knee_ang:mean([angle(P[11],P[13],P[15],1e-9),angle(P[12],P[14],P[16],1e-9)])};});}
const relativeRange=a=>a.filter(Number.isFinite).length<5||median(a)<=1e-6?NaN:(percentile(a,.95)-percentile(a,.05))/median(a);
export function motionFeatures(p,conf){
 const signals=Array.from({length:8},()=>[]);
 p.forEach((row,i)=>{
  const P=row.map((v,j)=>conf[i][j]>=.3&&v.every(Number.isFinite)?v:[NaN,NaN]);
  const sh=center(P[5],P[6]),hip=center(P[11],P[12]),kn=center(P[13],P[14]),an=center(P[15],P[16]),wr=center(P[9],P[10]);
  [hip[0]-wr[0],hip[0]-sh[0],kn[0]-hip[0],an[0]-hip[0],Math.atan2(sh[0]-hip[0],hip[1]-sh[1])*180/Math.PI,angle(P[11],P[13],P[15]),angle(P[12],P[14],P[16]),Math.abs(angle(P[5],P[7],P[9])-angle(P[6],P[8],P[10]))].forEach((v,k)=>signals[k].push(v));
 });
 return signals.flatMap(a=>{if(a.filter(Number.isFinite).length<4)return [NaN,NaN,NaN];const speed=a.slice(1).flatMap((v,i)=>Number.isFinite(v)&&Number.isFinite(a[i])?[Math.abs(v-a[i])*30]:[]);return [median(a),percentile(a,.95)-percentile(a,.05),speed.length>=3?percentile(speed,.9):NaN].map(Math.fround);});
}
export function resample30(p,conf,t){
 const positions=[],confidence=[],joints=Array.from({length:17},(_,j)=>{const ids=p.flatMap((r,i)=>r[j].every(Number.isFinite)?[i]:[]);return {t:ids.map(i=>t[i]),x:ids.map(i=>p[i][j][0]),y:ids.map(i=>p[i][j][1]),c:conf.map(c=>c[j])};});
 for(let time=t[0];time<=t.at(-1)+1e-6;time+=1/30){
  const index=lowerBound(t,time),left=Math.max(0,index-1),right=Math.min(index,t.length-1),nearest=Math.abs(t[left]-time)<=Math.abs(t[right]-time)?left:right;
  const row=[],cr=[];
  for(let j=0;j<17;j++){
   const v=joints[j];
   if(v.t.length<2||!p[nearest][j].every(Number.isFinite)){row.push([NaN,NaN]);cr.push(0);continue;}
   row.push([Math.fround(interp(time,v.t,v.x)),Math.fround(interp(time,v.t,v.y))]);cr.push(Math.fround(interp(time,t,v.c)));
  }positions.push(row);confidence.push(cr);
 }
 return {p:positions,conf:confidence};
}

export function extractModelFeatures(frames,rep,previous=[]){
 // Only frames already observed; prefix statistics replace unavailable future context.
 frames=frames.filter(f=>f.t<=rep.end/1000+1e-6);
 const {p,t}=cleanFrames(frames),scale=median(p.map(P=>dist(P[5],P[6]))),S=series(p,scale);
 const ids=t.flatMap((v,i)=>v>=rep.sampleStart/1000-1e-6&&v<=rep.end/1000+1e-6?[i]:[]);
 if(ids.length<4||!Number.isFinite(scale)||scale<5)return null;
 const rows=ids.map(i=>S[i]),a=key=>rows.map(r=>r[key]);
 let top=0;for(let i=1;i<rows.length;i++)if(rows[i].sh_y<rows[top].sh_y||!Number.isFinite(rows[top].sh_y))top=i;
 const around=rows.slice(Math.max(0,top-2),top+3),rise=max(a('sh_y'))-min(a('sh_y')),duration=(rep.end-rep.sampleStart)/1000;
 const risePixels=rise*scale,rises=[...previous.map(r=>r.risePixels),risePixels],durations=[...previous.map(r=>r.duration),duration];
 const f={rise,rise_rel:rises.length>=3?risePixels/median(rises):NaN,nose_top:median(around.map(r=>r.wr_y-r.nose_y)),elb_bot:max(a('elb')),elb_top:min(a('elb')),tilt_dev_abs:Math.abs(mean(a('tilt'))-median(S.map(r=>r.tilt))),elb_diff:mean(a('elb_diff')),elb_diff_p90:percentile(a('elb_diff'),.9),elb_diff_top:median(around.map(r=>r.elb_diff)),hip_dx_dev:Math.abs(mean(a('hip_dx'))-median(S.map(r=>r.hip_dx))),thigh_rr:relativeRange(a('thigh')),shin_rr:relativeRange(a('shin')),torso_rr:relativeRange(a('torso')),hipw_rr:relativeRange(a('hipw')),knee_ang_min:min(a('knee_ang')),dur_rel:duration/median(durations)};
 const core=[5,6,7,8,9,10,11,12];
 const quality={nanFrac:mean(rows.map(r=>[r.sh_y,r.wr_y,r.torso].every(Number.isFinite)?0:1)),confidence:mean(ids.flatMap(i=>core.map(j=>frames[i].p[j][2]))),legs:Math.min(mean(a('thigh').map(v=>Number(Number.isFinite(v)))),mean(a('shin').map(v=>Number(Number.isFinite(v))))),wristMove:percentile(a('wr_y'),.95)-percentile(a('wr_y'),.05),maxGap:max(ids.slice(1).map((v,i)=>t[v]-t[ids[i]]))};
 // Continuity proxy replaces unavailable YOLO detection boxes; do not invent boxes.
 const bodyHeight=median(ids.map(i=>{const ys=p[i].flatMap((v,j)=>frames[i].p[j][2]>=.3&&v.every(Number.isFinite)?[v[1]]:[]);return max(ys)-min(ys);}));
 quality.bodyJump=max(ids.slice(1).map((v,i)=>{const prev=ids[i];return dist(center(p[v][5],p[v][6]),center(p[prev][5],p[prev][6]))/bodyHeight;}));
 const pad=t.flatMap((v,i)=>v>=rep.sampleStart/1000-.2&&v<=rep.end/1000+1e-6?[i]:[]),centerPoint=[0,1].map(c=>median(p.map(P=>(P[5][c]+P[6][c])/2)));
 const normalized=pad.map(i=>p[i].map(v=>v.map((x,c)=>(x-centerPoint[c])/scale))),conf=pad.map(i=>frames[i].p.map(v=>v[2]));
 const sampled=resample30(normalized,conf,pad.map(i=>t[i]));
 const base=AUX.map(k=>Number.isFinite(f[k])?Math.fround(Math.round(f[k]*1e4)/1e4):NaN);
 return {features:[...base,...motionFeatures(sampled.p,sampled.conf)],quality,stats:{risePixels,duration},base:f};
}
export function classifyFeatures(model,extracted){
 if(!extracted)return {experimental:true,targets:Object.fromEntries(['partial','swing'].map(t=>[t,{state:'unavailable',reason:'Мало пригодных кадров'}]))};
 const q=extracted.quality;
 const core=q.nanFrac<=.15&&q.confidence>=.45&&q.wristMove<=1&&q.maxGap<=.6&&q.bodyJump<=.2;
 const targets={};
 for(const [target,entry]of Object.entries(model.models)){
  const available=core&&(target!=='swing'||q.legs>=.8);
  const score=available?predictHGB(entry,extracted.features):null;
  targets[target]={state:!available?'unavailable':score>=entry.threshold?'flagged':'not_detected',score,threshold:entry.threshold,reason:!core?'Недостаточно стабильных точек':target==='swing'&&q.legs<.8?'Ноги плохо видны':null};
 }
 return {experimental:true,targets,quality:q};
}
export class PullupModelSession {
 constructor(model){this.model=model;this.reset();}
 reset(){this.frames=[];this.previous=[];this.lastTime=-Infinity;this.contextStart=null;}
 observe(points,time,width,height,phase){
  if(time<=this.lastTime)return;this.lastTime=time;
  if(this.contextStart===null&&phase==='ready')this.contextStart=time/1000-.2;
  this.frames.push(mapFrame(points,time,width,height));
  const cutoff=Math.max(time/1000-60,this.contextStart??time/1000-2);
  this.frames=this.frames.filter(f=>f.t>=cutoff);
 }
 classify(rep){
  const f=extractModelFeatures(this.frames,{...rep,sampleStart:rep.sampleStart??rep.start},this.previous);
  const result=classifyFeatures(this.model,f);if(f)this.previous.push(f.stats);if(this.previous.length>30)this.previous.shift();return result;
 }
}
