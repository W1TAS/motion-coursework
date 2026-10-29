import {PoseStream} from '/baseline-pose-stream.mjs';
import {PullupPhaseEngine} from '/app/pullup-phases.mjs';
import {PullupAnalysisSession} from '/app/pullup-rules.mjs';
import {measureTopProxy} from '/app/pullup-top.mjs';
const $=id=>document.getElementById(id),video=$('video');
const manifest=await (await fetch('/app/samples/pullups/manifest.json')).json();
const prior=await (await fetch('/app/models/pullup-top-prior.json')).json();
for(const item of manifest){const option=document.createElement('option');option.value=item.id;option.textContent=item.title;$('sample').append(option);}
let serial=0,lastRuns=[];
function summarise(run){
 return {id:run.id,profile:run.profile,sample:run.sample,frames:run.frames.length,sourceTimesMs:run.frames.map(f=>Math.round(f.now)),
  detectorTimesMs:run.frames.map(f=>f.detectorNow),events:run.events.map(e=>({sampleStart:e.sampleStart,top:e.top,
   confirmedAt:e.confirmedAt,state:e.analysis.topHeight.state,reason:e.analysis.topHeight.reason,
   mouth:e.analysis.topHeight.mouth,sampling:e.analysis.topHeight.sampling,reference:e.reference}))};
}
function show(run){
 const row=document.createElement('tr'),s=summarise(run),e=s.events.at(-1);
 for(const value of [run.id,run.frames.length,e?`${Math.round(e.sampleStart)} / ${Math.round(e.top)}`:'нет',e?.state??'нет события',
  e?.mouth?`${e.mouth.clearanceIntervalPixels.map(x=>x.toFixed(3)).join('…')} / ${e.mouth.tolerancePixels.toFixed(3)}`:e?.reason??'']){
  const td=document.createElement('td');td.textContent=String(value);row.append(td);
 }$('rows').append(row);$('summary').textContent=JSON.stringify(s,null,2);
}
function analyse(frames){
 const engine=new PullupPhaseEngine(),session=new PullupAnalysisSession(null,prior),events=[];
 for(const f of frames){
  const before=engine.ascents.length,r=engine.update(f.landmarks,f.now,f.width,f.height);
  session.observe(f.landmarks,f.now,f.width,f.height,r.phase,f.worldLandmarks);
  if(engine.ascents.length>before){const rep=engine.ascents.at(-1);events.push({...rep,analysis:session.assessAscent(rep),
   reference:measureTopProxy(frames.filter(v=>v.now<=f.now),rep.sampleStart,rep.top).reference});}
 }return events;
}
async function save(run){
 run.events=analyse(run.frames);show(run);const r=await fetch('/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(run)});
 if(!r.ok)throw Error('Не удалось сохранить протокол: '+r.status);lastRuns.push(run);
}
async function liveRun(sample){
 const pipeline=new PoseStream(),frames=[],id=`live-${++serial}`;
 await pipeline.start();video.src='/app/samples/pullups/'+sample.video;await new Promise((ok,no)=>{video.onloadeddata=ok;video.onerror=()=>no(Error('Видео не открылось'));video.load();});
 const started=performance.now();let handle=null,last=-1,inflight=null;
 await new Promise(async(ok,no)=>{
  video.onended=()=>{if(handle!==null)video.cancelVideoFrameCallback(handle);Promise.resolve(inflight).then(ok,no);};
  const tick=(_,meta)=>{
   handle=video.requestVideoFrameCallback(tick);
   if(video.seeking||pipeline.busy||meta.mediaTime===last)return;
   last=meta.mediaTime;
   inflight=pipeline.frame(video,last,0).then(data=>{if(data)frames.push({now:data.sourceTime*1000,detectorNow:data.now,
    width:data.width,height:data.height,landmarks:data.landmarks,worldLandmarks:data.worldLandmarks});}).catch(no);
  };
  handle=video.requestVideoFrameCallback(tick);try{await video.play();}catch(e){no(e);}
 }).finally(()=>{video.pause();pipeline.close();});
 await save({id,profile:'live-original',sample:sample.id,elapsedMs:performance.now()-started,frames});
}
async function fixedRuns(){
 const index=await (await fetch('/frames/index.json')).json();
 const source=index.frames.map(f=>f.timeMs),wall=lastRuns.find(r=>r.profile==='live-original')?.frames.map(f=>f.detectorNow);
 const profiles=[['media',source],['media-repeat',source],['half-rate-clock',source.map(t=>t*.5)],['double-rate-clock',source.map(t=>t*2)]];
 if(wall?.length>3){const gaps=wall.slice(1).map((x,i)=>x-wall[i]);let time=0;profiles.push(['observed-wall',source.map((_,i)=>i?time+=gaps[(i-1)%gaps.length]:0)]);}
 for(const [profile,times]of profiles){
  $('status').textContent='Фиксированные кадры: '+profile;
  const worker=new Worker('/app/pose-worker.mjs',{type:'module'}),frames=[];
  const call=(data,transfer=[])=>new Promise((ok,no)=>{worker.onmessage=({data})=>data.type==='error'?no(Error(data.message)):ok(data);worker.onerror=e=>no(Error(e.message));worker.postMessage(data,transfer);});
  try{await call({type:'init',includeWorld:true});
   for(let i=0;i<index.frames.length;i++){
    const f=index.frames[i],bitmap=await createImageBitmap(await(await fetch('/frames/'+f.file)).blob());
    const data=await call({type:'frame',bitmap,now:1000+times[i],width:bitmap.width,height:bitmap.height},[bitmap]);
    frames.push({now:f.timeMs,detectorNow:data.now,width:data.width,height:data.height,landmarks:data.landmarks,worldLandmarks:data.worldLandmarks});
   }
  }finally{worker.terminate();}
  await save({id:profile+'-'+ ++serial,profile,sample:index.sample,frames});
 }
}
async function task(fn){
 for(const id of ['live','fixed','sample'])$(id).disabled=true;
 try{await fn();$('status').textContent='Готово. Все прогоны сохранены локально.';}
 catch(e){$('status').textContent=e.stack;}
 finally{for(const id of ['live','fixed','sample'])$(id).disabled=false;}
}
$('live').onclick=()=>task(async()=>{const sample=manifest.find(v=>v.id===$('sample').value);for(let i=0;i<5;i++){$('status').textContent=`Исходный поток: ${i+1}/5`;await liveRun(sample);}});
$('fixed').onclick=()=>task(fixedRuns);$('status').textContent='Готово';
