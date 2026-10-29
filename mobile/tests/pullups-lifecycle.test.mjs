import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';

function harness(open){
 const elements=new Map();
 class Element{
  constructor(){this.dataset={};this.style={};this.checked=true;this.value='example-1';this.currentTime=0;this.duration=10;
   this.videoWidth=640;this.videoHeight=480;this.classList={add(){},remove(){},toggle(){}};}
  setAttribute(){} removeAttribute(){} addEventListener(){} replaceChildren(){} append(){} querySelector(){return null;}
  getContext(){return {clearRect(){}};} pause(){} load(){} play(){return Promise.resolve();}
  requestVideoFrameCallback(){return 1;} cancelVideoFrameCallback(){}
 }
 const el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 class Engine{constructor(){this.reset();}reset(){this.lastTime=null;this.count=0;this.ascents=[];this.completed=[];}pause(){this.lastTime=null;this.paused=true;}}
 const workers=[];
 class Worker{constructor(){workers.push(this);}postMessage(data){if(data.type==='init')queueMicrotask(()=>this.onmessage?.({data:{type:'ready'}}));}terminate(){this.stopped=true;}}
 const pipelines=[];
 class PoseStream{constructor(){pipelines.push(this);}start(){return Promise.resolve();}close(){this.stopped=true;}}
 const context=vm.createContext({document:{getElementById:el,querySelectorAll:()=>[],createElement:()=>new Element(),body:{classList:{add(){},remove(){}}}},
  window:{isSecureContext:true},navigator:{mediaDevices:{getUserMedia(){}}},localStorage:{getItem(){return null;}},
  PullupEngine:Engine,PoseStream,Worker,openCamera:open,savedFacing:()=> 'user',CAMERA_NAMES:{user:'Фронтальная'},
  pullupResultView:()=>null,drawPoseFace:()=>0,URL,AbortController,DOMException,performance:{now:()=>1000},
  setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},queueMicrotask,cancelAnimationFrame(){}});
 const source=fs.readFileSync(new URL('../app/pullups.mjs',import.meta.url),'utf8')
  .replace(/^import[^\n]+\n/gm,'').replace(/^export /gm,'').replaceAll('import.meta.url',JSON.stringify('https://example.test/pullups.mjs'));
 vm.runInContext(source,context);
 return {run:code=>vm.runInContext(code,context),el,workers,pipelines};
}
function opened(){const track={stopped:0,stop(){this.stopped++;},addEventListener(){}};return {track,value:{stream:{getTracks:()=>[track],getVideoTracks:()=>[track]},actual:'user',mirror:true}};}
test('a camera permission result arriving after pause is released, never attached',async()=>{
 let resolve;const h=harness(()=>new Promise(r=>{resolve=r;}));await h.run("selectSource('camera')");
 const pending=h.run('play()');h.run('pauseArchive()');const m=opened();resolve(m.value);await pending;
 assert.equal(m.track.stopped,1);assert.equal(h.el('pullup-video').srcObject,null);assert.equal(h.run('mode'),'paused');
});
test('camera pause releases tracks and workers, preserves the finished count, and resume uses a new stream',async()=>{
 const streams=[];const h=harness(async()=>{const m=opened();streams.push(m);return m.value;});
 await h.run("selectSource('camera')");await h.run('play()');assert.equal(h.run('mode'),'running');
 assert.equal(h.run('engine.paused'),undefined,'a fresh initial hang is not treated as a lost onset');
 h.run('engine.count=3');await h.run("selectSource('camera')");assert.equal(h.run('engine.count'),3);assert.equal(streams[0].track.stopped,0);
 h.run('pauseArchive()');assert.equal(streams[0].track.stopped,1);assert.equal(h.run('engine.count'),3);
 assert.ok(h.workers.every(w=>w.stopped));assert.ok(h.pipelines.every(p=>p.stopped));
 await h.run('play()');assert.equal(streams.length,2);assert.equal(h.run('engine.count'),3);h.run('closeArchive()');
 assert.equal(streams[1].track.stopped,1);
});
test('denied camera permission leaves a retryable error without a stream',async()=>{
 const h=harness(async()=>{throw Object.assign(new Error('denied'),{name:'NotAllowedError'});});
 await h.run("selectSource('camera')");await h.run('play()');assert.equal(h.run('mode'),'error');
 assert.equal(h.el('pullup-play').disabled,false);assert.equal(h.el('pullup-video').srcObject,null);
 assert.match(h.el('pullup-status').textContent,/Разрешите камеру/);
});
