import fs from 'node:fs';import zlib from 'node:zlib';
import {criterionFeatures} from './criterion-features.mjs';
const base='pullups/dataset_mediapipe_gpu/human-reviews',dir=base+'/pose-comparison';
const reviews=JSON.parse(fs.readFileSync(base+'/criterion-labels.json'));
const median=a=>{const s=a.slice().sort((x,y)=>x-y);return(s[Math.floor((s.length-1)/2)]+s[Math.ceil((s.length-1)/2)])/2;};
function worldElbows(frame){
 const p=frame.worldLandmarks,q=frame.landmarks;
 if(!p||!q)return null;
 const elbows=[];
 for(const[s,e,w]of [[11,13,15],[12,14,16]]){
  if(![s,e,w].every(i=>Math.min(q[i].visibility??0,q[i].presence??1)>=.45&&['x','y','z'].every(k=>Number.isFinite(p[i][k]))))return null;
  const u=['x','y','z'].map(k=>p[s][k]-p[e][k]),v=['x','y','z'].map(k=>p[w][k]-p[e][k]);
  const den=Math.hypot(...u)*Math.hypot(...v);if(den<1e-6)return null;
  elbows.push(Math.acos(Math.max(-1,Math.min(1,u.reduce((n,x,i)=>n+x*v[i],0)/den)))*180/Math.PI);
 }
 return elbows;
}
const rows=[];
for(const r of reviews.rows.filter(r=>r.attempt==='attempt'&&r.ready_for_phase_features.bottom_incomplete)){
 const row={uid:r.uid,group:r.group,label:r.targets.bottom_incomplete,measurements:{}};
 for(const variant of ['lite','full']){
  const c=JSON.parse(zlib.gunzipSync(fs.readFileSync(dir+'/'+r.uid.replaceAll(':','_')+'-'+variant+'.json.gz')));
  const frames=c.frames,local=frames.filter(f=>Math.abs(f.now/1000-r.phase_times.bottom)<=.12+1e-6);
  const x=criterionFeatures(frames,r).bottom_incomplete;
  row.measurements[variant+'_2d']={angle:x.status==='available'?x.features[0]:null,quality:x.quality};
  const world=local.map(worldElbows).filter(Boolean),covered=local.length>=3&&local[0].now/1000<=r.phase_times.bottom+.04&&local.at(-1).now/1000>=r.phase_times.bottom-.04;
  row.measurements[variant+'_3d']={angle:covered&&world.length>=3&&world.length/local.length>=.8?median(world.map(a=>(a[0]+a[1])/2)):null,left:world.length?median(world.map(a=>a[0])):null,right:world.length?median(world.map(a=>a[1])):null};
  row.measurements[variant+'_2d'].inferenceMsMedian=median(frames.map(f=>f.inferenceMs));
 }
 rows.push(row);
}
const metrics={};
for(const name of ['lite_2d','full_2d','lite_3d','full_3d']){
 const m={tp:0,fp:0,tn:0,fn:0,unavailable:0};
 for(const r of rows){const a=r.measurements[name].angle;if(a===null){m.unavailable++;continue;}const pred=a<150;m[r.label?(pred?'tp':'fn'):(pred?'fp':'tn')]++;}
 metrics[name]=m;
}
fs.writeFileSync(dir+'/comparison.json',JSON.stringify({threshold:150,protocol:'Fixed existing extension threshold; identical frames and CPU settings. Human-marked initial bottom ±120ms; mean of both arms. Exploratory nine-development-source comparison, NOT a fresh test. World coordinates are inferred. No parameter tuning.',metrics,rows},null,2));
console.log(metrics);for(const r of rows)console.log(r.uid,r.label,Object.fromEntries(Object.entries(r.measurements).map(([k,v])=>[k,v.angle?.toFixed(1)??null])));
