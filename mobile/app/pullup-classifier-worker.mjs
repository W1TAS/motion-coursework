import {PullupAnalysisSession} from './pullup-rules.mjs';
let session=null;
self.onmessage=async({data})=>{
 try{
  if(data.type==='init'){
   const read=async name=>{const r=await fetch(new URL('./models/'+name,import.meta.url));if(!r.ok)throw Error('Не удалось загрузить '+name);return r.json();};
   const [model,prior]=await Promise.allSettled([read('pullup-hgb.json'),read('pullup-top-prior.json')]);
   session=new PullupAnalysisSession(model.status==='fulfilled'?model.value:null,prior.status==='fulfilled'?prior.value:null);
   self.postMessage({type:'ready',modelAvailable:model.status==='fulfilled',topAvailable:prior.status==='fulfilled'});
  }else if(data.type==='reset')session?.reset();
  else if(data.type==='observe'){
   session.observe(data.points,data.time,data.width,data.height,data.phase,data.worldLandmarks);
   if(data.ascent){const decision=session.assessAscent(data.ascent);self.postMessage({type:'ascent-decision',epoch:data.epoch,index:data.ascent.index,decision});}
   if(data.rep){const started=performance.now(),decision=session.classify(data.rep);self.postMessage({type:'decision',epoch:data.epoch,index:data.rep.index,decision,elapsedMs:performance.now()-started});}
  }
 }catch(e){self.postMessage({type:'error',epoch:data.epoch,index:data.rep?.index,ascentIndex:data.ascent?.index,message:String(e.message??e)});}
};
