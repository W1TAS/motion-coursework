// Synthetic UI answers are written to /tmp only; never to training annotations.
const {createRequire}=require('node:module'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const req=createRequire('/home/w1tas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=req('./index.js');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 try{
  const context=await browser.newContext({viewport:{width:1100,height:900},acceptDownloads:true});
  const page=await context.newPage(),errors=[],external=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))external.push(r.url());});
  await page.goto(pathToFileURL(path.resolve('pullups/dataset_mediapipe_gpu/criteria-review-02/index.html')).href);
  const queue=JSON.parse(fs.readFileSync('pullups/dataset_mediapipe_gpu/human-reviews/review-02-selection.json'));
  for(let i=0;i<12;i++){
   const item=queue.items[i];await page.waitForFunction(()=>document.getElementById('video').readyState>=2);
   if(await page.locator('#show-pose').isChecked())throw Error('Skeleton must be hidden initially');
   if(await page.locator('#count').textContent()!==`${i+1} / 12`)throw Error('Wrong item index');
   await page.locator('#replay').click();await page.waitForFunction(t=>document.getElementById('video').currentTime>t+.12,item.windowStart);await page.locator('#video').evaluate(v=>v.pause());
   for(const [id,value]of [['attempt',i===4?'exaggerated_error_demo':'attempt'],['bottom_incomplete','0'],['top_below_bar','unknown'],['swing_ascent','0']])await page.locator('#'+id).selectOption(value);
   if(!(await page.locator('#status').textContent()).includes('Для каждого положения'))throw Error('Missing phase decisions accepted');
   const seek=async t=>{await page.locator('#video').evaluate((v,t)=>{v.currentTime=t},t);await page.waitForFunction(()=>!document.getElementById('video').seeking);};
   for(const [k,t]of [['bottom',item.windowStart],['top',(item.windowStart+item.windowEnd)/2],['return',item.windowEnd]]){await seek(t);await page.locator(`[data-phase="${k}"]`).click();}
   if(!(await page.locator('#status').textContent()).startsWith(`Готово ${i+1} из 12.`))throw Error('Completed phases not recorded');
   if(i===0){
    await seek(item.windowStart);await page.locator('[data-phase="top"]').click();
    if(!(await page.locator('#status').textContent()).includes('Порядок кадров'))throw Error('Unordered phases accepted');
    await seek((item.windowStart+item.windowEnd)/2);await page.locator('[data-phase="top"]').click();
    await page.locator('#pose-panel summary').click();await page.locator('#show-pose').check();
    if(await page.locator('#overlay').isHidden())throw Error('Overlay toggle did not work');
    if(await page.locator('#top_below_bar').inputValue()!=='unknown')throw Error('Pose inspection changed ground truth');
    await page.locator('#pose-quality').selectOption('unstable');
    await page.screenshot({path:'/tmp/criterion-review-desktop.png',fullPage:true});
   }
   if(i<11)await page.locator('#next').click();
  }
  const downloadPromise=page.waitForEvent('download');await page.locator('#save').click();const download=await downloadPromise;
  const output='/tmp/criterion-review-SYNTHETIC-test-answers.json';await download.saveAs(output);
  const data=JSON.parse(fs.readFileSync(output));if(data.schema!==2||Object.keys(data.answers).length!==12||Object.values(data.answers).some(a=>!a.complete))throw Error('Export incomplete');
  await page.reload();if(await page.locator('#count').textContent()!=='12 / 12')throw Error('Progress not restored');
  await page.setViewportSize({width:390,height:844});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile horizontal overflow');
  await page.screenshot({path:'/tmp/criterion-review-mobile.png',fullPage:true});
  if(errors.length||external.length)throw Error(JSON.stringify({errors,external}));
  fs.writeFileSync('mobile/tests/criterion-review-browser-result.json',JSON.stringify({syntheticAnswers:true,clips:12,checks:['offline file playback','frame annotations','invalid order rejection','separate skeleton inspection','JSON export','progress persistence','mobile width'],errors,external,date:new Date().toISOString()},null,2));
  console.log('Criterion review browser PASS');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
