import {PoseStream} from './pose-stream.mjs';
import {PullupPhaseEngine as PullupEngine} from './pullup-phases.mjs';
import {pullupResultView} from './pullup-presentation.mjs';
const $=id=>document.getElementById(id);
const bones=[[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
let manifest=null,generation=0,epoch=0,onBack=null,abort=null,objectURL=null,videoBlob=null,pipeline=null;
let mode='closed',engine=new PullupEngine(),frameHandle=null,watch=null,lastFrame=-1,lastAdvance=0,lastWatchTime=0,lastDecodedAt=0,lastDecodedTime=-1,processed=0,previousPoseTime=null;
let classifier=null,modelDecisions=0,modelEpoch=0,classifierBroken=false;
const video=()=>$('pullup-video');
function startClassifier(token,signal){
 classifierBroken=false;classifier=new Worker(new URL('./pullup-classifier-worker.mjs',import.meta.url),{type:'module'});
 const worker=classifier;
 return new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(Error('Классификатор не запустился')),45000);
  const stop=()=>{clearTimeout(timeout);worker.terminate();reject(new DOMException('Загрузка отменена','AbortError'));};
  signal.addEventListener('abort',stop,{once:true});
  worker.onerror=()=>{clearTimeout(timeout);if(token!==generation)return;classifierBroken=true;worker.terminate();$('pullups').dataset.model='error';const rep=engine.completed.at(-1),ascent=engine.ascents.at(-1);if(rep)rep.model={error:'Модель остановилась. Выберите запись повторно.'};if(ascent)ascent.analysis={error:'Модель недоступна. Выберите запись повторно.'};render();reject(Error('Ошибка классификатора'));};
  worker.onmessage=({data})=>{
   if(token!==generation)return;
   if(data.type==='ready'){clearTimeout(timeout);$('pullups').dataset.model='ready';resolve();}
   else if(data.type==='ascent-decision'&&data.epoch===modelEpoch){const ascent=engine.ascents.find(r=>r.index===data.index);if(ascent){ascent.analysis=data.decision;render();}}
   else if(data.type==='decision'&&data.epoch===modelEpoch){const rep=engine.completed.find(r=>r.index===data.index);if(rep){rep.model=data.decision;modelDecisions++;$('pullups').dataset.modelDecisions=String(modelDecisions);render();window.dispatchEvent(new CustomEvent('motion:pullup-result',{detail:{rep,elapsedMs:data.elapsedMs}}));}}
   else if(data.type==='error'){clearTimeout(timeout);if(data.ascentIndex&&data.epoch===modelEpoch){const ascent=engine.ascents.find(r=>r.index===data.ascentIndex);if(ascent){ascent.analysis={error:'Не удалось проверить начало подъёма'};render();}}else if(data.index){const rep=engine.completed.find(r=>r.index===data.index);if(rep&&data.epoch===modelEpoch){rep.model={error:'Не удалось получить оценку модели'};render();}}else reject(Error(data.message));}
  };worker.postMessage({type:'init'});
 });
}
function state(next){mode=next;$('pullups').dataset.mode=next;$('pullup-play').textContent=next==='running'?'Пауза':next==='ended'?'Ещё раз':next==='stalled'||next==='error'?'Повторить запуск':next==='paused'?'Продолжить':'Начать разбор';}
function feedback(title,text){$('pullup-rep-title').textContent=title;$('pullup-status').textContent=text;}
function timeline(){const v=video();$('pullup-time').textContent=`${v.currentTime.toFixed(1)} / ${Number.isFinite(v.duration)?v.duration.toFixed(1):'—'} с`;$('pullup-seek').value=String(v.currentTime);}
function clearSkeleton(){const c=$('pullup-overlay');c.getContext('2d').clearRect(0,0,c.width,c.height);}
function render(result){
 $('pullup-count').textContent=String(engine.ascents.length);$('pullups').dataset.completed=String(engine.count);
 $('pullups').dataset.ascents=String(engine.ascents.length);
 if(result&&mode==='running')feedback(result.message,result.valid?`Угол локтя сейчас: ${Math.round(result.elbow)}°`:'Счёт ждёт пригодных точек тела');
 const last=engine.ascents.at(-1),box=$('pullup-results'),expanded=box.querySelector('details')?.open??false;box.replaceChildren();
 const view=pullupResultView(last,engine.completed.find(r=>r.ascentIndex===last?.index));
 if(view){
  for(const text of view.rows){const p=document.createElement('p');p.textContent=text;box.append(p);}
  const details=document.createElement('details'),title=document.createElement('summary');details.open=expanded;title.className='model-title';title.textContent='Экспериментальная модель';details.append(title);box.append(details);
  const warning=document.createElement('p');warning.textContent='Надёжность этих заключений пока недостаточна. Они показаны для проверки модели.';details.append(warning);
  if(view.bottomCandidate){const candidate=view.bottomCandidate,p=document.createElement('p');p.dataset.bottomState=candidate.state;p.textContent='Разгибание перед подъёмом, новая проверка: '+(candidate.state==='flagged'?'возможно неполное':candidate.state==='not_detected'?'недоразгибание не обнаружено':candidate.reason);details.append(p);}
  if(view.modelMessage){const p=document.createElement('p');p.textContent=view.modelMessage;details.append(p);}
  if(view.targets)for(const [target,name]of [['partial','Амплитуда'],['swing','Раскачивание']]){const result=view.targets[target],p=document.createElement('p');p.dataset.modelTarget=target;p.dataset.modelState=result.state;p.textContent=name+': '+(result.state==='flagged'?'возможная ошибка':result.state==='not_detected'?'ошибка не обнаружена':result.reason??'недостаточно данных');details.append(p);}
 }
}
function draw(points,width,height){
 const canvas=$('pullup-overlay');if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
 const ctx=canvas.getContext('2d');ctx.clearRect(0,0,width,height);if(!points)return;
 ctx.strokeStyle='#e5df82';ctx.lineWidth=Math.max(2,width/180);
 for(const [a,b]of bones){const x=points[a],y=points[b];if(!x||!y||Math.min(x.visibility??0,y.visibility??0)<.45||![x.x,x.y,y.x,y.y].every(Number.isFinite))continue;ctx.beginPath();ctx.moveTo(x.x*width,x.y*height);ctx.lineTo(y.x*width,y.y*height);ctx.stroke();}
}
function cancelFrames(){if(frameHandle!==null){if(video().cancelVideoFrameCallback)video().cancelVideoFrameCallback(frameHandle);else cancelAnimationFrame(frameHandle);}frameHandle=null;clearInterval(watch);watch=null;}
function fail(title,text){if(mode==='closed'||mode==='loading')return;cancelFrames();epoch++;video().pause();engine.pause();clearSkeleton();state('error');feedback(title,text);$('pullup-play').disabled=false;}
export function pauseArchive(){
 if(mode!=='running')return;
 state('paused');epoch++;cancelFrames();video().pause();feedback('На паузе','Продолжение — с того же места. Счёт сохранён.');
}
export function closeArchive(){
 generation++;epoch++;state('closed');classifier?.terminate();classifier=null;cancelFrames();abort?.abort();abort=null;pipeline?.close();pipeline=null;
 video().pause();video().removeAttribute('src');video().load();if(objectURL)URL.revokeObjectURL(objectURL);objectURL=null;videoBlob=null;clearSkeleton();
}
function loaded(signal){
 return new Promise((resolve,reject)=>{
  const done=error=>{clearTimeout(timeout);video().removeEventListener('loadeddata',ready);video().removeEventListener('error',failed);signal.removeEventListener('abort',cancel);error?reject(error):resolve();};
  const ready=()=>done(),failed=()=>done(Error('Не удалось декодировать запись')),cancel=()=>done(new DOMException('Загрузка отменена','AbortError'));
  const timeout=setTimeout(()=>done(Error('Видео не загрузилось. Повторите запуск.')),20000);
  video().addEventListener('loadeddata',ready);video().addEventListener('error',failed);signal.addEventListener('abort',cancel,{once:true});
 });
}
async function loadBlob(signal,time=0){
 const old=objectURL;objectURL=URL.createObjectURL(videoBlob);
 const ready=loaded(signal);video().src=objectURL;video().load();if(old)URL.revokeObjectURL(old);await ready;
 if(signal.aborted)throw new DOMException('Загрузка отменена','AbortError');
 if(time>0)video().currentTime=Math.min(time,Math.max(0,video().duration-.1));
 $('pullup-camera').style.aspectRatio=`${video().videoWidth}/${video().videoHeight}`;$('pullup-seek').max=String(video().duration);
}
function schedule(){
 if(mode!=='running'||frameHandle!==null)return;
 const callback=(_,metadata)=>{
  frameHandle=null;if(mode!=='running')return;schedule();
  const time=metadata?.mediaTime??video().currentTime;
  if(time!==lastDecodedTime){lastDecodedTime=time;lastDecodedAt=performance.now();}
  if(video().seeking||video().readyState<2||time===lastFrame||pipeline?.busy)return;
  lastFrame=time;const token=generation,frameEpoch=epoch;
  pipeline.frame(video(),time,frameEpoch).then(data=>{
   if(!data||token!==generation||data.epoch!==epoch)return;
   processed++;$('pullups').dataset.frames=String(processed);
   const before=engine.count,ascentsBefore=engine.ascents.length,r=engine.update(data.landmarks,data.sourceTime*1000,data.width,data.height);
   const ascent=engine.ascents.length>ascentsBefore?engine.ascents.at(-1):null;
   if(classifierBroken&&ascent)ascent.analysis={error:'Модель недоступна. Выберите запись повторно.'};
   if(classifierBroken&&engine.count>before)engine.completed.at(-1).model={error:'Модель недоступна. Выберите запись повторно.'};
   if(!classifierBroken)classifier?.postMessage({type:'observe',points:data.landmarks,worldLandmarks:data.worldLandmarks,time:data.sourceTime*1000,width:data.width,height:data.height,phase:r.phase,epoch:modelEpoch,ascent,rep:engine.count>before?engine.completed.at(-1):null});
   draw(data.landmarks,data.width,data.height);render(r);
   if(previousPoseTime!==null&&data.sourceTime>previousPoseTime)$('pullup-fps').textContent=`${Math.round(1/(data.sourceTime-previousPoseTime))} кадр/с`;
   previousPoseTime=data.sourceTime;
  }).catch(e=>{if(token===generation&&frameEpoch===epoch&&e.name!=='AbortError')fail('Анализ остановился',e.message);});
 };
 frameHandle=video().requestVideoFrameCallback?video().requestVideoFrameCallback(callback):requestAnimationFrame(callback);
}
function monitor(){
 clearInterval(watch);lastWatchTime=video().currentTime;lastAdvance=performance.now();lastDecodedAt=lastAdvance;lastDecodedTime=-1;
 watch=setInterval(()=>{
  if(mode!=='running')return;
  const v=video();timeline();
  if(v.currentTime!==lastWatchTime){lastWatchTime=v.currentTime;lastAdvance=performance.now();}
  const lag=Math.max(performance.now()-lastAdvance,performance.now()-lastDecodedAt);
  if(!v.ended&&!v.seeking&&lag>8000){
   state('stalled');epoch++;cancelFrames();v.pause();engine.pause();clearSkeleton();feedback('Видео перестало поступать','Нажмите «Повторить запуск»: запись откроется с текущего места, завершённый счёт сохранится.');
  }else if(!v.ended&&lag>2000){clearSkeleton();feedback('Ожидание кадра видео','Счётчик не добавляет повторения без новых кадров.');}
 },500);
}
function resetAnalysis(){epoch++;modelEpoch++;classifier?.postMessage({type:'reset'});modelDecisions=0;$('pullups').dataset.modelDecisions='0';engine.reset();processed=0;previousPoseTime=null;lastFrame=-1;$('pullups').dataset.frames='0';$('pullup-fps').textContent='';clearSkeleton();render();}
async function choose(id){
 closeArchive();state('loading');const token=generation;abort=new AbortController();const signal=abort.signal;
 $('pullup-play').disabled=true;$('pullup-restart').disabled=true;$('pullup-seek').disabled=true;resetAnalysis();feedback('Подготовка записи','Загружаю видео целиком и запускаю модель…');
 const item=manifest.find(v=>v.id===id);if(!item)return;
 try{
  pipeline=new PoseStream();
  const modelReady=pipeline.start();$('pullups').dataset.model='loading';const classifierReady=startClassifier(token,signal);
  // Blob playback avoids APK byte-range streaming and works without a network server.
  await Promise.all([modelReady,classifierReady,(async()=>{
   const response=await fetch(new URL(`./samples/pullups/${item.video}`,import.meta.url),{signal});if(!response.ok)throw Error('Не удалось прочитать видео');
   const blob=await response.blob();if(signal.aborted)return;videoBlob=blob;await loadBlob(signal);
  })()]);
  if(token!==generation)return;
  state('ready');$('pullup-play').disabled=false;$('pullup-restart').disabled=false;$('pullup-seek').disabled=false;timeline();feedback('Готово к разбору','Нажмите «Начать разбор». Точки и повторения будут вычисляться по кадрам.');
 }catch(e){if(token!==generation)return;abort.abort();pipeline?.close();pipeline=null;state('error');feedback('Не удалось подготовить запись',e.message);$('pullup-play').disabled=false;}
}
export async function openArchive(back){
 onBack=back;$('pullups').hidden=false;document.body.classList.add('workout-open');
 const token=++generation;
 try{
  if(!manifest){const r=await fetch(new URL('./samples/pullups/manifest.json',import.meta.url));if(!r.ok)throw Error('Не удалось загрузить список записей');manifest=await r.json();}
  if(token!==generation)return;
  $('pullup-select').replaceChildren();for(const item of manifest){const option=document.createElement('option');option.value=item.id;option.textContent=`${item.title} · ${item.duration} с`;$('pullup-select').append(option);}
  await choose(manifest[0].id);
 }catch(e){if(token===generation)feedback('Не удалось открыть записи',e.message);}
}
async function play(){
 if(mode==='running'){pauseArchive();return;}
 if(mode==='loading'||mode==='closed')return;
 if(!pipeline||!videoBlob){await choose($('pullup-select').value);return;}
 const token=generation;
 try{
  if(mode==='error'||mode==='stalled'){
   const time=video().currentTime;state('loading');$('pullup-play').disabled=true;epoch++;engine.pause();lastFrame=-1;
   pipeline.close();pipeline=new PoseStream();await Promise.all([pipeline.start(),loadBlob(abort.signal,time)]);if(token!==generation)return;
  }
  if(video().ended||mode==='ended'){resetAnalysis();video().currentTime=0;}
  state('running');$('pullup-play').disabled=false;feedback('Разбор идёт','Ожидаю первые пригодные кадры');await video().play();if(token!==generation||mode!=='running')return;schedule();monitor();
 }catch(e){if(token===generation&&mode!=='paused'){state('error');fail('Не удалось продолжить запись',e.message);}}
}
$('pullup-select').onchange=e=>choose(e.target.value);
$('pullup-back').onclick=()=>{closeArchive();$('pullups').hidden=true;document.body.classList.remove('workout-open');onBack?.();};
$('pullup-play').onclick=play;
$('pullup-restart').onclick=()=>{if(mode==='error'||mode==='stalled'){choose($('pullup-select').value);return;}pauseArchive();resetAnalysis();video().currentTime=0;state('paused');feedback('Счёт сброшен','Нажмите «Продолжить», чтобы разобрать запись с начала.');timeline();};
$('pullup-seek').onchange=e=>{const time=Number(e.target.value);resetAnalysis();video().currentTime=time;if(mode==='ended')state('paused');feedback('Разбор с выбранного места','Счёт начинается с нуля после определения нижней точки.');timeline();};
video().addEventListener('timeupdate',timeline);
video().addEventListener('seeked',()=>{lastFrame=-1;if(mode==='running')schedule();});
video().addEventListener('ended',()=>{cancelFrames();state('ended');timeline();feedback('Запись завершена','Показан результат обработанных кадров. Можно запустить разбор заново.');});
video().addEventListener('error',()=>{if(mode!=='loading'&&mode!=='closed')fail('Ошибка воспроизведения','Запись не удалось прочитать до конца. Можно повторить запуск.');});
