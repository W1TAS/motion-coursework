const {installFakePhoneCameras}=require('./fake-cameras.cjs');
const {createRequire}=require('node:module');const fs=require('fs');
const req=createRequire('/home/w1tas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');const {chromium}=req('./index.js');
(async()=>{
 const kind=process.argv[2]??'new';
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--enable-unsafe-swiftshader']});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},permissions:['camera']});const requests=[],errors=[];
  await context.route('https://appassets.androidplatform.net/**',async route=>{
   const url=new URL(route.request().url());const path=url.pathname;
   const range=route.request().headers().range;
   const response=await fetch('http://127.0.0.1:8771/'+kind+path,{headers:range?{Range:range}:{}});
   requests.push({path,status:response.status});
   const headers={'X-Content-Type-Options':'nosniff'};for(const key of ['content-range','accept-ranges','content-length'])if(response.headers.has(key))headers[key]=response.headers.get(key);
   await route.fulfill({status:response.status,contentType:response.headers.get('content-type')??'application/octet-stream',headers,body:Buffer.from(await response.arrayBuffer())});
  });
  await installFakePhoneCameras(context);const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto('https://appassets.androidplatform.net/assets/index.html');
  await page.locator('[data-exercise="pushups"]').click();await page.locator('#start').click();
  await page.waitForFunction(()=>['КАМЕРА · НА УСТРОЙСТВЕ','КАМЕРА НЕДОСТУПНА'].includes(document.getElementById('mode-badge').textContent),null,{timeout:55000});
  const status=await page.locator('#mode-badge').textContent(),message=await page.locator('#feedback').textContent();
  if(kind==='old'){
   if(status!=='КАМЕРА НЕДОСТУПНА'||!message.includes('Failed to fetch dynamically imported module')||!requests.some(r=>r.path.includes('/wasm//')&&r.status===404))throw Error('Old failure was not reproduced');
  }else{
   if(status!=='КАМЕРА · НА УСТРОЙСТВЕ')throw Error('Model failed: '+message);
   await page.waitForFunction(()=>document.getElementById('fps').textContent.length>0,null,{timeout:15000});
   for(const suffix of ['vision_wasm_module_internal.js','vision_wasm_module_internal.wasm','pose_landmarker_lite.task'])if(!requests.some(r=>r.path.endsWith(suffix)&&r.status===200))throw Error('Missing APK resource '+suffix);
   if(requests.some(r=>r.path.includes('//')||r.status!==200)||errors.length)throw Error('Bad APK request or script error');
   await page.locator('#start').click();if(await page.locator('#video').evaluate(v=>v.srcObject!==null))throw Error('Camera not released');
   await page.locator('#back').click();await page.locator('#open-pullups').click();
   await page.waitForFunction(()=>document.getElementById('pullups').dataset.mode==='ready',null,{timeout:60000});
   for(const id of ['example-1','example-2','example-3']){
    if(id!=='example-1'){await page.locator('#pullup-select').selectOption(id);await page.waitForFunction(()=>document.getElementById('pullups').dataset.mode==='ready',null,{timeout:60000});}
    if(!(await page.locator('#pullup-video').getAttribute('src')).startsWith('blob:'))throw Error('APK video not loaded as Blob');
    await page.locator('#pullup-play').click();
    await page.waitForFunction(()=>Number(document.getElementById('pullups').dataset.frames)>20);
    if(id==='example-1'){
     await page.waitForFunction(()=>document.getElementById('pullups').dataset.mode==='ended',null,{timeout:45000});
     if(Number(await page.locator('#pullup-count').textContent())<1)throw Error('APK pullup stream never counted');
     await page.waitForFunction(()=>Number(document.getElementById('pullups').dataset.modelDecisions)>0);
     if(await page.locator('[data-model-target]').count()!==2)throw Error('APK classifier outputs missing');
     for(const suffix of ['pullup-classifier-worker.mjs','pullup-model.mjs','models/pullup-hgb.json'])if(!requests.some(r=>r.path.endsWith(suffix)&&r.status===200))throw Error('Missing classifier resource '+suffix);
    }else await page.locator('#pullup-play').click();
   }
   if(requests.some(r=>/example-\d\.json/.test(r.path)))throw Error('APK read precomputed analysis');
   if(requests.some(r=>![200,206].includes(r.status))||errors.length)throw Error('Archive APK resource failed');
  }
  const result={kind,status,message,requests,errors,date:new Date().toISOString()};fs.writeFileSync('mobile/tests/apk-'+kind+'-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
