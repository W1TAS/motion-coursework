import {PullupModelSession,extractModelFeatures,classifyFeatures} from './pullup-model.mjs';
import {measureAutomaticBottom,experimentalBottomDecision} from './pullup-bottom.mjs';

// The candidate 140/65-degree correctness rule failed the reserved split.
// Expose measurements only: elbow range cannot establish chin-over-bar height.
export function assessArmRange(extracted){
 const q=extracted?.quality,bottom=extracted?.features[3],top=extracted?.features[4];
 const available=q&&q.nanFrac<=.15&&q.confidence>=.45&&q.wristMove<=1&&q.maxGap<=.6&&q.bodyJump<=.2&&Number.isFinite(bottom)&&Number.isFinite(top);
 if(!available)return {state:'unavailable',reason:'Недостаточно стабильных точек рук',bottom:null,top:null};
 return {state:'measured',bottom,top,
  scope:'Диапазон 2D-углов, без заключения о правильности. Положение подбородка относительно перекладины не измеряется.'};
}

export class PullupAnalysisSession extends PullupModelSession{
 reset(){super.reset();this.bottomFrames=[];}
 observe(points,time,width,height,phase,worldLandmarks=null){
  if(time>this.lastTime){
   this.bottomFrames.push({landmarks:points,worldLandmarks,now:time,width,height});
   this.bottomFrames=this.bottomFrames.filter(f=>f.now>=time-20000);
  }
  // The new counter can enter ascent from an observed turning point without a
  // held "ready" frame. Keep its bottom context instead of a moving 2 s buffer.
  if(this.contextStart===null&&(phase==='rising'||phase==='returning'))this.contextStart=this.frames[0]?.t??time/1000;
  super.observe(points,time,width,height,phase);
 }
 assessAscent(rep){
  const initialBottom=measureAutomaticBottom(this.bottomFrames,rep);
  return {initialBottom,bottomCandidate:experimentalBottomDecision(initialBottom)};
 }
 classify(rep){
  const full=extractModelFeatures(this.frames,rep,this.previous);
  const result=classifyFeatures(this.model,full);
  result.geometry=assessArmRange(full);
  Object.assign(result,this.assessAscent(rep));
  if(full){this.previous.push(full.stats);if(this.previous.length>30)this.previous.shift();}
  return result;
 }
}
