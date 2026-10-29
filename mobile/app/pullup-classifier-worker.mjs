import {PullupAnalysisSession} from './pullup-rules.mjs';
let session=null;
self.onmessage=async({data})=>{
 try{
  if(data.type==='init'){
   const r=await fetch(new URL('./models/pullup-hgb.json',import.meta.url));if(!r.ok)throw Error('Не удалось загрузить классификатор');
   session=new PullupAnalysisSession(await r.json());self.postMessage({type:'ready'});
  }else if(data.type==='reset')session?.reset();
  else if(data.type==='observe'){
   session.observe(data.points,data.time,data.width,data.height,data.phase,data.worldLandmarks);
   if(data.ascent){const decision=session.assessAscent(data.ascent);self.postMessage({type:'ascent-decision',epoch:data.epoch,index:data.ascent.index,decision});}
   if(data.rep){const started=performance.now(),decision=session.classify(data.rep);self.postMessage({type:'decision',epoch:data.epoch,index:data.rep.index,decision,elapsedMs:performance.now()-started});}
  }
 }catch(e){self.postMessage({type:'error',epoch:data.epoch,index:data.rep?.index,ascentIndex:data.ascent?.index,message:String(e.message??e)});}
};
