// One in-flight inference, the same MediaPipe Worker used by the camera screen.
export class PoseStream {
 constructor(){this.worker=null;this.busy=false;this.ready=null;this.pending=null;this.serial=0;this.lastStamp=-1;}
 start(){
  if(this.ready)return this.ready;
  this.worker=new Worker(new URL('./pose-worker.mjs',import.meta.url),{type:'module'});
  this.worker.onmessage=({data})=>{const p=this.pending;if(!p)return;this.pending=null;clearTimeout(p.timer);data.type==='error'?p.reject(Error(data.message)):p.resolve(data);};
  this.worker.onerror=()=>this.reject(Error('Модуль распознавания остановился'));
  this.ready=this.call({type:'init',includeWorld:true},[],45000);return this.ready;
 }
 reject(error){const p=this.pending;if(p){clearTimeout(p.timer);this.pending=null;p.reject(error);}}
 call(message,transfer=[],timeout=15000){return new Promise((resolve,reject)=>{this.pending={resolve,reject,timer:setTimeout(()=>this.reject(Error('Распознавание не ответило. Запустите запись заново.')),timeout)};try{this.worker.postMessage(message,transfer);}catch(e){this.reject(e);}});}
 async frame(video,sourceTime,epoch){
  if(this.busy||!this.worker)return null;
  this.busy=true;const serial=this.serial;
  try{
   const width=video.videoWidth,height=video.videoHeight;
   const bitmap=await createImageBitmap(video);
   if(serial!==this.serial){bitmap.close();return null;}
   const now=this.lastStamp=Math.max(this.lastStamp+1,performance.now());
   const result=await this.call({type:'frame',bitmap,now,width,height},[bitmap]);
   return serial===this.serial?{...result,sourceTime,epoch}:null;
  }finally{if(serial===this.serial)this.busy=false;}
 }
 close(){this.serial++;this.reject(new DOMException('Анализ закрыт','AbortError'));this.worker?.terminate();this.worker=null;this.ready=null;this.busy=false;}
}
