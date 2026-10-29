const {createRequire}=require('node:module'),fs=require('node:fs');
const req=createRequire('/home/w1tas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');const {chromium}=req('./index.js');
(async()=>{const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']});try{
 const page=await browser.newPage({viewport:{width:844,height:390}}),errors=[],results=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8770/');await page.screenshot({path:'mobile/screenshots/home-landscape.png'});await page.locator('[data-exercise="plank"]').click();
 async function layout(label){
  const r=await page.evaluate(()=>{const ids=['camera','metric','start','finish','help-open','back'];return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,rects:Object.fromEntries(ids.map(id=>{const b=document.getElementById(id).getBoundingClientRect();return [id,{x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom}];}))};});
  if(r.scrollWidth>r.width+1)throw Error('Horizontal overflow '+label);
  if(r.width>r.height){if(r.scrollHeight>r.height+1)throw Error('Landscape scroll '+label+JSON.stringify(r));for(const [id,b] of Object.entries(r.rects))if(b.bottom>r.height+1||b.right>r.width+1||b.x<0||b.y<0)throw Error('Offscreen '+id+' '+label);if(r.rects.camera.right>r.rects.start.x)throw Error('Camera/control overlap');}
  for(const id of ['start','finish','help-open','back'])if(r.rects[id].height<44)throw Error('Small touch target '+id);
  results.push({label,...r});
 }
 for(const size of [{width:844,height:390},{width:740,height:320},{width:640,height:360},{width:568,height:280},{width:390,height:844},{width:320,height:568}]){
  await page.setViewportSize(size);await layout('idle');
  if(size.width===844||size.width===390)await page.screenshot({path:`mobile/screenshots/workout-${size.width>size.height?'landscape':'portrait'}.png`,fullPage:true});
 }
 await page.setViewportSize({width:740,height:320});await page.locator('#help-open').click();
 if(!await page.locator('#help-dialog').evaluate(d=>d.open))throw Error('Help did not open');
 await page.locator('#example').click();if(await page.locator('#help-dialog').evaluate(d=>d.open))throw Error('Help blocks example');
 await page.waitForFunction(()=>Number(document.getElementById('metric').textContent)>1);await layout('running');
 await page.setViewportSize({width:568,height:280});await page.evaluate(()=>{document.getElementById('feedback').textContent='Для запуска анализа разрешите доступ к выбранной камере в настройках Android, затем вернитесь в приложение и попробуйте ещё раз.';});await layout('long-warning');
 const before=Number(await page.locator('#metric').textContent());await page.setViewportSize({width:390,height:844});await page.waitForFunction(n=>Number(document.getElementById('metric').textContent)>n,before);await page.setViewportSize({width:844,height:390});await layout('rotated');
 await page.locator('#finish').click();await layout('finished');await page.screenshot({path:'mobile/screenshots/summary-landscape.png'});
 await page.locator('#help-open').click();await page.keyboard.press('Escape');if(await page.locator('#help-dialog').evaluate(d=>d.open))throw Error('Escape cannot close help');
 await page.locator('#back').click();if(await page.evaluate(()=>document.body.classList.contains('workout-open')))throw Error('Workout layout leaked home');
 if(errors.length)throw Error(errors.join());fs.writeFileSync('mobile/tests/layout-browser-result.json',JSON.stringify({results,errors,date:new Date().toISOString()},null,2));console.log('Layout, touch targets, help, rotation, finish: passed',results.map(r=>[r.label,r.width,r.height]));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
