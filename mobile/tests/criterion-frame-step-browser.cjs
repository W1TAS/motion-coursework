const {createRequire}=require('node:module'),fs=require('node:fs');
const {execFileSync}=require('node:child_process');
const path=require('node:path'),{pathToFileURL}=require('node:url');
const crypto=require('node:crypto');
const req=createRequire('/home/w1tas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');const {chromium}=req('./index.js');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const p=await browser.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
  const offline=process.argv.includes('--file');
  await p.goto(offline?pathToFileURL(path.resolve('pullups/dataset_mediapipe_gpu/criteria-review-02/index.html')).href:'http://127.0.0.1:8769/');
  const ready=()=>p.waitForFunction(()=>{const v=document.getElementById('video');return v.dataset.ready==='true'&&!v.seeking&&v.seekable.length&&v.seekable.end(0)>v.duration-.05;});
  const settle=()=>p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  let timestamps=[];
  const position=async()=>{const t=await p.locator('#video').evaluate(v=>v.currentTime);let at=0;for(let i=1;i<timestamps.length&&timestamps[i]<=t+1e-6;i++)at=i;return at;};
  const seek=async t=>{await p.locator('#video').evaluate((v,t)=>{v.pause();v.currentTime=t},t);await ready();await settle();};
  const hash=async()=>{
   // file:// video taints a canvas under Chromium's normal security policy.
   // Compare rendered pixels without relaxing that policy; omit native controls.
   if(offline){await p.locator('#video').scrollIntoViewIfNeeded();await settle();const box=await p.locator('#video').boundingBox();const png=await p.screenshot({clip:{...box,height:box.height-65}});return crypto.createHash('sha256').update(png).digest('hex');}
   return p.locator('#video').evaluate(v=>{const c=document.createElement('canvas');c.width=80;c.height=80;const x=c.getContext('2d');x.drawImage(v,0,0,80,80);let h=0;for(const b of x.getImageData(0,0,80,80).data)h=(h*31+b)|0;return h;});
  };
  const items=JSON.parse(fs.readFileSync('pullups/dataset_mediapipe_gpu/human-reviews/review-02-selection.json')).items;
  let changedFrames=0;
  for(let i=0;i<items.length;i++){
   timestamps=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','frame=best_effort_timestamp_time','-of','json','pullups/dataset_mediapipe_gpu/criteria-review-02/'+items[i].file])).frames.map(f=>Number(f.best_effort_timestamp_time));
   await ready();if(!offline&&!(await p.locator('#video').getAttribute('src')).startsWith('blob:'))throw Error('HTTP clip is not a local seekable source');
   // Hide only the browser's fading video chrome in this isolated screenshot
   // test. Application frame-step controls and media behavior stay unchanged.
   if(offline)await p.locator('#video').evaluate(v=>v.controls=false);
   const n=timestamps.findIndex(t=>t>=items[i].windowStart+.36);await seek((timestamps[n]+timestamps[n+1])/2);const before=await hash();
   await p.locator('#forward-frame').click();await ready();await settle();if(await position()!==n+1)throw Error('Forward frame failed on clip '+i);if(await hash()!==before)changedFrames++;
   await p.locator('#back-frame').click();await ready();await settle();if(await position()!==n||await hash()!==before)throw Error('Previous decoded frame not restored on clip '+i);
   await p.locator('#forward-frame').click({clickCount:5});await ready();if(await position()!==n+5)throw Error('Rapid clicks lost');
   await seek(0);await p.locator('#back-frame').click();await ready();if(await position()!==0)throw Error('Stepped before start '+JSON.stringify({clip:i,state:await p.locator('#video').evaluate(v=>({time:v.currentTime,duration:v.duration,paused:v.paused,seeking:v.seeking}))}));
   const duration=await p.locator('#video').evaluate(v=>v.duration);await seek(duration);await p.locator('#forward-frame').click();await ready();if(await position()!==timestamps.length-1)throw Error('Stepped past last frame');
   if(i===0){await p.locator('#note').fill('SYNTHETIC frame-step persistence check');await p.reload();await ready();if(await p.locator('#note').inputValue()!=='SYNTHETIC frame-step persistence check')throw Error('Answers lost on reload');}
   if(i<items.length-1)await p.locator('#next').click();
  }
  if(!changedFrames)throw Error('Time changed without any decoded image changing');
  // Exercise cancellation of asynchronous video loading on rapid source switches.
  await p.locator('#prev').click();await p.locator('#next').click();await ready();
  if(await p.locator('#count').textContent()!=='12 / 12')throw Error('Stale source switch');
  if(errors.length)throw Error(JSON.stringify(errors));
  const result={mode:offline?'file':'http',clips:12,changedFrames,checks:['seekable full clip','forward and backward decoded frame','five rapid clicks','start/end limits','answer persistence','source switch cancellation'],errors,date:new Date().toISOString()};
  fs.writeFileSync('mobile/tests/criterion-frame-step-'+(offline?'file':'http')+'-result.json',JSON.stringify(result,null,2));console.log(result);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
