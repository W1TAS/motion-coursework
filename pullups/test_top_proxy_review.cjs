const {readFileSync}=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
function fixture(saved){
 const nodes=new Map(),storage=new Map([['pullup-partial-subtype-v1','old-labels-untouched']]),listeners={},downloads=[];
 class Element{
  constructor(){this.children=[];this.style={};this.attributes={};this.events={};this.currentTime=0;this.duration=4;this.paused=true;this.value='';}
  set id(v){this._id=v;nodes.set(v,this);}get id(){return this._id;}
  append(...x){this.children.push(...x);}setAttribute(k,v){this.attributes[k]=v;}removeAttribute(){}load(){}
  pause(){this.paused=true;}play(){this.paused=false;return Promise.resolve();}click(){if(!this.disabled)this.onclick?.();}
  addEventListener(n,f){this.events[n]=f;}emit(n){const f=this.events[n];delete this.events[n];f?.();}
  getContext(){return {clearRect(){},drawImage(){}};}
 }
 const get=id=>{if(!nodes.has(id)){const e=new Element();e.id=id;}return nodes.get(id);};
 const key='pullup-top-proxy-review-01';if(saved)storage.set(key,JSON.stringify(saved));
 const item={id:'a',file:'a.mp4',sourceStart:10,duration:4,windowStart:1,windowEnd:2,priorTop:1,
  measurement:{state:'measured',top:{mouth:{state:'near'}},peak:{timeMs:11500,mouth:{state:'above'}}}};
 const data={packetId:'top-proxy-review-01',items:[item,{...item,id:'b'}],poses:{},frameTimes:{a:Array.from({length:100},(_,i)=>i*.04)}};
 const context=vm.createContext({topReviewData:data,document:{getElementById:get,createElement:()=>new Element(),addEventListener:(k,f)=>listeners[k]=f},
  localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},location:{protocol:'file:'},AbortController,Blob,
  URL:{createObjectURL:b=>{downloads.push(b);return 'blob:test';},revokeObjectURL(){}},setTimeout:f=>f()});
 vm.runInContext(readFileSync(__dirname+'/top_proxy_review.js','utf8'),context);vm.runInContext('mediaState(true)',context);
 return {get,data,downloads,storage,run:s=>vm.runInContext(s,context),saved:()=>JSON.parse(storage.get(key)),
  press:(code,extra={})=>listeners.keydown({code,preventDefault(){},...extra})};
}
test('new upper-height observations stay separate and unknown/unusable never become normal',()=>{
 for(const [digit,label,status]of [[1,0,'sufficient'],[2,1,'insufficient'],[3,null,'uncertain'],[4,null,'unusable']]){
  const f=fixture();f.press('Digit'+digit);
  assert.equal(f.saved().answers.a.top_below_bar,label);assert.equal(f.saved().answers.a.review_status,status);
  assert.equal(f.data.items[0].priorTop,1);assert.equal(f.storage.get('pullup-partial-subtype-v1'),'old-labels-untouched');
  assert.equal(f.saved().index,1);f.press('Digit2',{repeat:true});assert.equal(f.saved().answers.b,undefined);
 }
});
test('top and face peak seek to encoded frames paused, with comparison initially hidden',()=>{
 const f=fixture(),v=f.get('video');assert.equal(f.get('comparison').hidden,true);
 v.paused=false;f.press('KeyT');assert.equal(v.paused,true);assert.ok(Math.abs(v.currentTime-2.02)<1e-6);
 v.paused=false;f.press('KeyH');assert.equal(v.paused,true);assert.ok(Math.abs(v.currentTime-1.5)<1e-6);
 f.press('KeyR');assert.equal(f.get('comparison').hidden,false);assert.deepEqual(f.saved().answers,{});
});
test('initial apex waits for decoding and does not autoplay or answer',()=>{
 const f=fixture(),v=f.get('video');v.currentTime=0;v.onloadeddata();
 assert.equal(f.get('overlay').style.visibility,'hidden');assert.ok(Math.abs(v.currentTime-2.02)<1e-6);
 v.emit('seeked');assert.equal(f.get('overlay').style.visibility,'visible');assert.equal(v.paused,true);
 assert.deepEqual(f.saved().answers,{});
});
test('export retains packet identity and separate user observation, correction survives reload',async()=>{
 const f=fixture();f.press('Digit1');f.press('KeyP');f.run('mediaState(true)');f.press('Digit2');
 const g=fixture(f.saved());assert.equal(g.saved().answers.a.top_below_bar,1);
 g.press('KeyS',{ctrlKey:true});const p=JSON.parse(await g.downloads.at(-1).text());
 assert.equal(p.schema,'top-proxy-adjudication-v1');assert.equal(p.items[0].priorTop,1);
 assert.equal(p.answers.a.top_below_bar,1);assert.equal(p.packetId,'top-proxy-review-01');
});
