import fs from 'node:fs';import zlib from 'node:zlib';
import {PullupEngine} from '../app/pullup-engine.mjs';import {PullupPhaseEngine} from '../app/pullup-phases.mjs';
import {PullupModelSession,extractModelFeatures} from '../app/pullup-model.mjs';
import {PullupAnalysisSession} from '../app/pullup-rules.mjs';
const dir='pullups/dataset_mediapipe_gpu',manifest=JSON.parse(fs.readFileSync(dir+'/manifest.json'));
const split=process.argv.includes('--test')?'test':'development';
const cmp=JSON.parse(fs.readFileSync(dir+'/counter-'+split+'-comparison.json'));
const stats={},rows=[];
for(const name of ['old','phase'])for(const window of ['full','ascent'])stats[name+'_'+window]={tp:0,fp:0,tn:0,fn:0,unavailable:0,unavailablePositive:0};
for(const job of manifest.jobs){if(job.samples.some(s=>s.split==='test')!==(split==='test'))continue;
 const frames=JSON.parse(zlib.gunzipSync(fs.readFileSync(dir+'/poses/'+job.id+'.json.gz'))).frames;
 const matching=cmp.runs.find(r=>r.id===job.id);
 for(const [name,Type]of [['old',PullupEngine],['phase',PullupPhaseEngine]]){
  const e=new Type(),session=new (name==='phase'?PullupAnalysisSession:PullupModelSession)({models:{}});
  for(const f of frames){const before=e.count,r=e.update(f.landmarks,f.now,f.width,f.height);session.observe(f.landmarks,f.now,f.width,f.height,r.phase);
   if(e.count===before)continue;const rep=e.completed.at(-1),match=matching.results[name].matched.find(x=>x.rep.index===rep.index);
   const full=extractModelFeatures(session.frames,rep,session.previous),asc=name==='phase'?extractModelFeatures(session.frames,{...rep,end:rep.top},session.previous):null;
   if(full){session.previous.push(full.stats);if(session.previous.length>30)session.previous.shift();}
   if(!match)continue;
   for(const [window,x]of [['full',full],['ascent',asc]]){if(name==='old'&&window==='ascent')continue;
    const y=+match.sample.partial,s=stats[name+'_'+window],q=x?.quality;
    const valid=q&&q.nanFrac<=.15&&q.confidence>=.45&&q.wristMove<=1&&q.maxGap<=.6&&q.bodyJump<=.2&&Number.isFinite(x.features[3])&&Number.isFinite(x.features[4]);
    let predicted=null;if(!valid){s.unavailable++;s.unavailablePositive+=y;}else{predicted=x.features[3]<140||x.features[4]>65;s[y?(predicted?'tp':'fn'):(predicted?'fp':'tn')]++;}
    rows.push({uid:match.sample.uid,group:match.sample.group,engine:name,window,label:y,predicted,bottom:x?.features[3],top:x?.features[4]});
   }
  }
 }
}
for(const s of Object.values(stats)){s.f1=2*s.tp/(2*s.tp+s.fp+s.fn)||0;s.precision=s.tp/(s.tp+s.fp)||0;s.recall=s.tp/(s.tp+s.fn)||0;}
fs.writeFileSync(dir+'/phase-rules-'+split+'.json',JSON.stringify({split,note:'Fixed 140/65 thresholds selected previously on development full annotated windows. Test is the existing reserved split, previously evaluated for earlier approaches; not a fresh unseen test. Counter-matched subsets differ; see coverage.',stats,rows},null,2));console.log(stats);
