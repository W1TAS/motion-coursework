'use strict';
const {items,poses,frameTimes,packetId}=topReviewData,key='pullup-top-proxy-review-01';
const $=id=>document.getElementById(id),video=$('video'),canvas=$('overlay');
const choices=[['sufficient',0,'Да, высота достаточная'],['insufficient',1,'Нет, подбородок ниже'],['uncertain',null,'Не могу уверенно оценить'],['unusable',null,'Непригодный ракурс или скелет']];
let index=0,answers={},ready=false,zoom=true,showLine=true,showComparison=false,epoch=0,abort=null,objectURL=null,windowPlayback=true,storageError=false;
try{const s=JSON.parse(localStorage.getItem(key)||'{}');answers=s.answers||{};index=Math.max(0,Math.min(items.length-1,s.index||0));}catch{}
function persist(){try{localStorage.setItem(key,JSON.stringify({index,answers}));storageError=false;}catch{storageError=true;}}
function render(){
 const a=answers[items[index].id];$('count').textContent=`${index+1} / ${items.length}`;
 $('progress').textContent=`Отмечено ${items.filter(i=>answers[i.id]?.complete).length} / ${items.length}`;
 $('answer-summary').textContent=a?.complete?'Текущий ответ: '+(choices.find(c=>c[0]===a.review_status)?.[2]??'сохранён'):'Текущий клип ещё не отмечен';
 for(let n=0;n<choices.length;n++){$('choice-'+n).disabled=!ready;$('choice-'+n).setAttribute('aria-pressed',String(a?.review_status===choices[n][0]));}
 $('prev').disabled=index===0;$('next').disabled=index===items.length-1;
 $('status').textContent=storageError?'Не удалось сохранить в браузере — скачай JSON.':items.every(i=>answers[i.id]?.complete)?'Перепроверка завершена. Сохрани JSON.':'Ответ 1–4 сохраняется отдельно от прежней разметки.';
 $('comparison').hidden=!showComparison;
 $('compare').textContent=showComparison?'R · Скрыть сравнение':'R · Показать сравнение';
 if(showComparison){
  const item=items[index],m=item.measurement,words={above:'выше линии',below:'ниже линии',near:'возле линии'};
  const top=m.top?.mouth?.state,peak=m.peak?.mouth?.state;
  $('comparison').textContent=`Прежняя оценка: ${item.priorTop===0?'высоты достаточно':'недостаточная высота'}.\nРот у предложенного верха: ${words[top]??'измерение недоступно'}.\nРот в наивысшей устойчивой позиции: ${words[peak]??'измерение недоступно'}.\nЭто точки рта и линия запястий, а не измерение подбородка и самой перекладины.`;
 }
}
for(const [n,[,,name]]of choices.entries()){
 const b=document.createElement('button');b.id='choice-'+n;b.setAttribute('aria-label',`${n+1} · ${name}`);
 const k=document.createElement('span');k.className='number';k.textContent=n+1;
 const t=document.createElement('span');t.className='choice-text';t.textContent=name;b.append(k,t);b.onclick=()=>choose(n);$('choices').append(b);
}
function choose(n){
 if(!ready||!choices[n])return;video.pause();const [status,label]=choices[n];
 answers[items[index].id]={review_status:status,top_below_bar:label,complete:true,answeredAt:new Date().toISOString()};
 if(index<items.length-1){index++;persist();show();}else{persist();render();}
}
function frameTime(t){const ts=frameTimes[items[index].id]||[];if(!ts.length)return t;let n=0;for(let i=1;i<ts.length;i++)if(Math.abs(ts[i]-t)<Math.abs(ts[n]-t))n=i;return (ts[n]+Math.min(items[index].duration,ts[n+1]??items[index].duration))/2;}
function seekPaused(t){
 if(!ready||!Number.isFinite(t))return;video.pause();const i=items[index];
 if(t<frameTime(i.windowStart)-1e-6||t>frameTime(i.windowEnd)+1e-6)windowPlayback=false;
 video.currentTime=Math.max(0,Math.min(video.duration,t));
}
function stepFrame(delta){
 if(!ready)return;const ts=frameTimes[items[index].id]||[];if(!ts.length)return;
 let n=0;for(let i=1;i<ts.length&&ts[i]<=video.currentTime+1e-6;i++)n=i;
 const target=Math.max(0,Math.min(ts.length-1,n+delta));seekPaused((ts[target]+Math.min(video.duration,ts[target+1]??video.duration))/2);
}
function mediaState(value,message=''){
 ready=value;$('media-status').textContent=message;
 for(const id of ['play','back-frame','forward-frame','top','peak','speed','seek'])$(id).disabled=!value;
 $('peak').disabled=!value||!items[index].measurement.peak;render();
}
async function loadVideo(item){
 const current=++epoch;abort?.abort();abort=new AbortController();video.pause();canvas.style.visibility='hidden';video.removeAttribute('src');video.load();
 if(objectURL){URL.revokeObjectURL(objectURL);objectURL=null;}mediaState(false,'Загружаю видео…');
 try{
  let source=item.file;
  if(location.protocol!=='file:'){
   const r=await fetch(item.file,{signal:abort.signal});if(!r.ok)throw Error('Missing video');
   const blob=await r.blob();if(current!==epoch)return;objectURL=URL.createObjectURL(new Blob([blob],{type:'video/mp4'}));source=objectURL;
  }
  if(current!==epoch)return;
  video.onloadeddata=()=>{
   if(current!==epoch)return;
   const reveal=()=>{if(current!==epoch)return;video.pause();canvas.style.visibility='visible';mediaState(true);draw();};
   const t=frameTime(item.windowEnd);
   if(Math.abs(video.currentTime-t)<1e-6)reveal();else{video.addEventListener('seeked',reveal,{once:true});video.currentTime=t;}
  };
  video.onerror=()=>{if(current===epoch)mediaState(false,'Видео не загрузилось. Вернись к клипу повторно.');};video.src=source;video.load();
 }catch(e){if(current===epoch&&e.name!=='AbortError')mediaState(false,'Видео не загрузилось. Вернись к клипу повторно.');}
}
function draw(){
 const item=items[index],t=video.currentTime||0,w=video.videoWidth||640,h=video.videoHeight||360,ref=item.measurement.reference;
 let crop={x:0,y:0,w,h};
 if(zoom&&ref){
  const sx=w/ref.width,sy=h/ref.height,torso=ref.torsoPixels*sy;
  const left=Math.max(0,Math.min(ref.left.x,ref.right.x)*sx-.2*torso),right=Math.min(w,Math.max(ref.left.x,ref.right.x)*sx+.2*torso);
  const mid=(ref.left.y+ref.right.y)/2*sy,top=Math.max(0,mid-.75*torso),bottom=Math.min(h,mid+torso);
  crop={x:left,y:top,w:right-left,h:bottom-top};
 }
 canvas.width=Math.max(1,Math.round(crop.w));canvas.height=Math.max(1,Math.round(crop.h));
 const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);
 if(video.readyState>=2&&video.videoWidth)ctx.drawImage(video,crop.x,crop.y,crop.w,crop.h,0,0,canvas.width,canvas.height);
 const map=(x,y)=>({x:(x-crop.x)*canvas.width/crop.w,y:(y-crop.y)*canvas.height/crop.h});
 if(showLine){
  if(ref){
   const a=map(ref.left.x*w/ref.width,ref.left.y*h/ref.height),b=map(ref.right.x*w/ref.width,ref.right.y*h/ref.height);
   ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle='#68dfd633';ctx.lineWidth=2*ref.tolerancePixels*h/ref.height*canvas.height/crop.h;ctx.stroke();
   ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle='#68dfd6';ctx.lineWidth=1.5;
   ctx.setLineDash(item.measurement.state==='unavailable'?[5,4]:[]);ctx.stroke();ctx.setLineDash([]);
  }
  let near=null;for(const f of poses[item.id]||[])if(!near||Math.abs(f.t-t)<Math.abs(near.t-t))near=f;
  if(near?.p&&Math.abs(near.t-t)<.075){
   const p=near.p,good=i=>p[i]&&p[i][2]>=.45;
   const point=(x,y,color)=>{const a=map(x*w,y*h);ctx.beginPath();ctx.arc(a.x,a.y,2,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();};
   if(good(0))point(p[0][0],p[0][1],'#fa826a');
   if(good(9)&&good(10))point((p[9][0]+p[10][0])/2,(p[9][1]+p[10][1])/2,'#f2df65');
  }
 }
 $('time').textContent=`${t.toFixed(2)} с`;$('seek').value=Number.isFinite(video.duration)&&video.duration>0?Math.round(t/video.duration*10000):0;
}
function show(){zoom=true;showLine=true;showComparison=false;windowPlayback=true;video.playbackRate=1;$('speed').textContent='×1';$('zoom').textContent='Z · Крупно';$('line').textContent='L · Линия вкл.';persist();render();loadVideo(items[index]);}
function navigate(d){if(index+d<0||index+d>=items.length)return;index+=d;persist();show();}
function save(){
 persist();const packet={schema:'top-proxy-adjudication-v1',packetId,items,answers,exportedAt:new Date().toISOString(),
  note:'Separate human review of top height. Old labels unchanged. Unknown/unusable are not negatives; proxy crossing is not chin height.'};
 const u=URL.createObjectURL(new Blob([JSON.stringify(packet,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='pullup-top-proxy-review-answers.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);
}
$('prev').onclick=()=>navigate(-1);$('next').onclick=()=>navigate(1);$('save').onclick=save;
$('play').onclick=()=>{if(!ready)return;if(video.paused){if(windowPlayback&&video.currentTime>=frameTime(items[index].windowEnd)-1e-6)video.currentTime=frameTime(items[index].windowStart);video.play().catch(()=>{});}else video.pause();};
$('back-frame').onclick=()=>stepFrame(-1);$('forward-frame').onclick=()=>stepFrame(1);
$('top').onclick=()=>seekPaused(frameTime(items[index].windowEnd));
$('peak').onclick=()=>{const p=items[index].measurement.peak;if(p)seekPaused(frameTime(p.timeMs/1000-items[index].sourceStart));};
$('zoom').onclick=()=>{zoom=!zoom;$('zoom').textContent=zoom?'Z · Крупно':'Z · Весь кадр';draw();};
$('line').onclick=()=>{showLine=!showLine;$('line').textContent='L · Линия '+(showLine?'вкл.':'выкл.');draw();};
$('speed').onclick=()=>{video.playbackRate=video.playbackRate===1?.5:1;$('speed').textContent='×'+video.playbackRate;};
$('compare').onclick=()=>{showComparison=!showComparison;render();};
function updateFrame(){const end=frameTime(items[index].windowEnd);if(ready&&windowPlayback&&!video.paused&&!video.seeking&&video.currentTime>=end-1e-6){video.pause();if(Math.abs(video.currentTime-end)>1e-6)video.currentTime=end;}draw();}
video.ontimeupdate=updateFrame;video.onseeked=updateFrame;$('seek').oninput=()=>seekPaused(Number($('seek').value)/10000*video.duration);
if(video.requestVideoFrameCallback){const tick=()=>{updateFrame();video.requestVideoFrameCallback(tick);};video.requestVideoFrameCallback(tick);}
document.addEventListener('keydown',e=>{
 if((e.ctrlKey||e.metaKey)&&e.code==='KeyS'){e.preventDefault();save();return;}if(e.ctrlKey||e.metaKey||e.altKey)return;
 let a;if(/^(Digit|Numpad)[1-4]$/.test(e.code))a=()=>choose(Number(e.code.slice(-1))-1);
 else a=({Space:()=>$('play').click(),ArrowLeft:()=>stepFrame(-1),ArrowRight:()=>stepFrame(1),KeyT:()=>$('top').click(),KeyH:()=>$('peak').click(),KeyZ:()=>$('zoom').click(),KeyL:()=>$('line').click(),KeyR:()=>$('compare').click(),KeyP:()=>navigate(-1),Backspace:()=>navigate(-1),KeyN:()=>navigate(1)})[e.code];
 if(a){e.preventDefault();if(!e.repeat||['ArrowLeft','ArrowRight'].includes(e.code))a();}
});
show();
