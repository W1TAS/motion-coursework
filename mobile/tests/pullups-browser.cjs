// Full-duration real inference; deliberately never reads cached poses or rep labels.
const {createRequire}=require('node:module'),fs=require('node:fs');
const req=createRequire('/home/w1tas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');const {chromium}=req('./index.js');
(async()=>{const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']});try{
 const page=await browser.newPage({viewport:{width:844,height:390}}),errors=[],external=[],cached=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:8770/')&&!r.url().startsWith('blob:'))external.push(r.url());if(/example-\d\.json/.test(r.url()))cached.push(r.url());});
 await page.addInitScript(()=>{window.modelResults=[];window.addEventListener('motion:pullup-result',e=>window.modelResults.push(e.detail));});
 await page.goto('http://127.0.0.1:8770/');await page.locator('#open-pullups').click();await page.waitForFunction(()=>document.getElementById('pullups').dataset.mode==='ready',null,{timeout:60000});
 if(await page.locator('#pullup-select option').count()!==3)throw Error('Expected three recordings');
 const manifest=JSON.parse(fs.readFileSync('mobile/app/samples/pullups/manifest.json')),runs=[];
 for(const item of manifest){
  if(item.id!==manifest[0].id){await page.locator('#pullup-select').selectOption(item.id);await page.waitForFunction(()=>document.getElementById('pullups').dataset.mode==='ready',null,{timeout:60000});}
  await page.evaluate(()=>window.modelResults=[]);
  if(await page.locator('#pullups').getAttribute('data-model')!=='ready')throw Error('Classifier not loaded');
  if(await page.locator('#pullup-count').textContent()!=='0')throw Error('Counter known before processing');
  if(!(await page.locator('#pullup-video').getAttribute('src')).startsWith('blob:'))throw Error('Video still streamed from APK ranges');
  await page.locator('#pullup-play').click();await page.waitForFunction(()=>Number(document.getElementById('pullups').dataset.frames)>10);
  await page.locator('#pullup-play').click();const time=await page.locator('#pullup-video').evaluate(v=>v.currentTime);await page.waitForTimeout(350);
  if(Math.abs(await page.locator('#pullup-video').evaluate(v=>v.currentTime)-time)>.1)throw Error('Pause did not stop video');
  await page.locator('#pullup-play').click();
  await page.waitForFunction(()=>['ended','error','stalled'].includes(document.getElementById('pullups').dataset.mode),null,{timeout:(item.duration+30)*1000});
  const run=await page.evaluate(()=>({mode:document.getElementById('pullups').dataset.mode,frames:Number(document.getElementById('pullups').dataset.frames),count:Number(document.getElementById('pullup-count').textContent),time:document.getElementById('pullup-video').currentTime,duration:document.getElementById('pullup-video').duration}));
  await page.waitForFunction(()=>Number(document.getElementById('pullups').dataset.modelDecisions)===Number(document.getElementById('pullups').dataset.completed));
  run.modelResults=await page.evaluate(()=>window.modelResults);
  if(run.modelResults.some(r=>!['measured','unavailable'].includes(r.rep.model?.geometry?.state)))throw Error('Missing or misleading arm-range result');
  if(run.modelResults.some(r=>!['measured','unavailable'].includes(r.rep.model?.initialBottom?.state)||!['flagged','not_detected','unavailable'].includes(r.rep.model?.bottomCandidate?.state)))throw Error('Missing initial-bottom result');
  if(!run.modelResults.some(r=>Number.isFinite(r.rep.model?.initialBottom?.angle3d)))throw Error('3D landmarks did not reach the classifier');
  if(await page.locator('#pullup-results details').evaluate(e=>e.open))throw Error('Experimental verdicts should start collapsed');
  console.log(item.id,{...run,modelResults:run.modelResults.length});if(run.mode!=='ended'||Math.abs(run.time-run.duration)>.2||run.frames<item.duration*3||run.count<1)throw Error('Stream did not complete with real inference: '+JSON.stringify(run));runs.push({id:item.id,...run});
  if(item.id==='example-1'){await page.locator('.archive-analysis').evaluate(e=>e.scrollTop=0);await page.screenshot({path:'mobile/screenshots/pullups-model-landscape.png'});}
 }
 // Seeking starts a new analysis; no predictions from the previous position leak.
 await page.locator('#pullup-seek').evaluate(e=>{e.value='10';e.dispatchEvent(new Event('change',{bubbles:true}));});
 if(await page.locator('#pullup-count').textContent()!=='0'||await page.locator('#pullup-results').textContent())throw Error('Seek leaked old decisions');
 await page.locator('#pullup-play').click();await page.waitForFunction(()=>Number(document.getElementById('pullups').dataset.frames)>5);await page.evaluate(()=>window.MotionApp.suspend());
 if(!await page.locator('#pullup-video').evaluate(v=>v.paused))throw Error('Background playback did not stop');
 for(const size of [{width:740,height:320},{width:568,height:280},{width:390,height:844},{width:320,height:568}]){
  await page.setViewportSize(size);const r=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,w:innerWidth,h:innerHeight,bottom:document.getElementById('pullup-play').getBoundingClientRect().bottom}));if(r.sw>r.w+1||r.w>r.h&&(r.sh>r.h+1||r.bottom>r.h+1))throw Error('Layout overflow '+JSON.stringify(r));
  if(size.width===390)await page.screenshot({path:'mobile/screenshots/pullups-stream-portrait.png',fullPage:true});
 }
 await page.locator('#pullup-back').click();if(!await page.locator('#home').isVisible()||await page.locator('#pullup-video').getAttribute('src'))throw Error('Back/release failed');
 if(await page.evaluate(()=>localStorage.getItem('motion-history')!==null))throw Error('Demo entered personal history');
 if(errors.length||external.length||cached.length)throw Error(JSON.stringify({errors,external,cached}));
 const result={runs,checks:['full playback with real pose and trained classifier','classifier decisions after cycle only','blob video','no precomputed poses/results','pause/resume','seek resets','background pause','release on back','no history','portrait/landscape','offline'],errors,external,cached,date:new Date().toISOString()};fs.writeFileSync('mobile/tests/pullups-model-result.json',JSON.stringify(result,null,2));console.log('PASS');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
