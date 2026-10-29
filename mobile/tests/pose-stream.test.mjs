import test from 'node:test';import assert from 'node:assert/strict';
import {PoseStream} from '../app/pose-stream.mjs';
async function runtime(fn){
 const original={Worker:globalThis.Worker,createImageBitmap:globalThis.createImageBitmap},workers=[],bitmaps=[];
 globalThis.Worker=class{constructor(){workers.push(this);this.sent=[];}postMessage(data){this.sent.push(data);queueMicrotask(()=>this.onmessage?.({data:{type:data.type==='init'?'ready':'pose',now:data.now}}));}terminate(){this.stopped=true;}};
 globalThis.createImageBitmap=async()=>{const bitmap={close(){this.closed=true;}};bitmaps.push(bitmap);return bitmap;};
 try{await fn({workers,bitmaps});}finally{Object.assign(globalThis,original);}
}
const video={videoWidth:640,videoHeight:480};
test('pose filtering uses the captured source timestamp, independently of CPU scheduling time',async()=>runtime(async({workers})=>{
 const stream=new PoseStream();await stream.start();
 for(const t of [.04,.08,.2]){const r=await stream.frame(video,t,7);assert.equal(r.now,t*1000);assert.equal(r.sourceTime,t);assert.equal(r.epoch,7);}
 assert.deepEqual(workers[0].sent.filter(m=>m.type==='frame').map(m=>m.now),[40,80,200]);stream.close();
}));
test('duplicates and reverse time are skipped, not passed to MediaPipe with invented timestamps; a fresh session can restart',async()=>runtime(async({workers,bitmaps})=>{
 const stream=new PoseStream();await stream.start();await stream.frame(video,2,0);
 assert.equal(await stream.frame(video,2,0),null);assert.equal(await stream.frame(video,1,0),null);assert.equal(bitmaps.length,1);
 await assert.rejects(stream.frame(video,NaN,0),/время/);assert.equal(stream.busy,false);
 stream.close();await stream.start();assert.equal((await stream.frame(video,0,1)).now,0);
 assert.equal(workers.length,2);assert.ok(workers[0].stopped);stream.close();
}));
