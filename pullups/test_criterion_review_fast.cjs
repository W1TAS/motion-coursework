// All answers here are synthetic and stay in this isolated VM.
const {readFileSync}=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
function fixture(saved){
 const nodes=new Map(),storage=new Map(),listeners={},downloads=[];
 class Element{
  constructor(tag='DIV'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.value='';this.currentTime=0;this.duration=4;this.paused=true;this.classList={toggle(){}};}
  set id(v){this._id=v;nodes.set(v,this);}get id(){return this._id;}
  append(...v){this.children.push(...v);}replaceChildren(...v){this.children=[...v];}add(){}setAttribute(){}removeAttribute(){}load(){}pause(){this.paused=true;}play(){this.paused=false;return Promise.resolve();}blur(){}
  click(){if(!this.disabled)this.onclick?.();}
  getContext(){return {clearRect(){}};}
 }
 const get=id=>{if(!nodes.has(id)){const e=new Element();e.id=id;}return nodes.get(id);};
 const key='pullup-criterion-review-v2-batch-04';if(saved)storage.set(key,JSON.stringify(saved));
 const item={id:'fixture',file:'fixture.mp4',duration:4,sourceStart:10,windowStart:1,windowEnd:3};
 const data={items:[item,{...item,id:'second'}],poses:{},frameTimes:{fixture:Array.from({length:100},(_,i)=>i*.04)},
  suggestions:{fixture:{times:{bottom:1,top:2},method:'fixture'}}};
 const context=vm.createContext({reviewData:data,document:{getElementById:get,createElement:t=>new Element(t),addEventListener:(k,f)=>listeners[k]=f},
  localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},Option:class{},location:{protocol:'file:'},AbortController,
  URL:{createObjectURL:b=>{downloads.push(b);return 'blob:fixture';},revokeObjectURL(){}},Blob,setTimeout:cb=>cb()});
 vm.runInContext(readFileSync(__dirname+'/criterion_review_fast.js','utf8'),context);vm.runInContext('mediaState(true)',context);
 const press=(code,extra={})=>listeners.keydown({code,preventDefault(){},target:{tagName:'BUTTON'},...extra});
 return {get,press,downloads,saved:()=>JSON.parse(storage.get(key)),run:s=>vm.runInContext(s,context)};
}
test('numeric answers advance questions; phase keys work independently of Russian layout',()=>{
 const f=fixture();for(const code of ['Digit1','Digit1','Digit2','Digit1','Digit2','Numpad2'])f.press(code);
 f.get('video').currentTime=1;f.press('KeyB',{key:'и'});f.get('video').currentTime=2;f.press('KeyT',{key:'е'});
 const a=f.saved().answers.fixture;assert.equal(a.complete,true);assert.equal(a.facing,'front');assert.equal(a.bottom_incomplete,'1');assert.equal(a.swing_ascent,'1');assert.equal(a.pose_quality,'unstable');
 assert.deepEqual(a.phase_times,{return:null,bottom:1,top:2});assert.equal(a.phase_sources.return.kind,'not_required');
 f.press('KeyN');assert.equal(f.saved().index,1);
});
test('phase jumps pause without accepting; confirmation preserves manual bottom',()=>{
 const f=fixture();f.get('video').paused=false;f.press('KeyT',{shiftKey:true});
 assert.equal(f.get('video').paused,true);assert.ok(Math.abs(f.get('video').currentTime-2.02)<1e-6);
 assert.deepEqual(f.saved().answers.fixture.phase_times,{return:null});
 f.get('video').currentTime=.8;f.press('KeyB');f.press('KeyC');
 assert.deepEqual(f.saved().answers.fixture.phase_times,{return:null,bottom:.8,top:2.02});
 const restored=fixture(f.saved());assert.equal(restored.saved().answers.fixture.phase_times.bottom,.8);
});
test('back and unusable shortcuts record exclusions without inventing technical labels',()=>{
 for(const code of ['KeyX','KeyK']){
  const f=fixture();f.press(code);const a=f.saved().answers.fixture;
  assert.equal(f.saved().index,1);assert.equal(a.complete,false);assert.equal(a.bottom_incomplete,'');
  assert.equal(a.review_status,code==='KeyX'?'skipped_back':'skipped_unusable');
 }
});
test('next guards incomplete rows; typing a comment never triggers shortcuts',()=>{
 const f=fixture();f.press('KeyN');assert.equal(f.saved().index,0);
 f.press('KeyX',{target:{tagName:'TEXTAREA'}});assert.equal(f.saved().index,0);assert.equal(f.saved().answers.fixture.review_status,null);
});
test('Ctrl+S exports the current schema and return remains explicitly optional',async()=>{
 const f=fixture();f.press('KeyS',{ctrlKey:true,target:{tagName:'TEXTAREA'}});
 const p=JSON.parse(await f.downloads.at(-1).text());assert.equal(p.schema,2);assert.equal(p.batch,'criteria-04');assert.equal(p.answers.fixture.phase_times.return,null);
});
