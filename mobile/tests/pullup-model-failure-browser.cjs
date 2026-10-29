const {createRequire}=require('node:module'),fs=require('node:fs');const req=createRequire('/home/w1tas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');const {chromium}=req('./index.js');
(async()=>{const b=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']});try{
 const p=await b.newPage();await p.addInitScript(()=>{const Original=window.Worker;window.Worker=class extends Original{constructor(url,options){super(url,options);if(String(url).includes('pullup-classifier-worker'))window.classifierTest=this;}};});
 await p.goto('http://127.0.0.1:8770/');await p.locator('#open-pullups').click();await p.waitForFunction(()=>document.getElementById('pullups').dataset.mode==='ready',null,{timeout:60000});await p.locator('#pullup-play').click();
 await p.evaluate(()=>window.classifierTest.dispatchEvent(new Event('error')));
 await p.waitForFunction(()=>Number(document.getElementById('pullup-count').textContent)>0,null,{timeout:25000});
 if(!(await p.locator('#pullup-results').textContent()).includes('Модель недоступна'))throw Error('Classifier failure silently became a pending/successful decision');
 if(await p.locator('#pullups').getAttribute('data-mode')!=='running')throw Error('Classifier failure stopped video');
 await p.locator('#pullup-select').selectOption('example-3');await p.waitForFunction(()=>document.getElementById('pullups').dataset.mode==='ready'&&document.getElementById('pullups').dataset.model==='ready',null,{timeout:60000});
 fs.writeFileSync('mobile/tests/pullup-model-failure-result.json',JSON.stringify({classifierFailure:'visible, video and counter continue',newSource:'model recovers',date:new Date().toISOString()},null,2));console.log('Failure handling PASS');
}finally{await b.close();}})().catch(e=>{console.error(e);process.exit(1)});
