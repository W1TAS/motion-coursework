import fs from 'node:fs';
import {ExerciseEngine as Baseline} from './baseline-engine-0.1.2.mjs';
import {ExerciseEngine as Current,RULES} from '../app/engine.mjs';
const root=new URL('./',import.meta.url),spec=JSON.parse(fs.readFileSync(new URL('intervals.json',root)));
const rows=[];
for(const clip of spec.intervals){
 const frames=JSON.parse(fs.readFileSync(new URL(`poses/${clip.source}.json`,root))).filter(f=>f.now>=clip.start*1000&&f.now<clip.end*1000);
 const old=new Baseline(clip.exercise),next=new Current(clip.exercise),reasons={};
 for(const f of frames){old.update(f.landmarks,f.now,f.width,f.height);const r=next.update(f.landmarks,f.now,f.width,f.height);reasons[r.message]=(reasons[r.message]??0)+1;}
 rows.push({...clip,frames:frames.length,baselineSeconds:+old.seconds.toFixed(2),currentSeconds:+next.seconds.toFixed(2),reasons});
}
const report={date:'2026-10-26',annotation:spec.annotation,rules:RULES,independentAccuracy:false,rows};
fs.writeFileSync(new URL('evaluation.json',root),JSON.stringify(report,null,2));console.table(rows.map(r=>({id:r.id,seconds:r.end-r.start,old:r.baselineSeconds,new:r.currentSeconds,expected:r.expected})));
// Regression checks only for this small, visually inspected corpus.
for(const r of rows){if(r.expected==='reject'&&r.currentSeconds!==0)throw Error('False accumulation: '+r.id);if(r.expected==='hold'&&r.currentSeconds/(r.end-r.start)<.65)throw Error('Excessive rejection: '+r.id);}
