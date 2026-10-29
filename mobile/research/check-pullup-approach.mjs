import fs from 'node:fs';import zlib from 'node:zlib';
import {mapFrame,extractModelFeatures} from '../app/pullup-model.mjs';
const dir='pullups/dataset_mediapipe_gpu';const m=JSON.parse(fs.readFileSync(dir+'/manifest.json')),tops=JSON.parse(fs.readFileSync(dir+'/research-top-times.json'));
const rows=[];
for(const j of m.jobs){if(j.samples.some(s=>s.split==='test'))continue;
 const cached=JSON.parse(zlib.gunzipSync(fs.readFileSync(dir+'/poses/'+j.id+'.json.gz')));const mapped=cached.frames.map(f=>mapFrame(f.landmarks,f.now,f.width,f.height));const previous=[];
 for(const s of j.samples){const top=tops[s.uid];if(!Number.isFinite(top)||top<=+s.start||top>+s.end)throw Error('Invalid stored top '+s.uid);
  const rise=extractModelFeatures(mapped.filter(f=>f.t<=top+1e-6&&f.t>=Math.max(j.start,top-60)),{sampleStart:+s.start*1000,end:top*1000},previous);
  const full=extractModelFeatures(mapped.filter(f=>f.t<=+s.end+1e-6&&f.t>=Math.max(j.start,+s.end-60)),{sampleStart:+s.start*1000,end:+s.end*1000},previous);
  rows.push({sample:s,top,rise,full});if(full){previous.push(full.stats);if(previous.length>30)previous.shift();}
 }
}
fs.writeFileSync(dir+'/approach-development-features.json',JSON.stringify({note:'Development only. Stored YOLO-derived top boundaries are an offline diagnostic, not human-verified top frames and not online detection. No future frames after each endpoint in features.',rows}));console.log(rows.length);
