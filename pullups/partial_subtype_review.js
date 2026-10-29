'use strict';
const {items,poses,frameTimes}=subtypeData,key='pullup-partial-subtype-v1',batch='partial-subtype-01';
const $=id=>document.getElementById(id),video=$('video'),canvas=$('overlay');
const choices=[['bottom_only','Только внизу','Локти согнуты перед подъёмом'],['top_only','Только вверху','Подбородок не достиг перекладины'],['both','И внизу, и вверху','Обе ошибки'],['neither','Ошибки амплитуды нет','Низ и верх выполнены'],['unknown','Не могу определить','Плохой ракурс, не видно или непригодное видео']];
let index=0,answers={},ready=false,showPose=true,epoch=0,abort=null,objectURL=null,storageError=false,windowPlayback=true;
try{const saved=JSON.parse(localStorage.getItem(key)||'{}');answers=saved.answers||{};index=Math.max(0,Math.min(items.length-1,saved.index||0));}catch{}
function persist(){try{localStorage.setItem(key,JSON.stringify({index,answers}));storageError=false;}catch{storageError=true;}}
function render(){
 const answered=items.filter(i=>choices.some(([c])=>answers[i.id]?.subtype===c)).length;
 $('count').textContent=`${index+1} / ${items.length}`;$('progress').textContent=`Отмечено ${answered} / ${items.length}`;
 const a=answers[items[index].id],choice=choices.find(([c])=>c===a?.subtype);
 $('answer-summary').textContent=choice?'Текущий ответ: '+choice[1]:'Текущий клип ещё не отмечен';
 for(let i=0;i<choices.length;i++){$('choice-'+i).disabled=!ready;$('choice-'+i).setAttribute('aria-pressed',String(a?.subtype===choices[i][0]));}
 $('prev').disabled=index===0;$('next').disabled=index===items.length-1;
 $('status').textContent=storageError?'Не удалось сохранить в браузере. Скачай JSON.':answered===items.length?'Все клипы отмечены. Сохрани JSON; ответы можно исправить кнопкой P.':'Нажми 1–5 после просмотра. Ответ можно изменить, вернувшись назад.';
}
function choose(n){
 if(!ready||!choices[n])return;video.pause();answers[items[index].id]={subtype:choices[n][0],complete:true,answeredAt:new Date().toISOString()};
 if(index<items.length-1){index++;persist();show();}else{persist();render();}
}
for(const [i,[,title,description]]of choices.entries()){
 const b=document.createElement('button');b.id='choice-'+i;b.setAttribute('aria-label',`${i+1} · ${title}`);
 const k=document.createElement('span');k.className='number';k.textContent=i+1;
 const text=document.createElement('span');text.className='choice-text';const name=document.createElement('span');name.textContent=title;const small=document.createElement('small');small.textContent=description;
 text.append(name,small);b.append(k,text);b.onclick=()=>choose(i);$('choices').append(b);
}
function frameTime(t){const times=frameTimes[items[index].id]||[];if(!times.length)return t;let n=0;for(let i=1;i<times.length;i++)if(Math.abs(times[i]-t)<Math.abs(times[n]-t))n=i;return (times[n]+Math.min(items[index].duration,times[n+1]??items[index].duration))/2;}
function windowBounds(){return {start:frameTime(items[index].windowStart),end:frameTime(items[index].windowEnd)};}
function seekPaused(t){
 if(!ready||!Number.isFinite(t))return;video.pause();const bounds=windowBounds();
 // Deliberate seeking outside the suggested ascent opens its context.
 if(t<bounds.start-1e-6||t>bounds.end+1e-6)windowPlayback=false;
 video.currentTime=Math.max(0,Math.min(video.duration,t));
}
function stepFrame(delta){
 if(!ready)return;const times=frameTimes[items[index].id];if(!times?.length)return;let n=0;for(let i=1;i<times.length&&times[i]<=video.currentTime+1e-6;i++)n=i;
 const target=Math.max(0,Math.min(times.length-1,n+delta));seekPaused((times[target]+Math.min(video.duration,times[target+1]??video.duration))/2);
}
function mediaState(value,message=''){ready=value;$('media-status').textContent=message;for(const id of ['play','back-frame','forward-frame','bottom','top','replay','speed','seek'])$(id).disabled=!value;render();}
async function loadVideo(item){
 const current=++epoch;abort?.abort();abort=new AbortController();video.pause();video.style.visibility='hidden';canvas.style.visibility='hidden';video.removeAttribute('src');video.load();if(objectURL){URL.revokeObjectURL(objectURL);objectURL=null;}mediaState(false,'Загружаю видео…');
 try{
  let source=item.file;
  if(location.protocol!=='file:'){
   const response=await fetch(item.file,{signal:abort.signal});if(!response.ok)throw Error('Missing video');
   const blob=await response.blob();if(current!==epoch)return;objectURL=URL.createObjectURL(new Blob([blob],{type:'video/mp4'}));source=objectURL;
  }
  if(current!==epoch)return;
  video.onloadeddata=()=>{
   if(current!==epoch)return;
   const begin=windowBounds().start;
   const beginPlayback=()=>{if(current!==epoch)return;windowPlayback=true;video.style.visibility='visible';canvas.style.visibility='visible';mediaState(true);draw();video.play().catch(()=>{$('media-status').textContent='Пробел — начать просмотр.';});};
   // Wait for the target frame to decode: otherwise the leading context may
   // flash or start playing before an asynchronous seek has completed.
   if(Math.abs(video.currentTime-begin)<1e-6)beginPlayback();
   else{video.addEventListener('seeked',beginPlayback,{once:true});video.currentTime=begin;}
  };
  video.onerror=()=>{if(current===epoch)mediaState(false,'Видео не загрузилось. Вернись к клипу повторно.');};video.src=source;video.load();
 }catch(error){if(current===epoch&&error.name!=='AbortError')mediaState(false,'Не удалось загрузить видео. Вернись к клипу повторно.');}
}
const bones=[[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
function draw(){
 const item=items[index],t=video.currentTime||0;$('time').textContent=`${t.toFixed(2)} с · подъём ${item.windowStart.toFixed(2)}–${item.windowEnd.toFixed(2)}`;const bounds=windowBounds();$('time').className=t>=bounds.start-1e-6&&t<=bounds.end+1e-6?'inside':'';
 $('seek').value=Number.isFinite(video.duration)&&video.duration>0?Math.round(t/video.duration*10000):0;
 canvas.width=video.videoWidth||640;canvas.height=video.videoHeight||640;const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);
 // Paint the decoded frame and the skeleton on one surface. Some WebViews
 // lose the separate video layer after seeking, pausing or resizing.
 if(video.readyState>=2&&video.videoWidth&&video.videoHeight)ctx.drawImage(video,0,0,canvas.width,canvas.height);
 if(!showPose)return;
 let near=null;for(const f of poses[item.id]||[])if(!near||Math.abs(f.t-t)<Math.abs(near.t-t))near=f;
 if(!near||!near.p||Math.abs(near.t-t)>.075)return;
 const good=p=>p&&p[2]>=.45&&p.every(Number.isFinite);ctx.strokeStyle=ctx.fillStyle='#f2df65';ctx.lineWidth=Math.max(2,canvas.width/220);
 for(const[a,b]of bones){const x=near.p[a],y=near.p[b];if(!good(x)||!good(y))continue;ctx.beginPath();ctx.moveTo(x[0]*canvas.width,x[1]*canvas.height);ctx.lineTo(y[0]*canvas.width,y[1]*canvas.height);ctx.stroke();}
 for(const p of near.p){if(!good(p))continue;ctx.beginPath();ctx.arc(p[0]*canvas.width,p[1]*canvas.height,Math.max(2,canvas.width/180),0,Math.PI*2);ctx.fill();}
}
function show(){windowPlayback=true;showPose=true;canvas.hidden=false;$('pose').textContent='Скелет: вкл.';video.playbackRate=1;$('speed').textContent='×1';persist();render();loadVideo(items[index]);draw();}
function navigate(delta){const next=index+delta;if(next<0||next>=items.length)return;index=next;persist();show();}
function save(){
 persist();const packet={schema:3,batch,scope:'Human partial subtype only; automatic phase proposals, no human phase/view annotations; development only',items,answers,exportedAt:new Date().toISOString()};
 const u=URL.createObjectURL(new Blob([JSON.stringify(packet,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='pullup-partial-subtypes-answers.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);
}
$('prev').onclick=()=>navigate(-1);$('next').onclick=()=>navigate(1);$('save').onclick=save;
$('play').onclick=()=>{
 if(!ready)return;
 if(video.paused){if(windowPlayback&&video.currentTime>=windowBounds().end-1e-6)video.currentTime=windowBounds().start;video.play().catch(()=>{});}else video.pause();
};
$('back-frame').onclick=()=>stepFrame(-1);$('forward-frame').onclick=()=>stepFrame(1);
$('bottom').onclick=()=>seekPaused(frameTime(items[index].windowStart));$('top').onclick=()=>seekPaused(frameTime(items[index].windowEnd));
$('replay').onclick=()=>{windowPlayback=true;seekPaused(windowBounds().start);};
$('speed').onclick=()=>{video.playbackRate=video.playbackRate===1?.5:1;$('speed').textContent='×'+video.playbackRate;};
$('pose').onclick=()=>{showPose=!showPose;$('pose').textContent='Скелет: '+(showPose?'вкл.':'выкл.');draw();};
function updateFrame(){
 const end=windowBounds().end;
 if(ready&&windowPlayback&&!video.paused&&!video.seeking&&video.currentTime>=end-1e-6){video.pause();if(Math.abs(video.currentTime-end)>1e-6)video.currentTime=end;}
 draw();
}
$('seek').oninput=()=>seekPaused(Number($('seek').value)/10000*video.duration);video.ontimeupdate=updateFrame;video.onseeked=updateFrame;
if(video.requestVideoFrameCallback){const tick=()=>{updateFrame();video.requestVideoFrameCallback(tick);};video.requestVideoFrameCallback(tick);}
document.addEventListener('keydown',e=>{
 if((e.ctrlKey||e.metaKey)&&e.code==='KeyS'){e.preventDefault();save();return;}if(e.ctrlKey||e.metaKey||e.altKey)return;
 let action;
 if(/^(Digit|Numpad)[1-5]$/.test(e.code))action=()=>choose(Number(e.code.slice(-1))-1);
 else action=({Space:()=>$('play').click(),ArrowLeft:()=>stepFrame(-1),ArrowRight:()=>stepFrame(1),KeyB:()=>$('bottom').click(),KeyT:()=>$('top').click(),KeyP:()=>navigate(-1),Backspace:()=>navigate(-1),KeyN:()=>navigate(1),KeyV:()=>$('pose').click(),Home:()=>$('replay').click()})[e.code];
 if(action){e.preventDefault();if(!e.repeat||['ArrowLeft','ArrowRight'].includes(e.code))action();}
});
show();
