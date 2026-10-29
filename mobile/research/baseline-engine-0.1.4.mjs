// Geometric rules for a side view. Thresholds are prototype settings, not technique norms.
export const RULES = Object.freeze({visibility:0.6, top:155, bottom:100, straight:150, horizontal:0.72, dwell:180, minRep:650, maxRep:12000, maxGap:350, plankDwell:600, shoulderRise:.08, armVertical:.65, hipClearance:.055, kneeClearance:.015});
export function angle(a,b,c){
 const u={x:a.x-b.x,y:a.y-b.y},v={x:c.x-b.x,y:c.y-b.y};
 const den=Math.hypot(u.x,u.y)*Math.hypot(v.x,v.y);
 return den<1e-6?NaN:Math.acos(Math.max(-1,Math.min(1,(u.x*v.x+u.y*v.y)/den)))*180/Math.PI;
}
export function measurePose(landmarks,width=640,height=480,preferred=null){
 if(!landmarks || landmarks.length!==33)return {valid:false,message:'Встаньте в кадр целиком'};
 const points=landmarks.map(p=>({...p,x:p.x*width/height}));
 const sides=[{name:'left',ids:[11,13,15,23,25,27]},{name:'right',ids:[12,14,16,24,26,28]}];
 const scores=sides.map(s=>({...s,score:Math.min(...s.ids.map(i=>{
  const p=landmarks[i];return p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>.01&&p.x<.99&&p.y>.01&&p.y<.99?Math.min(p.visibility??0,p.presence??1):0;
 }))}));
 scores.sort((a,b)=>b.score-a.score);
 const selected=scores.find(s=>s.name===preferred&&s.score>=RULES.visibility)??scores[0];
 if(selected.score<RULES.visibility)return {valid:false,message:'Нужны плечо, локоть, кисть, таз и обе части ноги'};
 const [s,e,w,h,k,a]=selected.ids.map(i=>points[i]);
 const length=Math.hypot(a.x-s.x,a.y-s.y);
 const elbow=angle(s,e,w),body=angle(s,h,a),knee=angle(h,k,a);
 if(![elbow,body,knee,length].every(Number.isFinite)||length<.25)return {valid:false,message:'Отойдите так, чтобы было видно всё тело'};
 if(Math.abs(a.x-s.x)/length<RULES.horizontal)return {valid:false,message:'Повернитесь боком и примите упор лёжа'};
 if(w.y<s.y-.06||e.y<s.y-.06)return {valid:false,message:'Примите упор лёжа, руки под корпусом'};
 // Screen-space evidence of support, not a measurement of distance from the floor.
 // Normalizing by body length makes these features independent of zoom/resolution.
 const upperArm=Math.hypot(e.x-s.x,e.y-s.y),support=Math.hypot(a.x-e.x,a.y-e.y);
 const shoulderRise=(e.y-s.y)/length,armVertical=upperArm>1e-6?(e.y-s.y)/upperArm:0;
 const hipClearance=support>1e-6?((a.y-e.y)*(h.x-e.x)-(a.x-e.x)*(h.y-e.y))*Math.sign(a.x-e.x)/support/length:0;
 const kneeClearance=support>1e-6?((a.y-e.y)*(k.x-e.x)-(a.x-e.x)*(k.y-e.y))*Math.sign(a.x-e.x)/support/length:0;
 return {valid:true,side:selected.name,elbow,body,knee,shoulderRise,armVertical,hipClearance,kneeClearance,straight:body>=RULES.straight&&knee>=RULES.straight,message:body<RULES.straight?'Выровняйте корпус':knee<RULES.straight?'Выпрямите ноги':'Положение видно'};
}
export class ExerciseEngine{
 constructor(exercise='pushups'){this.exercise=exercise;this.reset();}
 reset(){this.count=0;this.seconds=0;this.last=null;this.side=null;this.breakCycle();}
 breakCycle(){this.phase='waiting';this.candidate=null;this.since=0;this.started=null;}
 pause(){this.last=null;this.side=null;this.breakCycle();}
 update(landmarks,now,width=640,height=480){
  const m=measurePose(landmarks,width,height,this.side);
  const gap=this.last===null?0:now-this.last;this.last=now;
  if(gap<0||gap>RULES.maxGap){this.breakCycle();}
  if(!m.valid||!m.straight){this.side=null;this.breakCycle();return this.result(m,false);}
  if(this.side&&m.side!==this.side){this.breakCycle();}
  this.side=m.side;
  if(this.exercise==='plank'){
   // Require visible elevation and support before starting the confirmation interval.
   if(m.elbow<55||m.elbow>125){this.breakCycle();return this.result({...m,message:'Опуститесь на предплечья'},false);}
   if(m.shoulderRise<RULES.shoulderRise||m.armVertical<RULES.armVertical){this.breakCycle();return this.result({...m,message:'Поднимите плечи над локтями; снимайте тело сбоку'},false);}
   if(m.hipClearance<RULES.hipClearance){this.breakCycle();return this.result({...m,message:'Поднимите таз и корпус от пола'},false);}
   if(m.kneeClearance<RULES.kneeClearance){this.breakCycle();return this.result({...m,message:'Поднимите колени от пола и выпрямите ноги'},false);}
   if(this.candidate!=='plank'){this.candidate='plank';this.since=now;}
   if(now-this.since<RULES.plankDwell){this.phase='confirming';return this.result({...m,message:'Удерживайте положение — проверяю опору'},false);}
   const wasValid=this.phase==='holding';this.phase='holding';
   if(wasValid&&gap>0&&gap<=RULES.maxGap)this.seconds+=gap/1000;
   return this.result({...m,message:'Удерживайте положение'},true);
  }
  const zone=m.elbow>=RULES.top?'top':m.elbow<=RULES.bottom?'bottom':'middle';
  if(zone!==this.candidate){this.candidate=zone;this.since=now;}
  const stable=now-this.since>=RULES.dwell;
  if(this.started!==null&&now-this.started>RULES.maxRep)this.breakCycle();
  if(stable&&zone==='top'){
   if(this.phase==='bottom'&&now-this.started>=RULES.minRep){this.count++;this.phase='ready';this.started=null;}
   else if(this.phase==='waiting'){this.phase='ready';}
  }
  if(this.phase==='ready'&&zone!=='top'&&this.started===null)this.started=now;
  if(this.phase==='ready'&&stable&&zone==='bottom')this.phase='bottom';
  const message=this.phase==='waiting'?'Начните с прямых рук':this.phase==='bottom'?'Поднимитесь до прямых рук':'Опуститесь и вернитесь наверх';
  return this.result({...m,message},true);
 }
 result(m,active){return {...m,active,phase:this.phase,count:this.count,seconds:this.seconds};}
}
export function examplePose(elbow=170,plank=false){
 const p=Array.from({length:33},()=>({x:.5,y:.5,z:0,visibility:.99,presence:.99}));
 const sy=plank?.38:.32+(170-elbow)/90*.18;
 const s={x:.20,y:sy},a={x:.88,y:sy+.12},h={x:.53,y:sy+.058},k={x:.72,y:sy+.092};
 if(plank){
  const e={x:.20,y:.59},w={x:.07,y:.59};
  for(const ids of [[11,13,15,23,25,27],[12,14,16,24,26,28]])[s,e,w,h,k,a].forEach((v,j)=>p[ids[j]]={...v,z:0,visibility:.99,presence:.99});
  p[0]={x:.12,y:sy-.04,visibility:.99};return p;
 }
 const w={x:.20,y:.79};const d=w.y-s.y;
 const e={x:.20+d/(2*Math.tan(elbow*Math.PI/360)),y:(sy+w.y)/2};
 for(const ids of [[11,13,15,23,25,27],[12,14,16,24,26,28]])[s,e,w,h,k,a].forEach((v,j)=>p[ids[j]]={...v,z:0,visibility:.99,presence:.99});
 p[0]={x:.12,y:sy-.04,visibility:.99};return p;
}
