// Reproducible offline replay through the exact Worker bundled in the Android app.
const {createRequire}=require('node:module'),fs=require('node:fs');
const req=createRequire('/home/w1tas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=req('./index.js');
(async()=>{const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']});
try{const page=await browser.newPage();await page.goto('http://127.0.0.1:8772/app/');
for(const id of process.argv.slice(2)){
 const names=fs.readdirSync(`mobile/research/frames/${id}`).filter(s=>s.endsWith('.jpg')).sort();
 const frames=await page.evaluate(async ({id,names})=>{
  const worker=new Worker('/app/pose-worker.mjs',{type:'module'});
  function call(data,transfer=[]){return new Promise((ok,no)=>{worker.onmessage=({data})=>data.type==='error'?no(Error(data.message)):ok(data);worker.onerror=no;worker.postMessage(data,transfer);});}
  await call({type:'init'});const out=[];
  try{for(let i=0;i<names.length;i++){
   const blob=await (await fetch(`/research/frames/${id}/${names[i]}`)).blob();
   const bitmap=await createImageBitmap(blob);out.push(await call({type:'frame',bitmap,now:i*100,width:bitmap.width,height:bitmap.height},[bitmap]));
  }}finally{worker.terminate();}return out;
 },{id,names});
 fs.writeFileSync(`mobile/research/poses/${id}.json`,JSON.stringify(frames));console.log(id,frames.length,'frames');
}
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
