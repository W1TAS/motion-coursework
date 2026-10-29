import {FilesetResolver,PoseLandmarker} from './vendor/vision_bundle.mjs';
let model,includeWorld=false;
self.import=async url=>{const loaded=await import(url);self.ModuleFactory=loaded.default;};
self.onmessage=async({data})=>{
 try{
  if(data.type==='init'){
   includeWorld=Boolean(data.includeWorld);
   const files=await FilesetResolver.forVisionTasks(new URL('./vendor/wasm',import.meta.url).href,true);
   model=await PoseLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:new URL('./vendor/pose_landmarker_lite.task',import.meta.url).href,delegate:'CPU'},runningMode:'VIDEO',numPoses:1,minPoseDetectionConfidence:.6,minPosePresenceConfidence:.6,minTrackingConfidence:.6});
   self.postMessage({type:'ready'});
  }else if(data.type==='frame'){
   try{
    const result=model.detectForVideo(data.bitmap,data.now);
    self.postMessage({type:'pose',landmarks:result.landmarks[0]??null,...(includeWorld?{worldLandmarks:result.worldLandmarks[0]??null}:{}),now:data.now,width:data.width,height:data.height});
   }finally{data.bitmap.close();}
  }
 }catch(error){self.postMessage({type:'error',message:String(error.message??error)});}
};
