import fs from 'node:fs';import zlib from 'node:zlib';
import {PullupEngine} from '../app/pullup-engine.mjs';
import {PullupPhaseEngine} from '../app/pullup-phases.mjs';
const dir='pullups/dataset_mediapipe_gpu',manifest=JSON.parse(fs.readFileSync(dir+'/manifest.json'));
const split=process.argv.includes('--test')?'test':'development';
const runs=[];
function match(cycles,labels){
 const pairs=[];cycles.forEach((c,i)=>labels.forEach((s,j)=>{
  const a=c.sampleStart/1000,b=c.end/1000,x=+s.start,y=+s.end;
  const overlap=Math.max(0,Math.min(b,y)-Math.max(a,x))/(Math.max(b,y)-Math.min(a,x));if(overlap>=.5)pairs.push({i,j,overlap});
 }));pairs.sort((a,b)=>b.overlap-a.overlap);const used=new Set(),usedLabels=new Set(),matched=[];
 for(const p of pairs)if(!used.has(p.i)&&!usedLabels.has(p.j)){used.add(p.i);usedLabels.add(p.j);matched.push({rep:cycles[p.i],sample:labels[p.j],iou:p.overlap});}
 return {matched,unmatchedCycles:cycles.filter((c,i)=>!used.has(i)),unmatchedLabels:labels.filter((s,j)=>!usedLabels.has(j)).map(s=>s.uid)};
}
for(const job of manifest.jobs){
 if(job.samples.some(s=>s.split==='test')!==(split==='test'))continue;
 const data=JSON.parse(zlib.gunzipSync(fs.readFileSync(dir+'/poses/'+job.id+'.json.gz')));
 const results={};
 for(const [name,Type]of [['old',PullupEngine],['phase',PullupPhaseEngine]]){
  const e=new Type(),phases={},invalid={};for(const f of data.frames){const r=e.update(f.landmarks,f.now,f.width,f.height);phases[r.phase]=(phases[r.phase]??0)+1;if(!r.valid)invalid[r.message]=(invalid[r.message]??0)+1;}
  results[name]={count:e.count,phases,invalid,...match(e.completed,job.samples)};
 }
 runs.push({id:job.id,group:job.samples[0].group,facing:job.samples[0].facing,labeled:job.samples.length,results});
}
const summary={};for(const name of ['old','phase']){
 summary[name]={cycles:0,matched:0,unmatchedCycles:0,matchedPartial:0,matchedSwing:0};for(const r of runs){const v=r.results[name],s=summary[name];s.cycles+=v.count;s.matched+=v.matched.length;s.unmatchedCycles+=v.unmatchedCycles.length;s.matchedPartial+=v.matched.filter(x=>x.sample.partial==='1').length;s.matchedSwing+=v.matched.filter(x=>x.sample.swing==='1').length;}
}
const report={split,note:'Greedy one-to-one IoU >= 0.5. Labels are not exhaustive; unmatched cycles need review and are NOT automatically false positives. Coverage is not counting accuracy.',labeled:runs.reduce((n,r)=>n+r.labeled,0),summary,runs};
fs.writeFileSync(dir+'/counter-'+split+'-comparison.json',JSON.stringify(report,null,2));console.log(JSON.stringify({split,labeled:report.labeled,summary},null,2));
