import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';

function harness(open){
 const elements=new Map();
 class Element{
  constructor(){this.dataset={};this.style={};this.listeners=new Map();this.checked=true;this.value='example-1';this.currentTime=0;this.duration=10;
   this.videoWidth=640;this.videoHeight=480;this.paused=true;this.classList={add(){},remove(){},toggle(){}};}
  get currentTime(){return this.time??0;}set currentTime(value){this.time=value;this.seeking=true;queueMicrotask(()=>{this.seeking=false;this.emit('seeked');});}
  setAttribute(){} removeAttribute(name){delete this[name];} replaceChildren(){} append(){} querySelector(){return null;}
  addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
  removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);}
  emit(name){for(const fn of [...this.listeners.get(name)??[]])fn();}
  getContext(){return {clearRect(){}};} pause(){this.paused=true;} load(){if(this.src)queueMicrotask(()=>this.emit('loadeddata'));} play(){this.paused=false;return Promise.resolve();}
  requestVideoFrameCallback(){return 1;} cancelVideoFrameCallback(){}
 }
 const el=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 class Engine{constructor(){this.reset();}reset(){this.lastTime=null;this.count=0;this.ascents=[];this.completed=[];}pause(){this.lastTime=null;this.paused=true;}update(points,time){this.lastTime=time;return {phase:'waiting',valid:false};}}
 const workers=[];
 class Worker{constructor(){workers.push(this);}postMessage(data){if(data.type==='init')queueMicrotask(()=>this.onmessage?.({data:{type:'ready'}}));}terminate(){this.stopped=true;}}
 const pipelines=[];
 const urls=[],revoked=[],requests=[];
 class BlobURL extends URL{static createObjectURL(blob){urls.push(blob);return `blob:test-${urls.length}`;}static revokeObjectURL(url){revoked.push(url);}}
 class PoseStream{constructor(){pipelines.push(this);this.frames=[];}start(){return Promise.resolve();}close(){this.stopped=true;}frame(v,time,epoch){this.frames.push({time,paused:v.paused});return Promise.resolve({landmarks:null,sourceTime:time,now:time*1000,epoch,width:640,height:480});}}
 const context=vm.createContext({document:{getElementById:el,querySelector:()=>el('disclosure'),querySelectorAll:()=>[],createElement:()=>new Element(),body:{classList:{add(){},remove(){}}}},
  window:{isSecureContext:true},navigator:{mediaDevices:{getUserMedia(){}}},localStorage:{getItem(){return null;}},
  PullupEngine:Engine,PoseStream,Worker,PullupTrace:class{reset(){} lifecycle(){} frame(){} decision(){} mount(){}},openCamera:open,savedFacing:()=> 'user',CAMERA_NAMES:{user:'Фронтальная'},
  pullupResultView:()=>null,drawPoseFace:()=>0,URL:BlobURL,File,AbortController,DOMException,performance:{now:()=>1000},
  fetch:async url=>{requests.push(String(url));throw Error('Unexpected network read');},
  setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},queueMicrotask,cancelAnimationFrame(){}});
 const source=fs.readFileSync(new URL('../app/pullups.mjs',import.meta.url),'utf8')
  .replace(/^import[^\n]+\n/gm,'').replace(/^export /gm,'').replaceAll('import.meta.url',JSON.stringify('https://example.test/pullups.mjs'));
 vm.runInContext(source,context);
 return {run:code=>vm.runInContext(code,context),el,workers,pipelines,urls,revoked,requests};
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
test('a selected phone video uses a Blob locally; pause, cancel, seek and restart retain the same file',async()=>{
 const h=harness();await h.run("chooseFile(new File(['video'], 'phone.mp4', {type:'video/mp4'}))");
 assert.equal(h.run('source'),'file');assert.equal(h.run('mode'),'ready');assert.equal(h.urls.length,1);
 assert.equal(h.el('pullup-file-name').textContent,'phone.mp4');assert.equal(h.el('pullup-recording-options').hidden,true);
 await h.run('play()');h.run('engine.count=2; pauseArchive()');await h.run('chooseFile(undefined)');
 assert.equal(h.run('mode'),'paused');assert.equal(h.run('engine.count'),2);assert.equal(h.urls.length,1);
 await h.el('pullup-seek').onchange({target:{value:'4'}});assert.equal(h.el('pullup-video').currentTime,4);assert.equal(h.run('engine.count'),0);
 await h.el('pullup-restart').onclick();assert.equal(h.el('pullup-video').currentTime,0);
 assert.equal(h.run('videoBlob===selectedFile'),true);assert.deepEqual(h.requests,[]);
 h.el('pullup-back').onclick();assert.equal(h.run('selectedFile'),null);assert.deepEqual(h.revoked,['blob:test-1']);
});
test('switching from camera to a phone recording stops capture; retry never falls back to a built-in example',async()=>{
 const m=opened(),h=harness(async()=>m.value);await h.run("selectSource('camera'); play()");
 await h.run("chooseFile(new File(['video'], 'phone.mov', {type:''}))");
 assert.equal(m.track.stopped,1);assert.equal(h.el('pullup-video').srcObject,null);
 h.run("pipeline.close(); pipeline=null; state('error')");await h.run('play()');
 assert.equal(h.run('source'),'file');assert.equal(h.run('mode'),'running');assert.equal(h.urls.length,2);
 assert.equal(h.urls[0],h.urls[1]);assert.deepEqual(h.requests,[]);
 await h.run("chooseFile(new File(['next'], 'next.mp4', {type:'video/mp4'}))");
 assert.deepEqual(h.revoked,['blob:test-1','blob:test-2']);assert.equal(h.el('pullup-file-name').textContent,'next.mp4');h.run('closeArchive()');
});
test('the first real file frame is analysed while paused; pause preserves the detector, seek and replay replace it',async()=>{
 const h=harness();await h.run("chooseFile(new File(['video'], 'phone.mp4', {type:'video/mp4'}))");
 await h.run('play()');const first=h.pipelines[0];assert.deepEqual(first.frames,[{time:0,paused:true}]);
 h.run('pauseArchive()');await h.run('play()');assert.equal(h.pipelines.length,1,'ordinary pause retains the temporal stream');
 await h.el('pullup-seek').onchange({target:{value:'4'}});assert.ok(first.stopped);assert.equal(h.run('mode'),'paused');
 await h.run('play()');assert.equal(h.pipelines.length,2);assert.deepEqual(h.pipelines[1].frames,[{time:4,paused:true}]);
 h.run("state('ended')");await h.run('play()');assert.ok(h.pipelines[1].stopped);assert.equal(h.pipelines.length,3);
 assert.deepEqual(h.pipelines[2].frames,[{time:0,paused:true}]);h.run('closeArchive()');
});
test('suspending while the first file frame is being prepared cannot start playback or accept a late pose',async()=>{
 const h=harness();await h.run("chooseFile(new File(['video'], 'phone.mp4', {type:'video/mp4'}))");
 let resolve;h.pipelines[0].frame=(v,time,epoch)=>new Promise(ok=>{resolve=()=>ok({landmarks:null,sourceTime:time,now:time*1000,epoch,width:640,height:480});});
 const playing=h.run('play()');assert.equal(h.run('mode'),'priming');h.run('pauseArchive()');resolve();await playing;
 assert.equal(h.run('mode'),'paused');assert.equal(h.el('pullup-video').paused,true);assert.equal(h.run('engine.lastTime'),null);
 assert.ok(h.pipelines[0].stopped);await h.run('play()');assert.equal(h.run('mode'),'running');h.run('closeArchive()');
});
test('a non-video selection cannot replace the current recording',async()=>{
 const h=harness();await h.run("chooseFile(new File(['video'], 'phone.mp4', {type:'video/mp4'}))");
 await h.run("chooseFile(new File(['text'], 'notes.txt', {type:'text/plain'}))");
 assert.equal(h.urls.length,1);assert.equal(h.el('pullup-file-name').textContent,'phone.mp4');h.run('closeArchive()');
});
