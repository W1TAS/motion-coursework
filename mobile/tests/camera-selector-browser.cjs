const {createRequire}=require('node:module');const fs=require('fs');const {installFakePhoneCameras}=require('./fake-cameras.cjs');
const req=createRequire('/home/w1tas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');const {chromium}=req('./index.js');
(async()=>{const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});try{
 const context=await browser.newContext({viewport:{width:390,height:844},permissions:['camera']});await installFakePhoneCameras(context);const p=await context.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.goto('http://127.0.0.1:8770/');await p.locator('[data-exercise="pushups"]').click();
 if(await p.locator('[data-facing="user"]').getAttribute('aria-pressed')!=='true')throw Error('Front is not default');
 await p.locator('#start').click();await p.waitForFunction(()=>document.getElementById('fps').textContent.length>0,null,{timeout:55000});
 if(await p.locator('#camera-selection').textContent()!=='Используется фронтальная камера')throw Error('Wrong actual front label');
 if(!await p.locator('#video').evaluate(v=>v.classList.contains('mirror'))||!await p.locator('#overlay').evaluate(v=>v.classList.contains('mirror')))throw Error('Front video/overlay not mirrored together');
 await p.waitForFunction(()=>document.querySelector('.feedback').dataset.state==='warning');
 if(!await p.locator('#feedback-title').textContent()||Number(await p.locator('#metric').textContent())!==0)throw Error('Missing-pose feedback inaccurate');
 await p.screenshot({path:'mobile/screenshots/front-selection.png',fullPage:true});
 await p.locator('[data-facing="environment"]').click();await p.waitForFunction(()=>document.getElementById('camera-selection').textContent==='Используется задняя камера'&&document.getElementById('fps').textContent.length>0,null,{timeout:55000});
 if(await p.locator('#video').evaluate(v=>v.classList.contains('mirror')))throw Error('Back camera mirrored');
 const tracks=await p.evaluate(()=>window.cameraTestTracks.map(t=>t.readyState));if(tracks[0]!=='ended'||tracks.at(-1)!=='live')throw Error('Old stream not released');
 if(JSON.stringify(await p.evaluate(()=>window.cameraTestRequests))!==JSON.stringify(['user','environment']))throw Error('Unexpected camera requests');
 await p.locator('#start').click();await p.reload();await p.locator('[data-exercise="pushups"]').click();if(await p.locator('[data-facing="environment"]').getAttribute('aria-pressed')!=='true')throw Error('Choice not remembered');
 await p.locator('[data-facing="user"]').click();await p.evaluate(()=>window.cameraTestUnavailable='user');await p.locator('#start').click();await p.waitForFunction(()=>document.getElementById('mode-badge').textContent==='КАМЕРА НЕДОСТУПНА');if(!(await p.locator('#feedback').textContent()).includes('Фронтальная камера недоступна'))throw Error('Missing front not explained');if((await p.evaluate(()=>window.cameraTestRequests.length))!==1)throw Error('Silently fell back to back camera');
 for(const size of [{width:320,height:700},{width:844,height:390}]){await p.setViewportSize(size);if(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Horizontal overflow');}
 const result={default:'front',switch:'front -> back, old stream ended',mirroring:'front video and skeleton only',preference:'persists after reload',unavailable:'explained without silently opening back',missingPose:'warning, count zero',errors,date:new Date().toISOString()};fs.writeFileSync('mobile/tests/camera-selector-result.json',JSON.stringify(result,null,2));console.log(result);if(errors.length)throw Error(errors.join());
 }finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
