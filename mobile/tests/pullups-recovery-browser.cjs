const {createRequire}=require('node:module'),fs=require('node:fs');
const req=createRequire('/home/w1tas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');const {chromium}=req('./index.js');
(async()=>{const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']});try{
 const page=await browser.newPage({viewport:{width:844,height:390}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{const original=HTMLVideoElement.prototype.requestVideoFrameCallback;if(original)HTMLVideoElement.prototype.requestVideoFrameCallback=function(callback){return original.call(this,(now,metadata)=>{if(!window.freezeDecoded)callback(now,metadata);});};});
 await page.goto('http://127.0.0.1:8770/');await page.locator('#open-pullups').click();await page.waitForFunction(()=>document.getElementById('pullups').dataset.mode==='ready',null,{timeout:60000});
 await page.locator('#pullup-play').click();await page.waitForFunction(()=>document.getElementById('pullup-video').currentTime>1);
 // Simulate a decoded stream that stops advancing while the page stays responsive.
 await page.locator('#pullup-video').evaluate(v=>v.playbackRate=0);
 await page.waitForFunction(()=>document.getElementById('pullups').dataset.mode==='stalled',null,{timeout:13000});
 const stopped=await page.locator('#pullup-video').evaluate(v=>v.currentTime),oldURL=await page.locator('#pullup-video').getAttribute('src');
 await page.locator('#pullup-video').evaluate(v=>v.playbackRate=1);await page.locator('#pullup-play').click();
 await page.waitForFunction(t=>document.getElementById('pullups').dataset.mode==='running'&&document.getElementById('pullup-video').currentTime>t+.5,stopped,{timeout:60000});
 if(await page.locator('#pullup-video').getAttribute('src')===oldURL)throw Error('Decoder was not reloaded');
 const beforeFrozen=await page.locator('#pullup-video').evaluate(v=>v.currentTime);await page.evaluate(()=>window.freezeDecoded=true);
 await page.waitForFunction(()=>document.getElementById('pullups').dataset.mode==='stalled',null,{timeout:13000});
 if(await page.locator('#pullup-video').evaluate(v=>v.currentTime)<beforeFrozen+5)throw Error('Decoded-frame test also froze timeline');
 await page.evaluate(()=>window.freezeDecoded=false);await page.locator('#pullup-play').click();await page.waitForFunction(()=>document.getElementById('pullups').dataset.mode==='running',null,{timeout:60000});
 await page.locator('#pullup-play').click();await page.locator('#pullup-restart').click();
 if(await page.locator('#pullup-count').textContent()!=='0')throw Error('Restart count not zero');
 await page.waitForFunction(()=>document.getElementById('pullup-video').currentTime<.1);
 // Cancel source loading twice; stale work must not overwrite the final selection.
 await page.locator('#pullup-select').selectOption('example-2');await page.locator('#pullup-select').selectOption('example-3');await page.locator('#pullup-back').click();
 await page.waitForTimeout(500);if(!await page.locator('#home').isVisible())throw Error('Stale load reopened playback');
 await page.locator('#open-pullups').click();await page.waitForFunction(()=>document.getElementById('pullups').dataset.mode==='ready',null,{timeout:60000});
 if(await page.locator('#pullup-count').textContent()!=='0')throw Error('Old results persisted after close');
 if(errors.length)throw Error(errors.join('\n'));
 fs.writeFileSync('mobile/tests/pullups-recovery-result.json',JSON.stringify({checks:['8-second stall detection','missing decoded frames despite advancing timeline','decoder reload at stopped position','play/pause after recovery','restart resets','cancel source loading','close/reopen without stale updates'],errors,date:new Date().toISOString()},null,2));console.log('Recovery PASS');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
