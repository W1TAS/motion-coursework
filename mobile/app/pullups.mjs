import {PoseStream} from './pose-stream.mjs';
import {PullupPhaseEngine as PullupEngine} from './pullup-phases.mjs';
import {pullupResultView} from './pullup-presentation.mjs';
import {drawPoseFace} from './pose-face.mjs';
import {CAMERA_NAMES,savedFacing,openCamera} from './camera.mjs';
const $=id=>document.getElementById(id);
const bones=[[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
let manifest=null,generation=0,epoch=0,onBack=null,abort=null,objectURL=null,videoBlob=null,pipeline=null;
let mode='closed',engine=new PullupEngine(),frameHandle=null,watch=null,lastFrame=-1,lastAdvance=0,lastWatchTime=0,lastDecodedAt=0,lastDecodedTime=-1,processed=0,previousPoseTime=null;
let classifier=null,modelDecisions=0,modelEpoch=0,classifierBroken=false;
let source='archive',media=null,lastFormat=null,selectedFile=null;
let facing=savedFacing({getItem:()=>localStorage.getItem('motion-pullup-camera')});
const video=()=>$('pullup-video');
function sourceControls(){
 const live=source==='camera';$('pullups').dataset.source=source;
 for(const name of ['archive','file','camera'])$('pullup-source-'+name).setAttribute('aria-pressed',String(source===name));
 $('pullup-camera-options').hidden=!live;$('pullup-recording-options').hidden=source!=='archive';$('pullup-file-options').hidden=source!=='file';$('pullup-timeline').hidden=live;
 $('pullup-source-label').textContent=live?'Поток с камеры':source==='file'?'Видео с устройства':'Встроенные примеры';
 $('pullup-restart').textContent=live?'Сбросить':'Сначала';
 for(const b of document.querySelectorAll('[data-pullup-facing]'))b.setAttribute('aria-pressed',String(b.dataset.pullupFacing===facing));
}
function stopMedia(){media?.getTracks().forEach(t=>t.stop());media=null;video().srcObject=null;}
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
function state(next){mode=next;$('pullups').dataset.mode=next;$('pullup-play').textContent=next==='running'?'Пауза':next==='ended'?'Ещё раз':next==='stalled'||next==='error'?'Повторить запуск':next==='paused'?'Продолжить':source==='camera'?'Включить камеру':'Начать разбор';}
function feedback(title,text){$('pullup-rep-title').textContent=title;$('pullup-status').textContent=text;}
function timeline(){if(source==='camera')return;const v=video();$('pullup-time').textContent=`${v.currentTime.toFixed(1)} / ${Number.isFinite(v.duration)?v.duration.toFixed(1):'—'} с`;$('pullup-seek').value=String(v.currentTime);}
function faceStatus(count){$('pullups').dataset.facePoints=String(count);$('pullup-face-status').textContent=count?`Точки лица: ${count} из 11 · голубой цвет`:'Точки лица: нет уверенных точек';}
function clearSkeleton(){const c=$('pullup-overlay');c.getContext('2d').clearRect(0,0,c.width,c.height);faceStatus(0);}
function render(result){
 $('pullup-count').textContent=String(engine.ascents.length);$('pullups').dataset.completed=String(engine.count);
 $('pullups').dataset.ascents=String(engine.ascents.length);
 if(result&&mode==='running')feedback(result.message,result.valid?`Угол локтя сейчас: ${Math.round(result.elbow)}°`:'Счёт ждёт пригодных точек тела');
 const last=engine.ascents.at(-1),box=$('pullup-results'),expanded=box.querySelector('details')?.open??false;box.replaceChildren();
 const view=pullupResultView(last,engine.completed.find(r=>r.ascentIndex===last?.index),{topEnabled:$('pullup-top-enabled').checked});
 const heightText=view?.rows.find(t=>t.startsWith('Верх:'));
 $('pullup-height-status').hidden=!heightText;$('pullup-height-status').textContent=heightText??'';
 $('pullup-height-status').dataset.height=view?.topHeight?.state??'pending';
 if(view){
  for(const text of view.rows){if(text.startsWith('Верх:'))continue;const p=document.createElement('p');p.textContent=text;box.append(p);}
  const details=document.createElement('details'),title=document.createElement('summary');details.open=expanded;title.className='model-title';title.textContent='Экспериментальная модель';details.append(title);box.append(details);
  const warning=document.createElement('p');warning.textContent='Надёжность этих заключений пока недостаточна. Они показаны для проверки модели.';details.append(warning);
  if(view.bottomCandidate){const candidate=view.bottomCandidate,p=document.createElement('p');p.dataset.bottomState=candidate.state;p.textContent='Разгибание перед подъёмом, новая проверка: '+(candidate.state==='flagged'?'возможно неполное':candidate.state==='not_detected'?'недоразгибание не обнаружено':candidate.reason);details.append(p);}
  if(view.modelMessage){const p=document.createElement('p');p.textContent=view.modelMessage;details.append(p);}
  if(view.targets)for(const [target,name]of [['partial','Амплитуда'],['swing','Раскачивание']]){const result=view.targets[target],p=document.createElement('p');p.dataset.modelTarget=target;p.dataset.modelState=result.state;p.textContent=name+': '+(result.state==='flagged'?'возможная ошибка':result.state==='not_detected'?'ошибка не обнаружена':result.reason??'недостаточно данных');details.append(p);}
 }
}
function draw(points,width,height){
 const canvas=$('pullup-overlay');if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
 const ctx=canvas.getContext('2d');ctx.clearRect(0,0,width,height);if(!points){faceStatus(0);return;}
 ctx.strokeStyle='#e5df82';ctx.lineWidth=Math.max(2,width/180);
 for(const [a,b]of bones){const x=points[a],y=points[b];if(!x||!y||Math.min(x.visibility??0,y.visibility??0)<.45||![x.x,x.y,y.x,y.y].every(Number.isFinite))continue;ctx.beginPath();ctx.moveTo(x.x*width,x.y*height);ctx.lineTo(y.x*width,y.y*height);ctx.stroke();}
 faceStatus(drawPoseFace(ctx,points,width,height));
}
function cancelFrames(){if(frameHandle!==null){if(video().cancelVideoFrameCallback)video().cancelVideoFrameCallback(frameHandle);else cancelAnimationFrame(frameHandle);}frameHandle=null;clearInterval(watch);watch=null;}
function fail(title,text){if(mode==='closed'||mode==='loading')return;if(source==='camera')pauseArchive();cancelFrames();epoch++;video().pause();engine.pause();clearSkeleton();state('error');feedback(title,text);$('pullup-play').disabled=false;}
export function pauseArchive(){
 if(source==='camera'&&(mode==='running'||mode==='loading')){
  closeArchive();engine.pause();state('paused');$('pullup-play').disabled=false;
  feedback('Камера на паузе','Камера выключена. После продолжения заново покажите нижнюю точку; счёт сохранён.');return;
 }
 if(mode!=='running')return;
 state('paused');epoch++;cancelFrames();video().pause();feedback('На паузе','Продолжение — с того же места. Счёт сохранён.');
}
export function closeArchive(){
 generation++;epoch++;state('closed');classifier?.terminate();classifier=null;cancelFrames();abort?.abort();abort=null;pipeline?.close();pipeline=null;
 video().pause();stopMedia();video().removeAttribute('src');video().load();if(objectURL)URL.revokeObjectURL(objectURL);objectURL=null;videoBlob=null;lastFormat=null;
 video().classList.remove('mirror');$('pullup-overlay').classList.remove('mirror');clearSkeleton();
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
  const decoded=metadata?.mediaTime??video().currentTime;
  if(decoded!==lastDecodedTime){lastDecodedTime=decoded;lastDecodedAt=performance.now();}
  if(video().seeking||video().readyState<2||decoded===lastFrame||pipeline?.busy)return;
  lastFrame=decoded;const token=generation,frameEpoch=epoch,time=source==='camera'?performance.now()/1000:decoded;
  pipeline.frame(video(),time,frameEpoch).then(data=>{
   if(!data||token!==generation||data.epoch!==epoch)return;
   processed++;$('pullups').dataset.frames=String(processed);
   const format=`${data.width}/${data.height}`;
   if(lastFormat&&format!==lastFormat){engine.pause();modelEpoch++;classifier?.postMessage({type:'reset'});}
   lastFormat=format;
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
   if(source==='camera')fail('Кадры камеры перестали поступать','Включите камеру заново. Завершённый счёт сохранён.');
   else{state('stalled');epoch++;cancelFrames();v.pause();engine.pause();clearSkeleton();feedback('Видео перестало поступать','Нажмите «Повторить запуск»: запись откроется с текущего места, завершённый счёт сохранится.');}
  }else if(!v.ended&&lag>2000){clearSkeleton();feedback('Ожидание кадра видео','Счётчик не добавляет повторения без новых кадров.');}
 },500);
}
function resetAnalysis(){epoch++;modelEpoch++;classifier?.postMessage({type:'reset'});modelDecisions=0;$('pullups').dataset.modelDecisions='0';engine.reset();processed=0;previousPoseTime=null;lastFrame=-1;lastFormat=null;$('pullups').dataset.frames='0';$('pullup-fps').textContent='';clearSkeleton();render();}
async function prepareRecording(kind,readVideo){
 closeArchive();source=kind;sourceControls();$('pullup-badge').textContent=kind==='file'?'ВИДЕО С УСТРОЙСТВА':'АНАЛИЗ ПРИМЕРА';state('loading');const token=generation;abort=new AbortController();const signal=abort.signal;
 $('pullup-play').disabled=true;$('pullup-restart').disabled=true;$('pullup-seek').disabled=true;resetAnalysis();feedback('Подготовка записи','Открываю видео и запускаю распознавание…');
 $('pullup-time').textContent='0 с';$('pullup-seek').value='0';$('pullup-seek').max='1';
 try{
  pipeline=new PoseStream();
  const modelReady=pipeline.start();$('pullups').dataset.model='loading';const classifierReady=startClassifier(token,signal);
  // Blob playback avoids APK byte-range streaming and works without a network server.
  await Promise.all([modelReady,classifierReady,(async()=>{
   const blob=await readVideo(signal);if(signal.aborted)return;videoBlob=blob;await loadBlob(signal);
  })()]);
  if(token!==generation)return;
  state('ready');$('pullup-play').disabled=false;$('pullup-restart').disabled=false;$('pullup-seek').disabled=false;timeline();feedback('Готово к разбору',kind==='file'?'Видео остаётся на устройстве. Нажмите «Начать разбор»: обработка идёт как для камеры.':'Нажмите «Начать разбор». Точки и повторения будут вычисляться по кадрам.');
 }catch(e){if(token!==generation)return;abort.abort();pipeline?.close();pipeline=null;state('error');feedback('Не удалось подготовить запись',e.message+' Для видео с телефона попробуйте MP4 с кодеком H.264.');$('pullup-play').disabled=false;}
}
async function choose(id){
 const item=manifest?.find(v=>v.id===id);if(!item)return;
 await prepareRecording('archive',async signal=>{
  const response=await fetch(new URL(`./samples/pullups/${item.video}`,import.meta.url),{signal});if(!response.ok)throw Error('Не удалось прочитать видео');
  return response.blob();
 });
}
async function chooseFile(file){
 if(!file)return; // Cancelling the picker leaves the current video and results intact.
 if(!file.size||!(file.type.startsWith('video/')||/\.(mp4|m4v|mov|webm|mkv|3gp|avi)$/i.test(file.name))){
  feedback('Выберите видео','Этот файл не похож на видеозапись. Попробуйте MP4, MOV или WebM.');return;
 }
 selectedFile=file;$('pullup-file-name').textContent=file.name;$('pullup-file-name').title=file.name;
 // File is already a Blob: do not copy a large recording into an ArrayBuffer or upload it.
 await prepareRecording('file',()=>file);
}
function retryRecording(){return source==='file'?chooseFile(selectedFile):choose($('pullup-select').value);}
function pickFile(){
 if(source!=='file')selectSource('file');
 $('pullup-file').value='';$('pullup-file').click();
}
export async function openArchive(back){
 onBack=back;selectedFile=null;$('pullup-file-name').textContent='Из памяти телефона';source='archive';sourceControls();state('loading');$('pullups').hidden=false;document.body.classList.add('workout-open');
 const token=++generation;
 try{
  if(!manifest){const r=await fetch(new URL('./samples/pullups/manifest.json',import.meta.url),{cache:'no-store'});if(!r.ok)throw Error('Не удалось загрузить список записей');manifest=await r.json();}
  if(token!==generation)return;
  $('pullup-select').replaceChildren();for(const item of manifest){const option=document.createElement('option');option.value=item.id;option.textContent=`${item.title} · ${item.duration} с`;$('pullup-select').append(option);}
  if(manifest.length)await choose(manifest[0].id);
  else throw Error('Встроенные примеры не установлены.');
 }catch(e){if(token===generation){state('error');feedback('Не удалось открыть примеры',e.message+' Можно выбрать «Файл» или «Камера».');}}
}
async function selectSource(next,force=false){
 if(next===source&&!force)return;
 if(next==='archive'&&manifest?.length){await choose($('pullup-select').value||manifest[0].id);return;}
 if(next==='file'&&selectedFile){await chooseFile(selectedFile);return;}
 closeArchive();source=next;sourceControls();resetAnalysis();state('ready');
 $('pullup-play').disabled=next!=='camera';$('pullup-restart').disabled=true;$('pullup-seek').disabled=true;
 $('pullup-badge').textContent=next==='camera'?'КАМЕРА ВЫКЛЮЧЕНА':'ВЫБЕРИТЕ ВИДЕО';
 if(next==='camera')feedback('Подтягивания с камеры','Поставьте телефон неподвижно спереди. Начните с нижней точки и нажмите «Включить камеру».');
 else feedback('Видео с устройства','Нажмите «Выбрать видео». Файл обрабатывается здесь и никуда не отправляется.');
}
async function startLiveCamera(){
 closeArchive();source='camera';sourceControls();state('loading');if(engine.lastTime!==null)engine.pause();
 modelEpoch++;previousPoseTime=null;lastFrame=-1;const token=generation;abort=new AbortController();const signal=abort.signal;
 $('pullup-play').disabled=true;$('pullup-restart').disabled=false;feedback('Подготовка камеры','Включаю выбранную камеру и распознавание…');
 try{
  if(!window.isSecureContext)throw Error('Для камеры нужен APK, localhost или HTTPS.');
  if(!navigator.mediaDevices?.getUserMedia)throw Error('Камера недоступна. Проверьте Chrome или Android System WebView.');
  const opened=await openCamera(navigator.mediaDevices,facing);
  if(token!==generation){opened.stream.getTracks().forEach(t=>t.stop());return;}
  media=opened.stream;video().srcObject=media;await video().play();if(token!==generation)return;
  video().classList.toggle('mirror',opened.mirror);$('pullup-overlay').classList.toggle('mirror',opened.mirror);
  $('pullup-camera').style.aspectRatio=`${video().videoWidth}/${video().videoHeight}`;
  pipeline=new PoseStream();$('pullups').dataset.model='loading';
  await Promise.all([pipeline.start(),startClassifier(token,signal)]);if(token!==generation)return;
  const track=media.getVideoTracks()[0];track.addEventListener('ended',()=>{if(token===generation&&mode==='running')fail('Камера отключилась','Включите камеру снова. Счёт сохранён.');},{once:true});
  state('running');$('pullup-play').disabled=false;
  $('pullup-badge').textContent=(opened.actual?CAMERA_NAMES[opened.actual].toUpperCase():'КАМЕРА')+' · ЛОКАЛЬНЫЙ АНАЛИЗ';
  feedback('Покажите нижнюю точку','Лицо, обе руки и таз должны быть видны. Сначала спокойно повисните, затем начинайте подъём.');
  schedule();monitor();
 }catch(e){
  if(token!==generation)return;
  closeArchive();engine.pause();state('error');$('pullup-play').disabled=false;$('pullup-badge').textContent='КАМЕРА ВЫКЛЮЧЕНА';
  feedback('Не удалось включить камеру',e.name==='NotAllowedError'?'Разрешите камеру приложению в настройках Android или браузера.':e.message);
 }
}
async function play(){
 if(mode==='running'){pauseArchive();return;}
 if(mode==='loading'||mode==='closed')return;
 if(source==='camera'){await startLiveCamera();return;}
 if(!pipeline||!videoBlob){await retryRecording();return;}
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
$('pullup-source-archive').onclick=()=>selectSource('archive');
$('pullup-source-file').onclick=pickFile;
$('pullup-file-choose').onclick=pickFile;
$('pullup-file').onchange=e=>chooseFile(e.target.files?.[0]);
$('pullup-source-camera').onclick=()=>selectSource('camera');
$('pullup-top-enabled').onchange=()=>render();
for(const button of document.querySelectorAll('[data-pullup-facing]'))button.onclick=async()=>{
 const next=button.dataset.pullupFacing;if(next===facing)return;
 const restart=mode==='running'||mode==='loading';facing=next;try{localStorage.setItem('motion-pullup-camera',facing);}catch{}
 await selectSource('camera',true);if(restart)await startLiveCamera();
};
$('pullup-back').onclick=()=>{closeArchive();selectedFile=null;$('pullup-file').value='';$('pullups').hidden=true;document.body.classList.remove('workout-open');onBack?.();};
$('pullup-play').onclick=play;
$('pullup-restart').onclick=()=>{if(source==='camera'){pauseArchive();resetAnalysis();state('paused');feedback('Счёт сброшен','Нажмите «Продолжить» и заново покажите нижнюю точку.');return;}if(mode==='error'||mode==='stalled'){retryRecording();return;}pauseArchive();resetAnalysis();video().currentTime=0;state('paused');feedback('Счёт сброшен','Нажмите «Продолжить», чтобы разобрать запись с начала.');timeline();};
$('pullup-seek').onchange=e=>{const time=Number(e.target.value);resetAnalysis();video().currentTime=time;if(mode==='ended')state('paused');feedback('Разбор с выбранного места','Счёт начинается с нуля после определения нижней точки.');timeline();};
video().addEventListener('timeupdate',timeline);
video().addEventListener('seeked',()=>{lastFrame=-1;if(mode==='running')schedule();});
video().addEventListener('ended',()=>{if(source==='camera')return;cancelFrames();state('ended');timeline();feedback('Запись завершена','Показан результат обработанных кадров. Можно запустить разбор заново.');});
video().addEventListener('error',()=>{if(mode!=='loading'&&mode!=='closed')fail('Ошибка воспроизведения','Запись не удалось прочитать до конца. Можно повторить запуск.');});
