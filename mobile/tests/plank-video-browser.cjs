const {createRequire}=require('node:module'),fs=require('node:fs');
const req=createRequire('/home/w1tas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');const {chromium}=req('./index.js');
(async()=>{const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']});try{
 const page=await browser.newPage({viewport:{width:844,height:390}}),errors=[],external=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith('http://127.0.0.1:8770/')&&!r.url().startsWith('blob:'))external.push(r.url());});
 await page.goto('http://127.0.0.1:8770/');await page.locator('[data-exercise="plank"]').click();await page.locator('#help-open').click();await page.locator('#video-example').click();
 await page.waitForFunction(()=>Number(document.getElementById('metric').textContent)>2,null,{timeout:50000});
 await page.screenshot({path:'mobile/screenshots/plank-video-landscape.png',fullPage:true});
 const before=Number(await page.locator('#metric').textContent());await page.setViewportSize({width:390,height:844});await page.waitForFunction(n=>Number(document.getElementById('metric').textContent)>n,before);await page.setViewportSize({width:844,height:390});
 await page.waitForFunction(()=>!document.getElementById('summary').hidden,null,{timeout:25000});
 const summary=await page.locator('#summary').textContent(),seconds=parseFloat(summary);
 if(seconds<9||seconds>11.5)throw Error('Unexpected plank duration: '+summary);
 if(await page.evaluate(()=>localStorage.getItem('motion-history')!==null))throw Error('Example leaked into history');
 if(errors.length||external.length)throw Error(JSON.stringify({errors,external}));
 const result={summary,seconds,errors,external,date:new Date().toISOString(),scope:'Development demonstration, not accuracy estimate'};
 fs.writeFileSync('mobile/tests/plank-video-browser-result.json',JSON.stringify(result,null,2));console.log(result);
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
