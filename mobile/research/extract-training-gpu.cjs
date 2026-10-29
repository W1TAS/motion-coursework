// Uses the app model and feature code with an explicit GPU delegate override. One segment at a time;
// temporary JPEGs are removed, gzip pose caches and feature rows are resumable.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const zlib=require('node:zlib'),crypto=require('node:crypto');
const {spawn}=require('node:child_process'),{createRequire}=require('node:module');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..'),out=path.resolve(process.argv[2]);
const req=createRequire(process.env.PLAYWRIGHT_PACKAGE||'/home/w1tas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=req('./index.js');
const atomic=(file,data)=>{fs.writeFileSync(file+'.tmp',data);fs.renameSync(file+'.tmp',file);};
let browser,server,ffmpeg,stopping=false;
process.on('SIGTERM',()=>{stopping=true;ffmpeg?.kill('SIGTERM');void browser?.close();});
process.on('SIGINT',()=>process.emit('SIGTERM'));
async function decode(job,dir){
 fs.rmSync(dir,{recursive:true,force:true});fs.mkdirSync(dir,{recursive:true});
 await new Promise((ok,no)=>{
  ffmpeg=spawn('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-threads','2',
   '-ss',String(job.start),'-i',job.video,'-t',String(job.end-job.start),
   '-vf',`fps=${job.fps},scale=-2:640`,'-threads','2','-q:v','3',path.join(dir,'%06d.jpg')]);
  let error='';ffmpeg.stderr.on('data',d=>{error=(error+d).slice(-4000);});
  ffmpeg.on('error',no);ffmpeg.on('close',c=>{ffmpeg=null;c===0?ok():no(Error(`ffmpeg ${job.id}: ${error}`));});
 });
 return fs.readdirSync(dir).filter(n=>n.endsWith('.jpg')).sort();
}
(async()=>{
 const {mapFrame,extractModelFeatures}=await import(pathToFileURL(path.join(root,'mobile/app/pullup-model.mjs')));
 const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'))),began=Date.now();
 const cache=path.join(out,'poses'),temp=path.join(out,'temporary-frames');fs.mkdirSync(cache,{recursive:true});
 let framesTotal=0,done=0;const rows=[];
 // Serve only local app assets and the current segment's temporary frames.
 server=http.createServer((request,response)=>{
  const url=new URL(request.url,'http://localhost'),parts=url.pathname.split('/').filter(Boolean);
  let file;
  if(url.pathname==='/'){response.writeHead(200,{'Content-Type':'text/html'});response.end('<!doctype html><title>Offline pose extraction</title>');return;}
  if(parts.some(p=>p==='..'||p.includes('%'))){response.writeHead(400).end();return;}
  if(parts[0]==='app')file=path.join(root,'mobile',...parts);
  if(parts[0]==='frames'&&parts.length===2&&/^\d+\.jpg$/.test(parts[1]))file=path.join(temp,parts[1]);
  if(url.pathname==='/app/pose-worker.mjs'){
   const source=fs.readFileSync(path.join(root,'mobile/app/pose-worker.mjs'),'utf8');
   if(source.split("delegate:'CPU'").length!==2){response.writeHead(500).end('Unexpected worker configuration');return;}
   response.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':'no-store'});
   // Decode in the inference worker to avoid transferring a GPU-backed bitmap
   // between threads. The original worker still owns detectForVideo and close().
   response.end(source.replace("delegate:'CPU'","delegate:'GPU'")+`
const originalHandler=self.onmessage;
self.onmessage=async({data})=>{
 if(data.type==='frame_url'){
  try{
   const response=await fetch(data.url);if(!response.ok)throw Error('Frame HTTP '+response.status);
   const bitmap=await createImageBitmap(await response.blob());
   await originalHandler({data:{type:'frame',bitmap,now:data.now,width:bitmap.width,height:bitmap.height}});
  }catch(error){self.postMessage({type:'error',message:String(error)});}
 }else await originalHandler({data});
};`);return;
  }
  if(!file||!fs.existsSync(file)||!fs.statSync(file).isFile()){response.writeHead(404).end();return;}
  const type={'.mjs':'application/javascript','.js':'application/javascript','.wasm':'application/wasm','.jpg':'image/jpeg'}[path.extname(file)]||'application/octet-stream';
  response.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});fs.createReadStream(file).pipe(response);
 });
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--enable-gpu','--use-gl=angle','--use-angle=gl','--ignore-gpu-blocklist'],env:{...process.env,__NV_PRIME_RENDER_OFFLOAD:'1',__GLX_VENDOR_LIBRARY_NAME:'nvidia',__EGL_VENDOR_LIBRARY_FILENAMES:'/usr/share/glvnd/egl_vendor.d/10_nvidia.json'}});
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
 const renderer=await page.evaluate(()=>{const gl=document.createElement('canvas').getContext('webgl2');if(!gl)return '';const ext=gl.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):'';});
 if(!renderer.includes('NVIDIA')||/SwiftShader|llvmpipe/i.test(renderer))throw Error('NVIDIA hardware WebGL unavailable: '+renderer);
 atomic(path.join(out,'hardware.json'),JSON.stringify({delegate:'GPU',renderer,updated:new Date().toISOString()}));
 console.log('GPU delegate:',renderer);
 await page.exposeFunction('extractionProgress',(id,frame,total)=>{
  atomic(path.join(out,'progress.json'),JSON.stringify({completedSegments:done,totalSegments:manifest.jobs.length,delegate:'GPU',currentSegment:id,currentFrame:frame,currentFrames:total,completedFrames:framesTotal,elapsedSeconds:(Date.now()-began)/1000,updated:new Date().toISOString()}));
 });
 for(const job of manifest.jobs){
  if(stopping)throw Error('Stopped');
  const dest=path.join(cache,job.id+'.json.gz');let cached;
  if(fs.existsSync(dest)){
   cached=JSON.parse(zlib.gunzipSync(fs.readFileSync(dest)));
   if(cached.fingerprint!==job.fingerprint)throw Error(`Stale cache ${job.id}; use a fresh output directory`);
  }else{
   const names=await decode(job,temp);
   if(names.length<4)throw Error(`Too few decoded frames: ${job.id}`);
   const frames=await page.evaluate(async({job,names})=>{
    const worker=new Worker('/app/pose-worker.mjs',{type:'module'});
    const call=(data,transfer=[])=>new Promise((resolve,reject)=>{
     const timer=setTimeout(()=>reject(Error('Pose worker timed out')),60000);
     worker.onmessage=({data})=>{clearTimeout(timer);data.type==='error'?reject(Error(data.message)):resolve(data);};
     worker.onerror=e=>{clearTimeout(timer);reject(Error(e.message));};worker.postMessage(data,transfer);
    });
    const result=[];
    try{
     await call({type:'init'});
     for(let i=0;i<names.length;i++){
      result.push(await call({type:'frame_url',url:'/frames/'+names[i],now:(job.start+i/job.fps)*1000}));
      if(i%100===0)await window.extractionProgress(job.id,i+1,names.length);
     }
    }finally{worker.terminate();}
    return result;
   },{job,names});
   cached={fingerprint:job.fingerprint,delegate:'GPU',renderer,frames};
   atomic(dest,zlib.gzipSync(JSON.stringify(cached)));
  }
  // Restore null JSON coordinates to NaN through mapFrame, not numeric coercion.
  const mapped=cached.frames.map(f=>mapFrame(f.landmarks,f.now,f.width,f.height));
  const previous=[];
  for(const sample of job.samples){
   const end=+sample.end,rep={sampleStart:+sample.start*1000,end:end*1000};
   const prefix=mapped.filter(f=>f.t<=end+1e-6&&f.t>=Math.max(job.start,end-60));
   const result=extractModelFeatures(prefix,rep,previous);
   if(result){previous.push(result.stats);if(previous.length>30)previous.shift();}
   rows.push({uid:sample.uid,delegate:cached.delegate??job.delegate??'CPU',features:result?.features??null,quality:result?.quality??null});
  }
  framesTotal+=cached.frames.length;done++;
  atomic(path.join(out,'features.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const progress={completedSegments:done,totalSegments:manifest.jobs.length,delegate:'GPU',completedFrames:framesTotal,featureRows:rows.length,elapsedSeconds:(Date.now()-began)/1000,updated:new Date().toISOString()};
  atomic(path.join(out,'progress.json'),JSON.stringify(progress));
  console.log(`[${done}/${manifest.jobs.length}] ${job.id}: ${cached.frames.length} frames; ${rows.length} labeled windows`,new Date().toISOString());
 }
 atomic(path.join(out,'extraction-complete.json'),JSON.stringify({segments:done,rows:rows.length,frames:framesTotal,manifestSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(out,'manifest.json'))).digest('hex')}));
})().catch(e=>{console.error(e);process.exitCode=stopping?130:1;}).finally(async()=>{
 ffmpeg?.kill('SIGTERM');await browser?.close();if(server)await new Promise(ok=>server.close(ok));
 fs.rmSync(path.join(out,'temporary-frames'),{recursive:true,force:true});
});
