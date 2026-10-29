// Re-extract the SAME source frames with Lite/Full and retain metric world poses.
// Separate research caches: never overwrite training poses or application assets.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),zlib=require('node:zlib'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'../..'),base=path.join(root,'pullups/dataset_mediapipe_gpu');
const expanded=process.argv.includes('--expanded'),stream=expanded||process.argv.includes('--stream');
const out=path.join(base,'human-reviews',expanded?'expanded-3d/poses':stream?'pose-comparison-stream':'pose-comparison'),temp=path.join(out,'frames');
const req=createRequire('/home/w1tas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json');
const {chromium}=req('./index.js');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const worker=`import {FilesetResolver,PoseLandmarker} from '/app/vendor/vision_bundle.mjs';
let model;self.import=async url=>{self.ModuleFactory=(await import(url)).default;};
self.onmessage=async({data})=>{try{if(data.type==='init'){
const files=await FilesetResolver.forVisionTasks(new URL('/app/vendor/wasm',self.location).href,true);
model=await PoseLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:data.model,delegate:'CPU'},runningMode:'VIDEO',numPoses:1,minPoseDetectionConfidence:.6,minPosePresenceConfidence:.6,minTrackingConfidence:.6});self.postMessage({type:'ready'});
}else{const response=await fetch(data.url);if(!response.ok)throw Error('Frame unavailable');const bitmap=await createImageBitmap(await response.blob());
try{const begin=performance.now(),r=model.detectForVideo(bitmap,data.now);self.postMessage({type:'pose',now:data.now,width:bitmap.width,height:bitmap.height,landmarks:r.landmarks[0]??null,worldLandmarks:r.worldLandmarks[0]??null,inferenceMs:performance.now()-begin});}finally{bitmap.close();}}
}catch(e){self.postMessage({type:'error',message:String(e)});}};`;
let server,browser;
(async()=>{
 fs.mkdirSync(out,{recursive:true});fs.mkdirSync(temp,{recursive:true});
 const reviews=JSON.parse(fs.readFileSync(path.join(base,'human-reviews/criterion-labels.json')));
 const manifest=JSON.parse(fs.readFileSync(path.join(base,'manifest.json')));
 const models={lite:path.join(root,'mobile/app/vendor/pose_landmarker_lite.task'),full:path.join(root,'pullups/research_models/pose_landmarker_full.task')};
 const modelHashes=Object.fromEntries(Object.entries(models).map(([k,v])=>[k,sha(fs.readFileSync(v))]));
 const selection=expanded?JSON.parse(fs.readFileSync(path.join(base,'human-reviews/expanded-3d/selection.json'))):null;
 const jobs=expanded?selection.jobs.map(({sample,group,...job})=>job):reviews.rows.filter(r=>r.attempt==='attempt'&&r.ready_for_phase_features.bottom_incomplete).map(r=>{
  const job=manifest.jobs.find(j=>j.samples.some(s=>s.uid===r.uid));
  if(!job||job.samples.some(s=>s.split==='test'))throw Error('Unexpected test/unknown source');
  return {uid:r.uid,video:job.video,sourceFingerprint:job.fingerprint,start:Math.max(0,r.phase_times.bottom-(stream?2:1)),end:stream?r.phase_times.return+.8:r.phase_times.top+.16,fps:25};
 });
 server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;let file;
  if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<title>Pose comparison</title>');return;}
  if(pathname==='/worker.mjs'){res.setHeader('Content-Type','application/javascript');res.end(worker);return;}
  if(pathname.startsWith('/app/vendor/')&&!pathname.includes('%')&&!pathname.includes('..'))file=path.join(root,'mobile',pathname);
  if(/^\/frames\/\d+\.jpg$/.test(pathname))file=path.join(temp,path.basename(pathname));
  if(pathname==='/full.task')file=models.full;
  if(!file||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
  res.setHeader('Content-Type',({'.mjs':'application/javascript','.js':'application/javascript','.wasm':'application/wasm','.jpg':'image/jpeg'})[path.extname(file)]||'application/octet-stream');
  res.setHeader('Cache-Control','no-store');fs.createReadStream(file).pipe(res);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']});
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
 for(const [index,job]of jobs.entries()){
  const source=fs.statSync(job.video);const identity={...job,sourceBytes:source.size,sourceMtime:source.mtimeMs,workerHash:sha(worker)};
  let names;
  for(const variant of stream?['lite']:['lite','full']){
   const fingerprint=sha(JSON.stringify({...identity,model:modelHashes[variant]}));
   const dest=path.join(out,job.uid.replaceAll(':','_')+'-'+variant+'.json.gz');
   if(fs.existsSync(dest)){if(JSON.parse(zlib.gunzipSync(fs.readFileSync(dest))).fingerprint!==fingerprint)throw Error('Stale comparison cache');continue;}
   if(!names){
    for(const n of fs.readdirSync(temp))fs.unlinkSync(path.join(temp,n));
    execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-threads','2','-ss',String(job.start),'-i',job.video,'-t',String(job.end-job.start),'-vf','fps=25,scale=-2:640','-threads','2','-q:v','3',path.join(temp,'%06d.jpg')]);
    names=fs.readdirSync(temp).filter(n=>n.endsWith('.jpg')).sort();
   }
   const frames=await page.evaluate(async({job,names,variant})=>{
    const w=new Worker('/worker.mjs',{type:'module'});
    const call=data=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Inference timeout')),60000);w.onmessage=e=>{clearTimeout(timer);e.data.type==='error'?reject(Error(e.data.message)):resolve(e.data);};w.onerror=e=>{clearTimeout(timer);reject(Error(e.message));};w.postMessage(data);});
    try{await call({type:'init',model:variant==='full'?'/full.task':'/app/vendor/pose_landmarker_lite.task'});const frames=[];
     for(let i=0;i<names.length;i++)frames.push(await call({type:'frame',url:'/frames/'+names[i],now:(job.start+i/job.fps)*1000}));return frames;
    }finally{w.terminate();}
   },{job,names,variant});
   fs.writeFileSync(dest,zlib.gzipSync(JSON.stringify({fingerprint,identity,variant,modelHash:modelHashes[variant],delegate:'CPU',frames})));
   console.log(`${index+1}/${jobs.length} ${variant} ${job.uid}: ${frames.length} frames`);
  }
 }
 fs.writeFileSync(path.join(out,'provenance.json'),JSON.stringify({modelHashes,fullModelUrl:'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',jobs,reviewHash:sha(JSON.stringify(reviews)),note:'Development only; identical decoded frames, CPU delegate, same tracking thresholds. Models reset before the marked bottom; exact context is recorded in jobs.start/end. World coordinates are inferred, not measured depth.'},null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await browser?.close();if(server)await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});});
