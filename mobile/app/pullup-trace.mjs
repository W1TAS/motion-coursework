// Opt-in localhost diagnostics. No video bytes, network upload or background logging.
export class PullupTrace{
 constructor(){this.enabled=typeof location!=='undefined'&&['127.0.0.1','localhost'].includes(location.hostname)&&new URL(location.href).searchParams.get('pullup-trace')==='1';this.reset();}
 reset(meta={}){if(this.enabled)this.data={schema:1,meta,frames:[],decisions:[],lifecycle:[]};}
 lifecycle(event){if(this.enabled)this.data.lifecycle.push({event,wallMs:performance.now()});}
 frame(data,phase,ascent){if(this.enabled){if(this.data.frames.length>=2000){this.data.truncated=true;return;}this.data.frames.push({now:data.sourceTime*1000,detectorNow:data.now,width:data.width,height:data.height,landmarks:data.landmarks,worldLandmarks:data.worldLandmarks,phase,ascent});}}
 decision(data){if(this.enabled)this.data.decisions.push(data);}
 mount(parent){
  if(!this.enabled)return;
  const button=document.createElement('button'),output=document.createElement('textarea');button.type='button';button.className='secondary';button.textContent='Показать данные проверки';
  output.readOnly=true;output.setAttribute('aria-label','Данные проверки');output.hidden=true;output.style.cssText='width:100%;height:120px';
  button.onclick=()=>{output.value=JSON.stringify(this.data);output.hidden=false;};parent.append(button,output);
 }
}
