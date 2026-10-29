const {readFileSync}=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
function fixture(saved){
 const nodes=new Map(),storage=new Map(),listeners={},downloads=[],draws=[];
 class Element{
  constructor(){this.children=[];this.attributes={};this.style={};this.events={};this.currentTime=0;this.duration=4;this.paused=true;this.value='';}
  set id(v){this._id=v;nodes.set(v,this);}get id(){return this._id;}
  append(...x){this.children.push(...x);}setAttribute(k,v){this.attributes[k]=v;}removeAttribute(){}load(){}
  pause(){this.paused=true;}play(){this.paused=false;return Promise.resolve();}click(){if(!this.disabled)this.onclick?.();}
  addEventListener(name,fn){this.events[name]=fn;}emit(name){const fn=this.events[name];delete this.events[name];fn?.();}
  getContext(){return {clearRect(){},drawImage(...args){draws.push(args);}};}
 }
 const get=id=>{if(!nodes.has(id)){const e=new Element();e.id=id;}return nodes.get(id);};
 const key='pullup-partial-subtype-v1';if(saved)storage.set(key,JSON.stringify(saved));
 const item={id:'a',file:'a.mp4',sourceStart:10,duration:4,windowStart:1,windowEnd:2};
 const data={items:[item,{...item,id:'b'}],poses:{},frameTimes:{a:Array.from({length:100},(_,i)=>i*.04)}};
 const context=vm.createContext({subtypeData:data,document:{getElementById:get,createElement:()=>new Element(),addEventListener:(k,f)=>listeners[k]=f},
  localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},location:{protocol:'file:'},AbortController,
  Blob,URL:{createObjectURL:b=>{downloads.push(b);return 'blob:test';},revokeObjectURL(){}},setTimeout:cb=>cb()});
 vm.runInContext(readFileSync(__dirname+'/partial_subtype_review.js','utf8'),context);vm.runInContext('mediaState(true)',context);
 return {get,downloads,draws,run:s=>vm.runInContext(s,context),saved:()=>JSON.parse(storage.get(key)),
  press:(code,extra={})=>listeners.keydown({code,preventDefault(){},...extra})};
}
test('1–5 save exactly one subtype and automatically advance; unknown is not normal',()=>{
 for(const [n,type]of ['bottom_only','top_only','both','neither','unknown'].entries()){
  const f=fixture();f.press('Digit'+(n+1));const saved=f.saved();assert.equal(saved.index,1);
  assert.equal(saved.answers.a.subtype,type);assert.equal(saved.answers.a.complete,true);
  assert.equal(saved.answers.a.phase_times,undefined);assert.equal(saved.answers.a.facing,undefined);
 }
});
test('back navigation permits correction and progress survives reload',()=>{
 const f=fixture();f.press('Numpad1');f.press('KeyP');f.run('mediaState(true)');f.press('Digit2');
 assert.equal(f.saved().answers.a.subtype,'top_only');
 const g=fixture(f.saved());assert.equal(g.saved().index,1);assert.equal(g.saved().answers.a.subtype,'top_only');
});
test('B/T jumps pause, and held number keys or loading cannot annotate another clip',()=>{
 const f=fixture();f.get('video').paused=false;f.press('KeyT',{key:'е'});
 assert.equal(f.get('video').paused,true);assert.ok(Math.abs(f.get('video').currentTime-2.02)<1e-6);
 f.press('Digit1');f.press('Digit1',{repeat:true});assert.equal(f.saved().answers.b,undefined);
 f.press('Digit1');assert.equal(f.saved().answers.b,undefined);
});
test('partial export has no required extra fields and last answer remains editable',async()=>{
 const f=fixture();f.press('Digit3');f.run('mediaState(true)');f.press('Digit5');
 assert.equal(f.saved().index,1);f.press('KeyS',{ctrlKey:true});
 const packet=JSON.parse(await f.downloads.at(-1).text());assert.equal(packet.schema,3);assert.equal(packet.answers.b.subtype,'unknown');
 f.press('Digit4');assert.equal(f.saved().answers.b.subtype,'neither');
});
test('opening waits for the ascent start frame, then stops at the top and replays the window',()=>{
 const f=fixture(),v=f.get('video');v.currentTime=0;v.onloadeddata();
 assert.equal(v.style.visibility,'hidden');assert.ok(Math.abs(v.currentTime-1.02)<1e-6);assert.equal(v.paused,true);
 v.emit('seeked');assert.equal(v.style.visibility,'visible');assert.equal(v.paused,false);
 v.currentTime=2.2;v.ontimeupdate();assert.equal(v.paused,true);assert.ok(Math.abs(v.currentTime-2.02)<1e-6);
 f.press('Space');assert.equal(v.paused,false);assert.ok(Math.abs(v.currentTime-1.02)<1e-6);
 assert.deepEqual(f.saved().answers,{});
});
test('manual seeking can inspect context outside the ascent without clamping it back',()=>{
 const f=fixture(),v=f.get('video');f.get('seek').value=7500;f.get('seek').oninput();
 f.press('Space');v.ontimeupdate();assert.equal(v.currentTime,3);assert.equal(v.paused,false);
 f.get('replay').click();assert.equal(v.paused,true);assert.ok(Math.abs(v.currentTime-1.02)<1e-6);
 f.press('Space');v.currentTime=2.2;v.ontimeupdate();assert.equal(v.paused,true);
});
test('decoded video is painted on the same canvas, including pause, seeking and skeleton off',()=>{
 const f=fixture(),v=f.get('video'),c=f.get('overlay');
 v.readyState=4;v.videoWidth=1138;v.videoHeight=640;v.paused=true;
 v.onseeked();assert.equal(f.draws.at(-1)[0],v);assert.equal(f.draws.at(-1)[3],1138);
 const before=f.draws.length;f.get('pose').click();
 assert.equal(c.hidden,false);assert.equal(f.get('pose').textContent,'Скелет: выкл.');
 assert.equal(f.draws.length,before+1);assert.equal(f.draws.at(-1)[0],v);
 assert.deepEqual(f.saved().answers,{});
 v.readyState=0;f.run('draw()');assert.equal(f.draws.length,before+1);
});
