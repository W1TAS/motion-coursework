// Frozen movement detector before early-ascent integration.
import {measurePullup,PULLUP_RULES} from '../app/pullup-engine.mjs';

// Movement detection is independent of the angle used to assess full extension.
export const PHASE_RULES=Object.freeze({settleMs:180,settleRange:.06,startLift:.08,
 minLift:.12,minElbowChange:18,turnRange:.07,turnMs:80,minRiseMs:180,
 minRepMs:600,maxRepMs:15000,returnFraction:.45});
const median=a=>a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)];
export class PullupPhaseEngine{
 constructor(){this.reset();}
 reset(){this.count=0;this.completed=[];this.lastTime=null;this.lastValid=null;this.breakCycle();}
 breakCycle(){this.phase='waiting';this.history=[];this.stable=[];this.bottom=null;this.cycle=null;this.turnSince=null;this.turnFrames=0;this.waitingLow=null;this.waitingBottom=null;}
 pause(){this.lastTime=null;this.lastValid=null;this.breakCycle();}
 smooth(m,time){
  this.history.push({height:m.height,elbow:m.elbow,t:time});
  this.history=this.history.filter(v=>time-v.t<=100).slice(-3);
  return {...m,t:time,height:median(this.history.map(v=>v.height)),elbow:median(this.history.map(v=>v.elbow))};
 }
 start(m){
  this.phase='rising';this.cycle={sampleStart:this.bottom.t,start:m.t,bottom:this.bottom,
   peak:m,minElbow:m.elbow,maxElbow:this.bottom.elbow,minLateral:m.lateral,maxLateral:m.lateral,
   lift:Math.max(0,this.bottom.height-m.height),lower:null};
  this.turnSince=null;this.turnFrames=0;
 }
 finish(lower){
  const c=this.cycle;
  if(lower.t-c.sampleStart>=PHASE_RULES.minRepMs){
   this.count++;
   this.completed.push({index:this.count,start:c.start,sampleStart:c.sampleStart,end:lower.t,
    top:c.peak.t,minElbow:c.minElbow,maxElbow:c.maxElbow,
    bottomElbow:c.bottom.elbow,topElbow:c.peak.elbow,lift:c.lift,
    lateralRange:c.maxLateral-c.minLateral,lateral:c.maxLateral-c.minLateral>PULLUP_RULES.lateralRange?'visible':'not_detected'});
  }
  this.phase='ready';this.bottom=lower;this.cycle=null;this.turnSince=null;this.turnFrames=0;
 }
 update(points,time,width=360,height=640){
  if(this.lastTime!==null&&time<=this.lastTime)return this.result({valid:false,message:'Ожидание нового кадра'});
  if(this.lastValid!==null&&time-this.lastValid>PULLUP_RULES.maxGap)this.breakCycle();
  this.lastTime=time;const measured=measurePullup(points,width,height);
  if(!measured.valid){this.history=[];this.stable=[];this.turnSince=null;this.turnFrames=0;return this.result(measured);}
  this.lastValid=time;const m=this.smooth(measured,time);
  const anchor=this.cycle?.bottom??this.bottom;
  if(anchor&&Math.hypot(m.wrist.x-anchor.wrist.x,m.wrist.y-anchor.wrist.y)/anchor.torso>PULLUP_RULES.wristDrift){
   this.breakCycle();return this.result({...m,message:'Смещение рук — определяю начало заново'});
  }
  if(this.cycle&&time-this.cycle.sampleStart>PHASE_RULES.maxRepMs)this.breakCycle();
  if(this.phase==='waiting'){
   // A continuous set need not pause at the bottom: an observed descent followed
   // by ascent provides a lower turning point without inventing an initial hang.
   if(!this.waitingLow||m.height<this.waitingLow.height)this.waitingLow=m;
   if(m.height-this.waitingLow.height>=.12&&m.elbow-this.waitingLow.elbow>=15&&
    (!this.waitingBottom||m.height>this.waitingBottom.height))this.waitingBottom=m;
   if(this.waitingBottom&&this.waitingBottom.height-m.height>=PHASE_RULES.startLift&&
    this.waitingBottom.elbow-m.elbow>=8){
    this.bottom=this.waitingBottom;this.start(m);
   }
   this.stable.push(m);this.stable=this.stable.filter(v=>time-v.t<=350);
   const recent=this.stable.filter(v=>time-v.t<=PHASE_RULES.settleMs+60);
   if(this.phase==='waiting'&&recent.length>=3&&time-recent[0].t>=PHASE_RULES.settleMs&&
    Math.max(...recent.map(v=>v.height))-Math.min(...recent.map(v=>v.height))<=PHASE_RULES.settleRange&&
    Math.max(...recent.map(v=>v.elbow))-Math.min(...recent.map(v=>v.elbow))<=12){
    this.bottom=m;this.phase='ready';
   }
  }else if(this.phase==='ready'){
   if(m.height>this.bottom.height+.005||Math.abs(m.height-this.bottom.height)<=.005&&m.elbow>=this.bottom.elbow-2)this.bottom={...m,
    height:Math.max(this.bottom.height,m.height),elbow:Math.max(this.bottom.elbow,m.elbow)};
   if(this.bottom.height-m.height>=PHASE_RULES.startLift&&this.bottom.elbow-m.elbow>=8)this.start(m);
  }
  if(this.cycle){
   const c=this.cycle;
   if(this.phase==='rising'){
    c.minElbow=Math.min(c.minElbow,m.elbow);
    c.minLateral=Math.min(c.minLateral,m.lateral);c.maxLateral=Math.max(c.maxLateral,m.lateral);
    if(m.height<c.peak.height)c.peak=m;
    c.lift=c.bottom.height-c.peak.height;
    const enough=c.lift>=PHASE_RULES.minLift&&c.bottom.elbow-c.minElbow>=PHASE_RULES.minElbowChange&&c.peak.t-c.sampleStart>=PHASE_RULES.minRiseMs;
    if(m.height>=c.peak.height+PHASE_RULES.turnRange){
     this.turnSince??=time;this.turnFrames++;
     if(enough&&this.turnFrames>=2&&time-this.turnSince>=PHASE_RULES.turnMs){
      this.phase='returning';c.lower=m;this.turnSince=null;this.turnFrames=0;
     }else if(!enough&&m.height>=c.bottom.height-.02){
      this.phase='ready';this.bottom=m;this.cycle=null;this.turnSince=null;this.turnFrames=0;
     }
    }else{this.turnSince=null;this.turnFrames=0;}
   }else if(this.phase==='returning'){
    // Ascent supplies lateral extrema; descent locates the next lower point.
    // The separate arm-range classifier measures the completed full cycle.
    if(m.height>c.lower.height+.01){c.lower=m;this.turnSince=null;this.turnFrames=0;}
    const returned=c.lower.height-c.peak.height>=Math.max(.12,c.lift*PHASE_RULES.returnFraction)&&
     c.lower.elbow-c.minElbow>=Math.max(15,(c.bottom.elbow-c.minElbow)*.55);
    const reversing=c.lower.height-m.height>=PHASE_RULES.turnRange&&c.lower.elbow-m.elbow>=8;
    if(returned&&reversing){
     this.turnSince??=time;this.turnFrames++;
     if(this.turnFrames>=2&&time-this.turnSince>=PHASE_RULES.turnMs){const lower=c.lower;this.finish(lower);this.start(m);}
    }else if(returned&&Math.abs(m.height-c.lower.height)<=.04&&time-c.lower.t>=PHASE_RULES.settleMs){
     this.finish({...c.lower,t:time});
    }else if(!reversing){this.turnSince=null;this.turnFrames=0;}
   }
  }
  return this.result({...m,message:({waiting:'Определяю исходное положение',ready:'Нижняя точка — ожидаю подъём',rising:'Подъём',returning:'Верхняя точка пройдена — определяю возврат'})[this.phase]});
 }
 result(m){return {...m,phase:this.phase,count:this.count,last:this.completed.at(-1)??null};}
}
