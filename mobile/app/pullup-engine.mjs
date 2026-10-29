import {angle} from './engine.mjs';
export const PULLUP_RULES=Object.freeze({visibility:.45,hangAngle:145,liftAngle:110,fullFlexion:90,fullExtension:150,liftHeight:.25,returnTolerance:.22,minRep:700,maxRep:15000,maxGap:600,hangMs:150,confirmFrames:2,wristDrift:.35,lateralRange:.35});
const mean=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
export function measurePullup(points,width=360,height=640){
 if(!points||points.length!==33)return {valid:false,message:'Не вижу человека целиком'};
 const valid=i=>{const p=points[i];return p&&[p.x,p.y].every(Number.isFinite)&&p.x>.01&&p.x<.99&&p.y>.01&&p.y<.99&&Math.min(p.visibility??0,p.presence??1)>=PULLUP_RULES.visibility;};
 const p=points.map(v=>({...v,x:v.x*width/height}));
 const arms=[[11,13,15,23],[12,14,16,24]].filter(ids=>ids.every(valid));
 if(!arms.length)return {valid:false,message:'Нужны видимые плечо, локоть, кисть и таз'};
 const measurements=arms.map(([s,e,w,h])=>({shoulder:p[s],wrist:p[w],hip:p[h],elbow:angle(p[s],p[e],p[w])}));
 const combine=key=>measurements.length===2?mean(measurements[0][key],measurements[1][key]):measurements[0][key];
 const shoulder=combine('shoulder'),wrist=combine('wrist'),hip=combine('hip'),torso=Math.hypot(hip.x-shoulder.x,hip.y-shoulder.y);
 const elbow=measurements.reduce((s,v)=>s+v.elbow,0)/measurements.length;
 if(!Number.isFinite(elbow)||torso<.03)return {valid:false,message:'Человек слишком мелко в кадре'};
 if(hip.y-shoulder.y<torso*.65)return {valid:false,message:'Для подтягиваний корпус должен быть вертикальным'};
 if(shoulder.y-wrist.y<torso*.03)return {valid:false,message:'Держите руки на перекладине над плечами'};
 return {valid:true,elbow,shoulder,wrist,hip,torso,height:(shoulder.y-wrist.y)/torso,lateral:(hip.x-wrist.x)/torso,arms:arms.length};
}
export class PullupEngine {
 constructor(){this.reset();}
 reset(){this.count=0;this.completed=[];this.lastTime=null;this.lastValid=null;this.breakCycle();}
 breakCycle(){this.phase='waiting';this.hangSince=null;this.hangFrames=0;this.liftFrames=0;this.returnFrames=0;this.anchor=null;this.cycle=null;this.lastHang=null;}
 pause(){this.lastTime=null;this.lastValid=null;this.breakCycle();}
 update(points,time,width=360,height=640){
  if(this.lastTime!==null&&time<=this.lastTime)return this.result({valid:false,message:'Ожидание нового кадра'});
  if(this.lastValid!==null&&time-this.lastValid>PULLUP_RULES.maxGap)this.breakCycle();
  this.lastTime=time;const m=measurePullup(points,width,height);
  if(!m.valid){this.hangSince=null;this.hangFrames=0;this.liftFrames=0;this.returnFrames=0;return this.result(m);}
  this.lastValid=time;
  if(this.anchor&&Math.hypot(m.wrist.x-this.anchor.wrist.x,m.wrist.y-this.anchor.wrist.y)/this.anchor.torso>PULLUP_RULES.wristDrift){this.breakCycle();return this.result({...m,message:'Смещение рук: дождитесь устойчивого виса'});}
  if(this.cycle&&time-this.cycle.start>PULLUP_RULES.maxRep)this.breakCycle();
  if(this.phase==='waiting'){
   if(m.elbow>=PULLUP_RULES.hangAngle){
    if(this.hangSince===null){this.hangSince=time;this.anchor=m;}
    this.hangFrames++;
    if(this.hangFrames>=PULLUP_RULES.confirmFrames&&time-this.hangSince>=PULLUP_RULES.hangMs){this.phase='ready';this.anchor=m;this.lastHang=time;}
   }else {this.hangSince=null;this.hangFrames=0;this.anchor=null;}
  }else if(this.phase==='ready'){
   // Keep the baseline current while hanging, before an upward movement begins.
   if(m.elbow>=PULLUP_RULES.hangAngle){this.anchor={...m,height:Math.max(this.anchor.height,m.height)};this.lastHang=time;}
   if(m.elbow<135&&this.anchor.height-m.height>.10){
    this.phase='rising';this.cycle={sampleStart:this.lastHang??time,start:time,minElbow:m.elbow,maxElbow:this.anchor.elbow,minLateral:m.lateral,maxLateral:m.lateral,peakLift:0};
   }
  }
  if(this.cycle){
   const c=this.cycle;c.minElbow=Math.min(c.minElbow,m.elbow);c.maxElbow=Math.max(c.maxElbow,m.elbow);c.minLateral=Math.min(c.minLateral,m.lateral);c.maxLateral=Math.max(c.maxLateral,m.lateral);c.peakLift=Math.max(c.peakLift,this.anchor.height-m.height);
   if(this.phase==='rising'){
    this.liftFrames=m.elbow<=PULLUP_RULES.liftAngle&&this.anchor.height-m.height>=PULLUP_RULES.liftHeight?this.liftFrames+1:0;
    if(this.liftFrames>=PULLUP_RULES.confirmFrames)this.phase='returning';
    else if(m.elbow>=PULLUP_RULES.hangAngle){this.cycle=null;this.phase='ready';this.anchor=m;this.lastHang=time;}
   }
   if(this.phase==='returning'){
    this.returnFrames=m.elbow>=PULLUP_RULES.hangAngle&&m.height>=this.anchor.height-PULLUP_RULES.returnTolerance?this.returnFrames+1:0;
    if(this.returnFrames>=PULLUP_RULES.confirmFrames){
     if(time-c.start>=PULLUP_RULES.minRep){
      this.count++;this.completed.push({index:this.count,start:c.start,sampleStart:c.sampleStart,end:time,minElbow:c.minElbow,maxElbow:c.maxElbow,amplitude:c.minElbow<=PULLUP_RULES.fullFlexion&&c.maxElbow>=PULLUP_RULES.fullExtension?'reached':'limited',lateralRange:c.maxLateral-c.minLateral,lateral:c.maxLateral-c.minLateral>PULLUP_RULES.lateralRange?'visible':'not_detected'});
     }
     this.cycle=null;this.phase='ready';this.anchor=m;this.lastHang=time;this.liftFrames=0;this.returnFrames=0;
    }
   }
  }
  return this.result({...m,message:({waiting:'Начните с устойчивого виса на прямых руках',ready:'Вис подтверждён — можно подтягиваться',rising:'Подъём',returning:'Подъём замечен — вернитесь в вис'})[this.phase]});
 }
 result(m){return {...m,phase:this.phase,count:this.count,last:this.completed.at(-1)??null};}
}
