#!/usr/bin/env python3
"""Package existing recordings and real offline classifier outputs, without changing labels.
Run with pullups/.venv/bin/python. No upload, training, or fabricated predictions.
"""
from pathlib import Path
from types import SimpleNamespace
import sys,json,hashlib,subprocess
import numpy as np
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'pullups'))
import torch
import rep_features as rf
from train import AUX_FEATS
from build_dataset import resample
from feature_model import motion_features
from decision_rules import decide
torch.set_num_threads(2)
model_path=ROOT/'pullups/dataset_audited/model/model_final.pt'
model=torch.load(model_path,map_location='cpu',weights_only=False)
knowledge=json.loads((ROOT/'pullups/knowledge_rules.json').read_text())
thresholds={t:model['operating_point'][t]['threshold'] for t in model['targets']}
args=SimpleNamespace(kp_conf=.3,smooth_s=.1,max_gap_s=.4,rep_prominence=.12,min_rep_s=1.0,max_nan=.15,min_dur=.8,max_dur=10.)
# Match the extraction parameters of rep_features.py's CLI; selected examples are not a test set.
segments={f"{s['video_id']}_{s['segment_idx']}":s for s in map(json.loads,(ROOT/'pullups/mine/segments.jsonl').read_text().splitlines())}
selected=['VID_20260920_121803_0','VID_20260920_122332_0','VID_20260920_122909_0']
out=ROOT/'mobile/research/archived-0.1.5';out.mkdir(exist_ok=True) # Historical exporter; never overwrite streaming app assets.
manifest=[]
def clean_json(x):
 if isinstance(x,dict):return {k:clean_json(v) for k,v in x.items()}
 if isinstance(x,(list,tuple)):return [clean_json(v) for v in x]
 if isinstance(x,(np.integer,np.floating)):x=x.item()
 if isinstance(x,float) and not np.isfinite(x):return None
 return x
for i,key in enumerate(selected):
 seg=segments[key];npz=ROOT/f'pullups/mine/kps/{key}.npz';d=np.load(npz)
 rows,P,S,t,indices=rf.analyze_segment(seg,d,args)
 # Exclude cycles cut by the cached sequence boundary. Retain their statistics as above.
 usable=[r for r in rows if r['start']>t[0]+.15 and r['end']<t[-1]-.15][:4]
 if not usable:raise ValueError('No complete cached cycles: '+key)
 start=max(float(t[0]),usable[0]['start']-.4);end=min(float(t[-1]),usable[-1]['end']+.4)
 scale=float(np.nanmedian(rf.dist(P,rf.L_SH,rf.R_SH)));center=np.nanmedian((P[:,rf.L_SH]+P[:,rf.R_SH])/2,axis=0)
 reps=[]
 for n,row in enumerate(usable):
  mask=(t>=row['start']-.2)&(t<=row['end']+.2)
  _,pos,c=resample((P[mask]-center)/scale,d['conf'][mask],t[mask],30.)
  c=np.where(np.isfinite(pos).all(axis=2),c,0.);pos=np.nan_to_num(pos).astype(np.float32)
  aux=np.array([row.get(k,np.nan) for k in AUX_FEATS],dtype=np.float32);scores={}
  for target,entry in model['models'].items():
   x=np.concatenate([aux,motion_features(pos,c)]) if entry['feature_set']=='motion' else aux
   scores[target]=float(entry['model'].predict_proba(x[None])[0,1])
  result=decide(row,scores,thresholds,knowledge)
  reps.append({'index':n+1,'start':row['start']-start,'top':row['top']-start,'end':row['end']-start,'decision':result,'elbowBottom':row['elb_bot'],'elbowTop':row['elb_top']})
 frames=[]
 for j in range(0,len(t),2):
  if start<=t[j]<=end:
   frames.append({'t':round(float(t[j]-start),4),'p':[[round(float(d['kp'][j,k,0]/d['wh'][0]),5),round(float(d['kp'][j,k,1]/d['wh'][1]),5),round(float(d['conf'][j,k]),3)] for k in range(17)]})
 ident=f'example-{i+1}';source=ROOT/f"pullups/mine/videos/{seg['video_id']}.mp4"
 subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-ss',str(start),'-i',str(source),'-t',str(end-start),'-an','-vf','scale=-2:640','-c:v','libx264','-crf','25','-preset','fast','-movflags','+faststart',str(out/f'{ident}.mp4')],check=True)
 asset={'id':ident,'title':f'Запись {i+1}','mode':'cached_offline_analysis','source':source.name,'sourceStart':start,'duration':end-start,'modelSha256':hashlib.sha256(model_path.read_bytes()).hexdigest(),'poseSha256':hashlib.sha256(npz.read_bytes()).hexdigest(),'frames':frames,'reps':reps,'note':'Поза YOLO и результаты классификатора рассчитаны заранее. Демонстрация, не независимая оценка точности. Видео не входит в личную историю.'}
 (out/f'{ident}.json').write_text(json.dumps(clean_json(asset),ensure_ascii=False,separators=(',',':'),allow_nan=False))
 manifest.append({'id':ident,'title':asset['title'],'duration':round(end-start,1),'reps':len(reps),'video':f'{ident}.mp4','analysis':f'{ident}.json'})
 print(ident,'seconds',round(end-start,2),'reps',len(reps),[r['decision']['state'] for r in reps],flush=True)
(out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
