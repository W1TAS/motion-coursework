import fs from 'node:fs';import zlib from 'node:zlib';
import {PullupPhaseEngine} from '../app/pullup-phases.mjs';
import {measureInitialBottom,measureAutomaticBottom,experimentalBottomDecision} from '../app/pullup-bottom.mjs';
const base='pullups/dataset_mediapipe_gpu/human-reviews',dir=base+'/pose-comparison-stream';
const reviews=JSON.parse(fs.readFileSync(base+'/criterion-labels.json'));
const rows=[];
for(const r of reviews.rows.filter(r=>r.attempt==='attempt'&&r.ready_for_phase_features.bottom_incomplete)){
 const c=JSON.parse(zlib.gunzipSync(fs.readFileSync(dir+'/'+r.uid.replaceAll(':','_')+'-lite.json.gz')));
 const engine=new PullupPhaseEngine();for(const f of c.frames)engine.update(f.landmarks,f.now,f.width,f.height);
 // Reference timestamps are used only for matching after streaming detection.
 const matched=engine.completed.filter(rep=>Math.abs(rep.top/1000-r.phase_times.top)<=.4&&Math.abs(rep.sampleStart/1000-r.phase_times.bottom)<=.5).sort((a,b)=>Math.abs(a.top/1000-r.phase_times.top)-Math.abs(b.top/1000-r.phase_times.top))[0];
 const geometry=matched?measureInitialBottom(c.frames,matched.sampleStart):null;
 const correctedGeometry=matched?measureAutomaticBottom(c.frames,matched):null;
 rows.push({uid:r.uid,group:r.group,label:r.targets.bottom_incomplete,detected:engine.completed.length,matched:matched??null,geometry,correctedGeometry,decision:experimentalBottomDecision(correctedGeometry),manualGeometry:measureInitialBottom(c.frames,r.phase_times.bottom*1000),reference:r.phase_times});
}
const metrics={};for(const mode of ['auto_2d','auto_3d','corrected_3d','manual_2d','manual_3d']){
 const m={tp:0,fp:0,tn:0,fn:0,unavailable:0};
 for(const r of rows){const g=mode==='corrected_3d'?r.correctedGeometry:mode.startsWith('auto')?r.geometry:r.manualGeometry,a=g?.[mode.endsWith('3d')?'angle3d':'angle2d'];if(!Number.isFinite(a)){m.unavailable++;continue;}const pred=a<150;m[r.label?(pred?'tp':'fn'):(pred?'fp':'tn')]++;}metrics[mode]=m;
}
fs.writeFileSync(dir+'/stream-comparison.json',JSON.stringify({protocol:'Continuous 25fps CPU Lite; no phase markers passed to detector. Matching top ±0.4s and bottom ±0.5s against human references. Source clips span bottom-2s to return+0.8s; selected around known events. Not exhaustive counting accuracy or unseen-source evaluation.',metrics,rows},null,2));
console.log(metrics);for(const r of rows)console.log(r.uid,r.label,r.matched?{bottomOffset:(r.matched.sampleStart/1000-r.reference.bottom).toFixed(2),angle2d:r.geometry.angle2d?.toFixed(1),angle3d:r.geometry.angle3d?.toFixed(1)}:'unmatched');
