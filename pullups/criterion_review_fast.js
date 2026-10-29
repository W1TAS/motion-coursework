'use strict';
const {items,poses,frameTimes,suggestions={}}=reviewData;
const key='pullup-criterion-review-v2-batch-04',batch='criteria-04';
const $=id=>document.getElementById(id),video=$('video'),canvas=$('overlay');
const questions=[
 ['facing','Ракурс',[['front','Спереди'],['front_oblique','Небольшой угол'],['side','Сбоку'],['back','Со спины → пропуск'],['unknown','Не определить']]],
 ['attempt','Движение',[['attempt','Подтягивание'],['exaggerated_error_demo','Утрированная ошибка'],['not_pullup','Другое движение'],['unknown','Не определить']]],
 ['bottom_incomplete','Внизу локти остались согнуты?',[['0','Нет, руки разогнуты'],['1','Да, заметно согнуты'],['unknown','Не определить']]],
 ['top_below_bar','Подбородок НЕ достиг перекладины?',[['0','Нет, выше перекладины'],['1','Да, ниже / на уровне'],['unknown','Не определить']]],
 ['swing_ascent','На подъёме есть раскачка / рывок ног?',[['0','Нет'],['1','Да'],['unknown','Не определить']]],
 ['pose_quality','Качество скелета',[['usable','Суставы на месте'],['unstable','Заметные скачки / ошибки'],['missing','Точки часто отсутствуют'],['not_reviewed','Не проверял']]]
];
const phaseKeys=['bottom','top'];
let answers={},index=0,active=0,phaseTimes={},phaseSources={},reviewStatus=null;
let ready=false,epoch=0,abort=null,objectURL=null,showPose=true;
try{const saved=JSON.parse(localStorage.getItem(key)||'{}');answers=saved.answers||{};index=Math.max(0,Math.min(items.length-1,saved.index||0));}catch{}
function hint(id){const v=suggestions[items[index].id]?.times?.[id];return Number.isFinite(v)&&v>=0&&v<items[index].duration?v:null;}
function frameTime(time){
 const times=frameTimes[items[index].id]||[];if(!times.length)return time;
 let nearest=0;for(let i=1;i<times.length;i++)if(Math.abs(times[i]-time)<Math.abs(times[nearest]-time))nearest=i;
 return (times[nearest]+Math.min(items[index].duration,times[nearest+1]??items[index].duration))/2;
}
function seekPaused(time){if(!ready||!Number.isFinite(time))return;video.pause();video.currentTime=Math.max(0,Math.min(video.duration,time));}
function validate(a){
 const q=questions.findIndex(([id])=>!a[id]);if(q>=0)return {message:'Ответь: '+questions[q][1],question:q};
 if(phaseKeys.some(k=>!(k in phaseTimes)))return {message:'Отметь низ (B) и верх (T), либо «Не видно».'};
 const t=phaseKeys.map(k=>phaseTimes[k]).filter(v=>v!==null);
 if(t.some(v=>!Number.isFinite(v)||v<0||v>items[index].duration)||t.some((v,i)=>i&&t[i-1]>=v))return {message:'Проверь порядок: низ должен быть раньше верха.'};
 return null;
}
function record(){
 const a={...Object.fromEntries(questions.map(([id])=>[id,$(id).value])),
  phase_times:{return:null,...phaseTimes},phase_sources:{return:{kind:'not_required'},...phaseSources},
  review_status:reviewStatus,note:$('note').value};
 const skipped=['skipped_back','skipped_unusable'].includes(reviewStatus);if(reviewStatus==='skipped_back')a.facing='back';
 const error=skipped?null:validate(a);a.complete=!skipped&&!error;answers[items[index].id]=a;
 try{localStorage.setItem(key,JSON.stringify({answers,index}));}catch{$('media-status').textContent='Браузер не сохранил ответы. Скачай JSON перед закрытием.';}
 const rows=items.map(i=>answers[i.id]).filter(Boolean),complete=rows.filter(a=>a.complete).length,skips=rows.filter(a=>['skipped_back','skipped_unusable'].includes(a.review_status)).length;
 $('progress').textContent=`Просмотрено ${complete+skips} / ${items.length} · размечено ${complete} · пропущено ${skips}`;
 $('status').textContent=skipped?'Клип пропущен и исключён из оценки техники.':error?.message||'Готово. N — следующий клип.';
 $('status').className=error?'bad':'';$('resume-review').hidden=!skipped;return a;
}
function selectQuestion(n){
 active=Math.max(0,Math.min(questions.length-1,n));
 for(let i=0;i<questions.length;i++)$('question-'+i).classList.toggle('active',i===active);
 const [,title,options]=questions[active];$('active-title').textContent=`${active+1} / ${questions.length} · ${title}`;
 $('answer-options').replaceChildren();options.forEach(([,text],i)=>{const b=document.createElement('button');b.textContent=`${i+1} · ${text}`;b.onclick=()=>choose(i);$('answer-options').append(b);});
}
function choose(n){
 const [id,,options]=questions[active];if(!options[n])return;
 $(id).value=options[n][0];reviewStatus=null;record();
 if(id==='facing'&&options[n][0]==='back'){skip('skipped_back');return;}
 selectQuestion(Math.min(active+1,questions.length-1));
}
for(const [n,[id,title,options]]of questions.entries()){
 const label=document.createElement('label');label.className='question';label.id='question-'+n;
 const text=document.createElement('span');text.textContent=title;label.append(text);
 const select=document.createElement('select');select.id=id;select.setAttribute('aria-label',title);select.add(new Option('Выбери ответ',''));
 options.forEach(([v,t],i)=>select.add(new Option(`${i+1} · ${t}`,v)));
 select.onfocus=()=>selectQuestion(n);select.onchange=()=>{reviewStatus=null;record();if(id==='facing'&&select.value==='back')skip('skipped_back');else selectQuestion(n);};label.append(select);$('fields').append(label);
}
function renderPhases(){
 for(const [id,title]of [['bottom','Низ'],['top','Верх']]){
  $('phase-'+id).textContent=title+': '+(!(id in phaseTimes)?'не отмечен':phaseTimes[id]===null?'не видно':phaseTimes[id].toFixed(2)+' с');
  const proposed=hint(id);$('hint-'+id).textContent=proposed===null?'Без подсказки':'Подсказка '+frameTime(proposed).toFixed(2)+' с';
  $('preview-'+id).disabled=!ready||!(Number.isFinite(phaseTimes[id])||proposed!==null);
  $('accept-'+id).disabled=!ready||proposed===null;
  $('set-'+id).disabled=!ready;$('unknown-'+id).disabled=!ready;
 }
 $('confirm-phases').disabled=!ready||phaseKeys.some(k=>hint(k)===null)||phaseKeys.every(k=>k in phaseTimes);
 $('auto-phase-status').textContent='Проверь предложенные кадры перед подтверждением. Твои отметки не перезаписываются.';
}
function setPhase(id){if(!ready)return;video.pause();phaseTimes[id]=Math.round(video.currentTime*1000)/1000;phaseSources[id]={kind:'manual'};reviewStatus=null;record();renderPhases();}
function unknownPhase(id){if(!ready)return;phaseTimes[id]=null;phaseSources[id]={kind:'not_visible'};reviewStatus=null;record();renderPhases();}
function jumpPhase(id){const t=Number.isFinite(phaseTimes[id])?phaseTimes[id]:hint(id);if(t!==null)seekPaused(frameTime(t));}
function acceptPhase(id){const value=hint(id);if(!ready||value===null)return;phaseTimes[id]=frameTime(value);phaseSources[id]={kind:'auto_confirmed',method:suggestions[items[index].id].method,suggested_time:value};reviewStatus=null;}
for(const [id,title,keycap]of [['bottom','Низ','B'],['top','Верх','T']]){
 const row=document.createElement('div');row.className='phase';const label=document.createElement('strong');label.id='phase-'+id;row.append(label);
 for(const [prefix,text,action]of [['preview','Перейти',()=>jumpPhase(id)],['set',keycap+' · Отметить',()=>setPhase(id)],['accept','✓',()=>{acceptPhase(id);record();renderPhases();}],['unknown','Не видно',()=>unknownPhase(id)]]){
  const b=document.createElement('button');b.id=prefix+'-'+id;b.textContent=text;b.setAttribute('aria-label',title+': '+text);b.onclick=action;row.append(b);
 }
 const small=document.createElement('small');small.id='hint-'+id;row.append(small);$('phases').append(row);
}
$('confirm-phases').onclick=()=>{if($('confirm-phases').disabled)return;video.pause();for(const id of phaseKeys)if(!(id in phaseTimes))acceptPhase(id);record();renderPhases();};
function mediaState(value,message=''){
 ready=value;$('media-status').textContent=message;
 for(const id of ['play','back-frame','forward-frame','replay','speed','seek'])$(id).disabled=!value;
 renderPhases();
}
async function loadVideo(item){
 const current=++epoch;abort?.abort();abort=new AbortController();video.pause();video.removeAttribute('src');video.load();
 if(objectURL){URL.revokeObjectURL(objectURL);objectURL=null;}mediaState(false,'Загрузка видео…');
 try{
  let source=item.file;
  if(location.protocol!=='file:'){
   const response=await fetch(item.file,{signal:abort.signal});if(!response.ok)throw Error('Video unavailable');
   const blob=await response.blob();if(current!==epoch)return;
   objectURL=URL.createObjectURL(new Blob([blob],{type:'video/mp4'}));source=objectURL;
  }
  if(current!==epoch)return;
  video.onloadeddata=()=>{if(current!==epoch)return;mediaState(true);seekPaused(frameTime(item.windowStart));draw();};
  video.onerror=()=>{if(current===epoch)mediaState(false,'Не удалось загрузить видео. Вернись к клипу повторно.');};
  video.src=source;video.load();
 }catch(error){if(current===epoch&&error.name!=='AbortError')mediaState(false,'Видео не загрузилось. Вернись к клипу повторно.');}
}
const bones=[[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
function draw(){
 const item=items[index],t=video.currentTime||0;$('time').textContent=t.toFixed(2)+' с';$('time').className=t>=item.windowStart&&t<=item.windowEnd?'inside':'';
 $('seek').value=Number.isFinite(video.duration)&&video.duration>0?Math.round(t/video.duration*10000):0;
 canvas.width=video.videoWidth||640;canvas.height=video.videoHeight||640;const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);
 if(!showPose)return;
 let nearest=null;for(const f of poses[item.id]||[])if(!nearest||Math.abs(f.t-t)<Math.abs(nearest.t-t))nearest=f;
 if(!nearest||Math.abs(nearest.t-t)>.075||!nearest.p)return;
 const good=p=>p&&p[2]>=.45&&p.every(Number.isFinite);ctx.strokeStyle='#f2df65';ctx.fillStyle='#f2df65';ctx.lineWidth=Math.max(2,canvas.width/220);
 for(const [a,b]of bones){const x=nearest.p[a],y=nearest.p[b];if(!good(x)||!good(y))continue;ctx.beginPath();ctx.moveTo(x[0]*canvas.width,x[1]*canvas.height);ctx.lineTo(y[0]*canvas.width,y[1]*canvas.height);ctx.stroke();}
 for(const p of nearest.p){if(!good(p))continue;ctx.beginPath();ctx.arc(p[0]*canvas.width,p[1]*canvas.height,Math.max(2,canvas.width/180),0,Math.PI*2);ctx.fill();}
}
function show(){
 const item=items[index],a=answers[item.id]||{};phaseTimes={...(a.phase_times||{})};delete phaseTimes.return;
 phaseSources={...(a.phase_sources||{})};delete phaseSources.return;reviewStatus=a.review_status||null;
 for(const [id]of questions)$(id).value=a[id]||'';$('note').value=a.note||'';
 showPose=true;canvas.hidden=false;$('toggle-pose').textContent='Скелет: вкл.';video.playbackRate=1;$('speed').textContent='×1';
 $('count').textContent=`${index+1} / ${items.length}`;$('prev').disabled=index===0;
 $('next').textContent=index===items.length-1?'Готово · сохранить':'N · Дальше';
 selectQuestion(0);record();renderPhases();loadVideo(item);draw();
}
function navigate(delta){
 const a=record();if(delta>0&&!a.complete&&!a.review_status){const error=validate(a);if(error?.question!==undefined)selectQuestion(error.question);return;}
 if(index+delta<0)return;if(index+delta>=items.length){save();return;}
 index+=delta;show();
}
function skip(status){video.pause();reviewStatus=status;if(status==='skipped_back')$('facing').value='back';record();if(index<items.length-1){index++;show();}}
function stepFrame(step){
 if(!ready)return;video.pause();const times=frameTimes[items[index].id];if(!times?.length)return;
 let at=0;for(let i=1;i<times.length&&times[i]<=video.currentTime+1e-6;i++)at=i;
 const target=Math.max(0,Math.min(times.length-1,at+step));seekPaused((times[target]+Math.min(video.duration,times[target+1]??video.duration))/2);
}
function save(){
 record();const packet={schema:2,batch,scope:'Targeted legacy-positive criterion clarification; human view labels, ascent phases, development only',items,answers,exportedAt:new Date().toISOString()};
 const url=URL.createObjectURL(new Blob([JSON.stringify(packet,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='pullup-criteria-04-answers.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('prev').onclick=()=>navigate(-1);$('next').onclick=()=>navigate(1);$('save').onclick=save;
$('skip-back').onclick=()=>skip('skipped_back');$('skip-unusable').onclick=()=>skip('skipped_unusable');$('resume-review').onclick=()=>{reviewStatus=null;record();};
$('back-frame').onclick=()=>stepFrame(-1);$('forward-frame').onclick=()=>stepFrame(1);
$('play').onclick=()=>{if(!ready)return;if(video.paused)video.play().catch(()=>mediaState(true,'Нажми воспроизведение ещё раз.'));else video.pause();};
$('replay').onclick=()=>seekPaused(frameTime(items[index].windowStart));$('speed').onclick=()=>{video.playbackRate=video.playbackRate===1?.5:1;$('speed').textContent='×'+video.playbackRate;};
$('toggle-pose').onclick=()=>{showPose=!showPose;canvas.hidden=!showPose;$('toggle-pose').textContent='Скелет: '+(showPose?'вкл.':'выкл.');draw();};
$('seek').oninput=()=>seekPaused(Number($('seek').value)/10000*video.duration);$('note').oninput=record;
video.ontimeupdate=draw;video.onseeked=draw;
if(video.requestVideoFrameCallback){const tick=()=>{draw();video.requestVideoFrameCallback(tick);};video.requestVideoFrameCallback(tick);}
document.addEventListener('keydown',e=>{
 if((e.ctrlKey||e.metaKey)&&e.code==='KeyS'){e.preventDefault();save();return;}
 if(['TEXTAREA','INPUT'].includes(e.target?.tagName)&&e.target?.type!=='range'){if(e.code==='Escape')e.target.blur();return;}
 if(e.ctrlKey||e.metaKey)return;
 let action;
 if(/^(Digit|Numpad)[1-5]$/.test(e.code))action=()=>choose(Number(e.code.slice(-1))-1);
 else if(e.code==='ArrowUp')action=()=>selectQuestion(active-1);
 else if(e.code==='ArrowDown')action=()=>selectQuestion(active+1);
 else if(e.code==='ArrowLeft')action=()=>stepFrame(-1);
 else if(e.code==='ArrowRight')action=()=>stepFrame(1);
 else if(e.code==='Space')action=()=>$('play').click();
 else if(['KeyB','KeyT'].includes(e.code)){const id=e.code==='KeyB'?'bottom':'top';action=()=>e.altKey?unknownPhase(id):e.shiftKey?jumpPhase(id):setPhase(id);}
 else action=({KeyC:()=>$('confirm-phases').click(),KeyN:()=>navigate(1),KeyP:()=>navigate(-1),KeyX:()=>skip('skipped_back'),KeyK:()=>skip('skipped_unusable'),KeyV:()=>$('toggle-pose').click(),Home:()=>$('replay').click()})[e.code];
 if(action){e.preventDefault();if(!e.repeat||['ArrowLeft','ArrowRight'].includes(e.code))action();}
});
show();
