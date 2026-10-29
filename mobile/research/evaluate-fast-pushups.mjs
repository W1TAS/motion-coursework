import fs from 'node:fs';
import {ExerciseEngine as Old} from './baseline-engine-0.1.4.mjs';
import {ExerciseEngine as New} from '../app/engine.mjs';
const data=JSON.parse(fs.readFileSync(new URL('poses/283728.json',import.meta.url))).filter(f=>f.now>=60000&&f.now<66000);
const rows=[];
for(const speed of [1,1.5,2,2.5])for(const fps of [10,20,30]){
 const before=new Old(),after=new New();let last=-1;
 for(let t=0;t<6000/speed;t+=1000/fps){
  const target=60000+t*speed;let index=data.findIndex(f=>f.now>=target);if(index<0||index===last)continue;last=index;
  const f=data[index];before.update(f.landmarks,t,f.width,f.height);after.update(f.landmarks,t,f.width,f.height);
 }
 rows.push({speed,fps,before:before.count,after:after.count});
}
const result={source:'DVIDS 283728, 60–66 s: two visually reviewed complete cycles',method:'Replay of cached real poses with accelerated timestamps and sampling; not new recordings of fast movement, not a phone FPS benchmark',rows};
fs.writeFileSync(new URL('fast-pushups-results.json',import.meta.url),JSON.stringify(result,null,2));console.table(rows);
