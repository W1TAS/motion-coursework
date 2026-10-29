import {openArchive,pauseArchive} from './pullups.mjs';
import {CAMERA_NAMES,savedFacing,openCamera,poseFeedback} from './camera.mjs';
import {ExerciseEngine,examplePose,RULES} from './engine.mjs';
const $=id=>document.getElementById(id);
const names={pushups:'Отжимания',plank:'Планка'};
let exercise='pushups',engine=new ExerciseEngine(),mode='idle',stream=null,worker=null,busy=false,frameTimer=null,generation=0,facing=savedFacing({getItem:key=>localStorage.getItem(key)}),lastFrame=-1,startTime=0,previousPoseTime=0,lastPoseAt=0,exampleSession=false;
const bones=[[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
function history(){try{return JSON.parse(localStorage.getItem('motion-history')??'[]').slice(0,20);}catch{return [];}}
function renderHistory(){const rows=history();$('history').replaceChildren();if(!rows.length){$('history').innerHTML='<p class="empty">Завершённые подходы появятся здесь</p>';return;}for(const row of rows){const el=document.createElement('div');el.className='history-row';const left=document.createElement('div');left.textContent=names[row.exercise]??'Упражнение';const date=document.createElement('small');date.textContent=new Date(row.date).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});left.append(date);const value=document.createElement('strong');value.textContent=row.exercise==='plank'?`${row.value.toFixed(1)} с`:`${row.value} повт.`;el.append(left,value);$('history').append(el);}}
function saveSession(){const value=exercise==='plank'?engine.seconds:engine.count;if(value<=0)return;try{localStorage.setItem('motion-history',JSON.stringify([{exercise,value,date:Date.now()},...history()].slice(0,20)));}catch{}renderHistory();}
function cameraButtons(disabled=false){for(const button of document.querySelectorAll('[data-facing]')){button.disabled=disabled;button.setAttribute('aria-pressed',String(button.dataset.facing===facing));}}
function cameraSelection(actual){
 if(actual===undefined)$('camera-selection').textContent=`Выбрана ${CAMERA_NAMES[facing].toLowerCase()} камера`;
 else $('camera-selection').textContent=actual?`Используется ${CAMERA_NAMES[actual].toLowerCase()} камера`:'Устройство не сообщает тип включённой камеры';
}
function message(text,state='idle',title){
 $('feedback').textContent=text;
 $('feedback-title').textContent=title??(state==='active'?'Положение подходит для подсчёта':state==='warning'?'Нужна корректировка':state==='example'?'Учебный пример':state==='loading'?'Подготовка':'Анализ не идёт');
 $('feedback').closest('.feedback').dataset.state=state;
 $('feedback-number').textContent=state==='active'?'✓':state==='warning'?'!':state==='loading'?'…':'○';
 $('signal-text').textContent=state==='active'?'Можно считать':state==='warning'?'Не считается':state==='example'?'Пример':state==='loading'?'Подготовка':'Пауза';
 $('signal-dot').className=`dot ${state==='active'?'':state==='example'||state==='warning'?'amber':'gray'}`;
}
function metric(){$('metric').textContent=exercise==='plank'?engine.seconds.toFixed(1):engine.count;}
function draw(points,width,height,active){const canvas=$('overlay');if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}const c=canvas.getContext('2d');c.clearRect(0,0,width,height);if(!points)return;c.strokeStyle=active?'#c7ee90':'#e8c58b';c.fillStyle=c.strokeStyle;c.lineWidth=Math.max(2,width/180);for(const [a,b]of bones){if((points[a]?.visibility??0)<.6||(points[b]?.visibility??0)<.6)continue;c.beginPath();c.moveTo(points[a].x*width,points[a].y*height);c.lineTo(points[b].x*width,points[b].y*height);c.stroke();}for(const id of [0,11,12,13,14,15,16,23,24,25,26,27,28]){const p=points[id];if(!p||p.visibility<.6)continue;c.beginPath();c.arc(p.x*width,p.y*height,Math.max(3,width/120),0,Math.PI*2);c.fill();}}
function applyPose(points,now,width,height){
 const before=engine.count,r=engine.update(points,now,width,height),view=poseFeedback(r,exercise);
 metric();
 if(mode==='live'&&previousPoseTime&&now-previousPoseTime>RULES.maxGap){view.state='warning';view.title='Камера работает медленно';view.text='Кадры поступают слишком редко для непрерывного подсчёта.';}
 draw(points,width,height,view.state==='active');
 const example=mode==='example'||mode==='recording';
 message(view.text,example?'example':view.state,example?'Учебный пример · '+view.title.toLowerCase():view.title);
 if(mode==='recording')$('signal-text').textContent='Видеопример';if(mode==='example')$('signal-text').textContent='Учебный пример';
 if(before<engine.count&&mode==='live'&&navigator.vibrate)navigator.vibrate(70);
}
function release(){generation++;clearTimeout(frameTimer);frameTimer=null;worker?.terminate();worker=null;busy=false;stream?.getTracks().forEach(t=>t.stop());stream=null;$('video').pause();$('video').onended=null;$('video').srcObject=null;$('video').removeAttribute('src');$('video').load();$('video').hidden=true;draw(null,640,480,false);engine.pause();$('start').disabled=false;cameraButtons(false);$('camera-placeholder').hidden=false;cameraSelection();$('fps').textContent='';lastFrame=-1;}
function pause(){if(mode==='idle'||mode==='paused')return;release();mode='paused';$('mode-badge').textContent='НА ПАУЗЕ';$('start').textContent='Продолжить с камерой';message('Анализ остановлен. Можно продолжить или завершить подход.');draw(null,640,480,false);}
function select(which){release();exercise=which;engine=new ExerciseEngine(which);exampleSession=false;mode='idle';$('home').hidden=true;$('workout').hidden=false;$('exercise-name').textContent=names[which];document.body.classList.add('workout-open');$('unit').textContent=which==='pushups'?'повторений':'секунд';$('setup-tip').textContent=which==='pushups'?'С фронтальной камерой видно экран, но тело всё равно нужно снимать сбоку. Начните с упора на прямых руках; корпус и ноги держите в одной линии.':'Выберите удобную камеру; телефон должен смотреть на тело сбоку. Примите планку на предплечьях, выпрямите корпус и ноги.';$('rules-text').textContent=which==='pushups'?'Счётчик ждёт выпрямления рук (угол локтя ≥155°), затем сгибания ≤100° и возвращения наверх. Остановка в крайних точках не нужна: достигнутый угол подтверждается соседними кадрами движения. Одиночный скачок точек не считается. Нужны прямой корпус и видимые точки одной стороны тела.':'Таймер проверяет прямой корпус и ноги, согнутые руки, положение плеч над локтями и подъём таза и коленей относительно линии локоть–стопа. Перед отсчётом нужно удержать подходящую позу 0,6 с. При потере положения отсчёт сразу прекращается; время проверки не добавляется. Это оценка по изображению, а не измерение контакта с полом.';$('example-note').hidden=true;$('video-example').hidden=false;$('video-example').textContent=which==='pushups'?'Разобрать готовый пример отжиманий':'Разобрать видео планки';$('video-credit').hidden=true;$('summary').hidden=true;$('mode-badge').textContent='КАМЕРА ВЫКЛЮЧЕНА';$('start').textContent='Включить камеру';$('finish').disabled=true;$('example').textContent='Посмотреть пример без камеры';message('Включите камеру, когда будете готовы');metric();draw(null,640,480,false);window.scrollTo(0,0);}
async function startCamera(){
 if(mode==='live'||mode==='recording'||mode==='loading'){pause();return;}
 release();const token=generation;mode='loading';metric();$('start').disabled=true;cameraButtons(true);$('finish').disabled=false;$('example-note').hidden=true;$('video-credit').hidden=true;$('summary').hidden=true;message('Подготовка камеры и модели…','loading');
 try{
  if(!window.isSecureContext)throw new Error('Для камеры нужен APK или адрес localhost / HTTPS. Откройте установленное приложение.');
  if(!navigator.mediaDevices?.getUserMedia)throw new Error('Камера недоступна. Обновите Android System WebView или Chrome.');
  const opened=await openCamera(navigator.mediaDevices,facing),media=opened.stream;
  if(token!==generation){media.getTracks().forEach(t=>t.stop());return;}stream=media;
  const video=$('video');video.hidden=false;video.srcObject=media;await video.play();if(token!==generation)return;
  const mirror=opened.mirror;cameraSelection(opened.actual);video.classList.toggle('mirror',mirror);$('overlay').classList.toggle('mirror',mirror);$('camera').style.aspectRatio=`${video.videoWidth}/${video.videoHeight}`;
  worker=new Worker(new URL('./pose-worker.mjs',import.meta.url),{type:'module'});
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Модель не запустилась за 45 секунд. Попробуйте ещё раз.')),45000);worker.onerror=e=>{clearTimeout(timeout);reject(new Error(e.message||'Не удалось запустить распознавание'));};worker.onmessage=({data})=>{if(data.type==='ready'){clearTimeout(timeout);resolve();}else if(data.type==='error'){clearTimeout(timeout);reject(new Error(data.message));}};worker.postMessage({type:'init'});});
  if(token!==generation)return;
  // An example never contributes to a real session.
  if(exampleSession){engine.reset();metric();}exampleSession=false;engine.pause();mode='live';startTime=performance.now();previousPoseTime=0;lastPoseAt=performance.now();$('mode-badge').textContent='КАМЕРА · НА УСТРОЙСТВЕ';$('camera-placeholder').hidden=true;$('start').disabled=false;cameraButtons(false);$('start').textContent='Пауза';$('example').textContent='Посмотреть учебный пример';message('Встаньте в кадр целиком и примите исходное положение','loading','Проверяю положение');
  worker.onmessage=({data})=>{if(token!==generation)return;busy=false;if(data.type==='error'){pause();message('Ошибка распознавания. Перезапустите камеру.');console.error(data.message);return;}if(data.type==='pose'){lastPoseAt=performance.now();applyPose(data.landmarks,data.now,data.width,data.height);if(previousPoseTime)$('fps').textContent=`${Math.round(1000/(data.now-previousPoseTime))} кадр/с`;previousPoseTime=data.now;}};
  worker.onerror=()=>{if(token===generation){pause();message('Модуль распознавания остановился. Запустите камеру ещё раз.');}};
  const tick=async()=>{if(token!==generation||mode!=='live')return;if(performance.now()-lastPoseAt>1200){engine.pause();draw(null,640,480,false);message('Новые кадры не поступают. Проверьте камеру или включите её заново.','warning','Нет свежего изображения');}if(!busy&&video.readyState>=2&&video.currentTime!==lastFrame){busy=true;lastFrame=video.currentTime;try{const bitmap=await createImageBitmap(video);if(token!==generation){bitmap.close();return;}worker.postMessage({type:'frame',bitmap,now:performance.now(),width:video.videoWidth,height:video.videoHeight},[bitmap]);}catch(e){busy=false;pause();message('Не удалось получить кадр камеры. Попробуйте ещё раз.');return;}}frameTimer=setTimeout(tick,16);};tick();
 }catch(error){if(token!==generation)return;release();mode='paused';$('mode-badge').textContent='КАМЕРА НЕДОСТУПНА';$('start').textContent='Попробовать снова';message(error.name==='NotAllowedError'?'Разрешите приложению доступ к камере в настройках Android и попробуйте снова.':error.name==='NotFoundError'?'На устройстве не найдена камера.':error.message,'warning','Камера не включилась');}
}
async function startVideoExample(){
 release();engine.reset();exampleSession=true;metric();mode='loading';const token=generation;
 $('start').disabled=true;$('finish').disabled=false;$('summary').hidden=true;$('example-note').hidden=false;$('video-credit').hidden=false;
 $('example-note').textContent=exercise==='plank'?'Учебное видео планки: 12 секунд записи, обычная скорость. Поза и время вычисляются заново. Пример не сохраняется в историю.':'Последовательность фотографий: замедлена ×2 и повторена 4 раза. Точки и счёт вычисляются заново; это иллюстрация, не проверка точности.';
 $('video-credit').textContent=exercise==='plank'?'Forearm Plank — SSgt Randall Moose, U.S. Air Force, 2021. DVIDS: https://www.dvidshub.net/video/825280/forearm-plank. Public domain по странице источника. Фрагмент 5–17 с, без звука, уменьшен до 640 px. Использование не означает поддержку приложения автором.':'Frank C. Müller, Liegestuetz02 ani fcm.gif, 2006. https://commons.wikimedia.org/wiki/File:Liegestuetz02_ani_fcm.gif. CC BY-SA 4.0: https://creativecommons.org/licenses/by-sa/4.0/. Замедление ×2, повтор 4 раза, уменьшение и конвертация в MP4.';
 message('Загрузка видеопримера и модели…','loading');
 try{
  const video=$('video');video.src=new URL(`./samples/${exercise==='plank'?'plank':'pushups'}.mp4`,import.meta.url).href;video.hidden=false;video.classList.remove('mirror');$('overlay').classList.remove('mirror');
  await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=()=>reject(new Error('Не удалось открыть видеопример'));});
  if(token!==generation)return;video.onloadedmetadata=null;$('camera').style.aspectRatio=`${video.videoWidth}/${video.videoHeight}`;
  worker=new Worker(new URL('./pose-worker.mjs',import.meta.url),{type:'module'});
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Модель не запустилась за 45 секунд')),45000);worker.onerror=e=>{clearTimeout(timeout);reject(new Error(e.message));};worker.onmessage=({data})=>{if(data.type==='ready'){clearTimeout(timeout);resolve();}if(data.type==='error'){clearTimeout(timeout);reject(new Error(data.message));}};worker.postMessage({type:'init'});});
  if(token!==generation)return;mode='recording';$('start').disabled=false;$('start').textContent='Пауза';$('camera-placeholder').hidden=true;$('mode-badge').textContent='ВИДЕОПРИМЕР · ЛОКАЛЬНЫЙ АНАЛИЗ';
  worker.onmessage=({data})=>{if(token!==generation)return;busy=false;if(data.type==='pose')applyPose(data.landmarks,data.now,data.width,data.height);else if(data.type==='error'){pause();message('Ошибка анализа видеопримера');}};
  worker.onerror=()=>{if(token===generation){pause();message('Модуль анализа остановился');}};
  video.onended=()=>{if(token===generation)finish();};await video.play();
  const tick=async()=>{if(token!==generation||mode!=='recording')return;if(!busy&&video.readyState>=2&&video.currentTime!==lastFrame){busy=true;lastFrame=video.currentTime;try{const bitmap=await createImageBitmap(video);if(token!==generation){bitmap.close();return;}worker.postMessage({type:'frame',bitmap,now:video.currentTime*1000,width:video.videoWidth,height:video.videoHeight},[bitmap]);}catch(e){pause();message('Не удалось прочитать кадр видеопримера');return;}}frameTimer=setTimeout(tick,80);};tick();
 }catch(e){if(token!==generation)return;release();mode='paused';message(e.message);}
}
function startExample(){release();engine.reset();exampleSession=true;mode='example';const token=generation;startTime=performance.now();$('example-note').hidden=false;$('example-note').textContent='Учебная анимация скелета: иллюстрация алгоритма, не запись реального человека и не проверка точности.';$('video-credit').hidden=true;$('summary').hidden=true;$('finish').disabled=false;$('camera-placeholder').hidden=true;$('overlay').classList.remove('mirror');$('camera').style.aspectRatio='4/3';$('mode-badge').textContent='УЧЕБНАЯ АНИМАЦИЯ';$('start').textContent='Включить камеру';metric();const tick=()=>{if(token!==generation)return;const t=(performance.now()-startTime)/1000,phase=t%5;let a=170;if(phase>=1&&phase<2)a=170-(phase-1)*90;else if(phase>=2&&phase<3)a=80;else if(phase>=3&&phase<4)a=80+(phase-3)*90;applyPose(examplePose(exercise==='plank'?90:a,exercise==='plank'),performance.now(),480,480);frameTimer=setTimeout(tick,100);};tick();}
function finish(){const wasExample=exampleSession;if(!wasExample)saveSession();const value=exercise==='plank'?`${engine.seconds.toFixed(1)} секунд`:`${engine.count} повторений`;release();mode='idle';$('summary').replaceChildren();const strong=document.createElement('strong');strong.textContent=value;$('summary').append(strong,document.createTextNode(wasExample?'Учебный пример завершён. В историю не сохранён.':'Подход завершён. Результат сохранён на этом устройстве.'));$('summary').hidden=false;$('finish').disabled=true;$('start').textContent='Новый подход';$('mode-badge').textContent='ПОДХОД ЗАВЕРШЁН';message('Можно начать новый подход');engine.reset();}
for(const el of document.querySelectorAll('[data-exercise]'))el.onclick=()=>select(el.dataset.exercise);
$('start').onclick=startCamera;$('video-example').onclick=()=>{$('help-dialog').close();startVideoExample();};$('example').onclick=()=>{$('help-dialog').close();startExample();};$('finish').onclick=finish;
$('back').onclick=()=>{release();mode='idle';$('workout').hidden=true;$('home').hidden=false;document.body.classList.remove('workout-open');renderHistory();};
for(const button of document.querySelectorAll('[data-facing]'))button.onclick=async()=>{
 const next=button.dataset.facing;if(next===facing)return;
 const restart=mode==='live';facing=next;try{localStorage.setItem('motion-camera',facing);}catch{}
 cameraButtons();cameraSelection();
 if(restart){pause();await startCamera();}
 else if(mode==='idle'||mode==='paused')message(`Выбрана ${CAMERA_NAMES[facing].toLowerCase()} камера. Нажмите «Включить камеру».`);
};
$('help-open').onclick=()=>$('help-dialog').showModal();$('help-close').onclick=()=>$('help-dialog').close();
$('about-toggle').onclick=()=>{$('about').hidden=!$('about').hidden;$('about-toggle').setAttribute('aria-expanded',String(!$('about').hidden));};$('clear-history').onclick=()=>{try{localStorage.removeItem('motion-history');}catch{}renderHistory();};
function suspend(){pauseArchive();if(mode==='live'||mode==='recording'||mode==='loading'||mode==='example')pause();}
document.addEventListener('visibilitychange',()=>{if(document.hidden)suspend();});window.addEventListener('pagehide',suspend);window.MotionApp={suspend};cameraButtons();cameraSelection();renderHistory();

$('open-pullups').onclick=()=>{release();mode='idle';$('home').hidden=true;openArchive(()=>{$('home').hidden=false;renderHistory();});window.scrollTo(0,0);};
