import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';
test('worker assesses an ascent immediately but waits for a full cycle to run its classifier',async()=>{
 const messages=[],calls=[];
 class Session{
  observe(...args){calls.push(['observe',...args]);}
  assessAscent(event){calls.push(['ascent',event.index]);return {initialBottom:{state:'unavailable'}};}
  classify(rep){calls.push(['full',rep.index]);return {targets:{}};}
 }
 const context={PullupAnalysisSession:Session,URL,performance:{now:()=>0},
  fetch:async()=>({ok:true,json:async()=>({})}),self:{postMessage:m=>messages.push(m)}};
 const source=fs.readFileSync(new URL('../app/pullup-classifier-worker.mjs',import.meta.url),'utf8')
  .replace(/^import[^\n]+\n/,'').replace('import.meta.url',JSON.stringify('https://example.test/pullup-classifier-worker.mjs'));
 vm.runInNewContext(source,context);
 await context.self.onmessage({data:{type:'init'}});
 const world=[{x:1,y:2,z:3}];
 await context.self.onmessage({data:{type:'observe',epoch:7,time:1000,ascent:{index:3},worldLandmarks:world}});
 assert.equal(messages.at(-1).type,'ascent-decision');assert.equal(messages.at(-1).index,3);
 assert.equal(messages.at(-1).epoch,7);assert.ok(!calls.some(c=>c[0]==='full'));
 assert.equal(calls.find(c=>c[0]==='observe').at(-1),world);
 await context.self.onmessage({data:{type:'observe',epoch:7,time:2000,rep:{index:1,ascentIndex:3}}});
 assert.equal(messages.at(-1).type,'decision');assert.equal(messages.at(-1).index,1);
});
test('missing HGB does not prevent the independent ascent rule from starting',async()=>{
 const messages=[];
 class Session{
  constructor(model,prior){assert.equal(model,null);assert.equal(prior.present,true);}
  observe(){}assessAscent(){return {topHeight:{state:'below'}};}
 }
 const context={PullupAnalysisSession:Session,URL,performance:{now:()=>0},
  fetch:async url=>String(url).includes('pullup-hgb')?{ok:false}:{ok:true,json:async()=>({present:true})},
  self:{postMessage:m=>messages.push(m)}};
 const source=fs.readFileSync(new URL('../app/pullup-classifier-worker.mjs',import.meta.url),'utf8')
  .replace(/^import[^\n]+\n/,'').replace('import.meta.url',JSON.stringify('https://example.test/worker.mjs'));
 vm.runInNewContext(source,context);await context.self.onmessage({data:{type:'init'}});
 assert.equal(messages.at(-1).type,'ready');assert.equal(messages.at(-1).modelAvailable,false);
 await context.self.onmessage({data:{type:'observe',epoch:1,ascent:{index:1}}});
 assert.equal(messages.at(-1).decision.topHeight.state,'below');
});
