// Isolated UI fixtures: never write synthetic answers to the user's browser.
const {readFileSync}=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const {test}=require('node:test');
function fixture(stored){
 const nodes=new Map(),storage=new Map();
 class Element{
  constructor(){this.children=[];this.dataset={};this.value='';this.classList={toggle(){}};this.currentTime=0;this.duration=4;this.paused=true;}
  set id(v){this._id=v;nodes.set(v,this);}get id(){return this._id;}
  append(...v){this.children.push(...v);}add(){}setAttribute(){}removeAttribute(){}load(){}pause(){this.paused=true;}
  getContext(){return {clearRect(){}};}
 }
 const get=id=>{if(!nodes.has(id)){const e=new Element();e.id=id;}return nodes.get(id);};
 if(stored)storage.set('pullup-criterion-review-v2-batch-02',JSON.stringify(stored));
 const context=vm.createContext({document:{getElementById:get,createElement:()=>new Element(),querySelectorAll:()=>[]},
  localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},Option:class{},location:{protocol:'file:'},AbortController,URL,Blob,setTimeout});
 let script=readFileSync(__dirname+'/criterion_review.html','utf8').split('<script>')[1].split('</script>')[0];
 const item={id:'fixture',file:'fixture.mp4',sourceStart:0,duration:4,windowStart:1,windowEnd:3};
 script=script.replace('__ITEMS__',JSON.stringify([item,{...item,id:'missing'}])).replace('__POSES__','{}')
  .replace('__FRAME_TIMES__',JSON.stringify({fixture:Array.from({length:100},(_,i)=>i*.04)}))
  .replace('const phaseSuggestions={};','const phaseSuggestions={fixture:{times:{bottom:1,top:2,return:3},method:"fixture"}};');
 vm.runInContext(script,context);vm.runInContext("mediaState(true,'')",context);
 return {get,run:code=>vm.runInContext(code,context),saved:()=>JSON.parse(storage.get('pullup-criterion-review-v2-batch-02'))};
}
test('preview and interval jumps pause playback without accepting phases',()=>{
 const f=fixture();f.get('video').paused=false;f.get('preview-top').onclick();
 assert.equal(f.get('video').paused,true);assert.ok(Math.abs(f.get('video').currentTime-2.02)<1e-6);
 assert.deepEqual(f.saved().answers.fixture.phase_times,{});
 f.get('video').paused=false;f.get('replay').onclick();assert.equal(f.get('video').paused,true);
});
test('batch confirmation fills only missing phases and preserves manual and unseen',()=>{
 const f=fixture({answers:{fixture:{phase_times:{bottom:.7,return:null},note:'keep'}},index:0});
 f.get('confirm-phases').onclick();const answer=f.saved().answers.fixture;
 assert.deepEqual(answer.phase_times,{bottom:.7,top:2.02,return:null});
 assert.equal(answer.phase_sources.top.kind,'auto_confirmed');assert.equal(answer.note,'keep');
 assert.equal(f.get('confirm-phases').disabled,true);
 const restored=fixture(f.saved());assert.deepEqual(restored.saved().answers.fixture.phase_times,answer.phase_times);
});
test('individual confirmation records provenance but does not answer technique questions',()=>{
 const f=fixture();f.get('accept-bottom').onclick();const a=f.saved().answers.fixture;
 assert.equal(a.phase_sources.bottom.suggested_time,1);assert.equal(a.attempt,'');assert.equal(a.complete,false);
 f.get('video').paused=false;f.get('go-bottom').onclick();assert.equal(f.get('video').paused,true);
});
test('missing detections leave all phases unset and disable confirmation',()=>{
 const f=fixture();f.get('next').onclick();f.run("mediaState(true,'')");
 assert.equal(f.get('confirm-phases').disabled,true);assert.equal(f.get('preview-top').disabled,true);
 assert.deepEqual(f.saved().answers.missing.phase_times,{});
});
test('skeleton is shown on each clip and back-view skip does not invent labels',()=>{
 const f=fixture();assert.equal(f.get('show-pose').checked,true);assert.equal(f.get('overlay').hidden,false);
 f.get('skip-back').onclick();const a=f.saved().answers.fixture;
 assert.equal(a.facing,'back');assert.equal(a.review_status,'skipped_back');assert.equal(a.complete,false);
 assert.equal(a.bottom_incomplete,'');assert.deepEqual(a.phase_times,{});
 assert.equal(f.get('show-pose').checked,true);assert.equal(f.saved().index,1);
 f.get('prev').onclick();assert.equal(f.saved().answers.fixture.review_status,'skipped_back');
 f.get('resume-review').onclick();assert.equal(f.saved().answers.fixture.review_status,null);
});
