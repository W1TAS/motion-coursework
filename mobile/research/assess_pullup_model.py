"""Descriptive checks only: no fitting, threshold tuning or editing human labels."""
from pathlib import Path
import json,sys
import numpy as np
from sklearn.metrics import confusion_matrix,precision_score,recall_score,f1_score,average_precision_score
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'pullups'))
from train import load_dataset
model=json.loads((ROOT/'mobile/app/models/pullup-hgb.json').read_text());fixtures=json.loads((ROOT/'mobile/research/pullup-model-fixtures.json').read_text());known=[r for r in fixtures if r['labels']]
samples,kp,conf,offsets=load_dataset(ROOT/'pullups/dataset_audited');smap={s['uid']:i for i,s in enumerate(samples)}
def metric(y,p):
 tn,fp,fn,tp=confusion_matrix(y,p,labels=[0,1]).ravel();return {'n':len(y),'n_pos':int(np.sum(y)),'tn':int(tn),'fp':int(fp),'fn':int(fn),'tp':int(tp),'precision':float(precision_score(y,p,zero_division=0)),'recall':float(recall_score(y,p,zero_division=0)) if np.sum(y) else None,'f1':float(f1_score(y,p,zero_division=0))}
heldout={}
for target in ['partial','swing']:
 rows=[r for r in known if r['labels'][target]>=0];y=[r['labels'][target] for r in rows];scores=[r['expected'][target] for r in rows];threshold=model['models'][target]['threshold'];m=metric(y,[p>=threshold for p in scores]);m['ap']=float(average_precision_score(y,scores));m['positiveRate']=float(np.mean(y));m['threshold']=threshold
 baseline_y=[];baseline_p=[]
 for r in rows:
  x=r['x']
  if target=='partial':
   if x[3] is None or x[4] is None:continue
   pred=x[3]<150 or x[4]>90
  else:
   i=smap[r['uid']];a,b=offsets[i:i+2];P=kp[a:b].astype(float);C=conf[a:b];P[C<.45]=np.nan
   sh=(P[:,5]+P[:,6])/2;hip=(P[:,11]+P[:,12])/2;wr=(P[:,9]+P[:,10])/2;torso=np.linalg.norm(hip-sh,axis=1);signal=(hip[:,0]-wr[:,0])/torso
   if np.isfinite(signal).mean()<.85:continue
   pred=np.nanmax(signal)-np.nanmin(signal)>.35
  baseline_y.append(r['labels'][target]);baseline_p.append(pred)
 heldout[target]={'unchanged_model':m,'simple_geometric_proxy':metric(baseline_y,baseline_p),'baseline_note':'Descriptor-level proxy on supplied YOLO clips, without online cycle detection; lateral displacement is not equivalent to all swing errors.'}
# Match new causal MediaPipe cycles to existing manual intervals, one-to-one, IoU >= 0.5.
labels={}
for line in (ROOT/'pullups/mine/labels.jsonl').read_text().splitlines():
 r=json.loads(line)
 if r.get('action')=='label':labels[r['rep_id']]=r
manifest=json.loads((ROOT/'mobile/app/samples/pullups/manifest.json').read_text());evaluation=json.loads((ROOT/'mobile/research/stream-model-evaluation.json').read_text());
def compare(evaluation):
 matched=[];unmatched=[]
 for run in evaluation['runs']:
  item=manifest[run['id']-1];video=Path(item['source']).stem;used=set()
  for row in run['results']:
   rep=row['rep'];a=item['sourceStart']+rep['sampleStart']/1000;b=item['sourceStart']+rep['end']/1000
   candidates=[]
   for lab in labels.values():
    if lab.get('video_id')!=video or lab.get('bad') or lab.get('unsure') or lab['rep_id'] in used:continue
    c,d=float(lab['start']),float(lab['end']);intersection=max(0,min(b,d)-max(a,c));iou=intersection/(max(b,d)-min(a,c));candidates.append((iou,lab))
   if not candidates or max(candidates,key=lambda x:x[0])[0]<.5:unmatched.append({'video':video,'cycle':rep['index'],'start':a,'end':b});continue
   iou,lab=max(candidates,key=lambda x:x[0]);used.add(lab['rep_id']);truth={t:int(lab['labels'].get(t,0)>0) for t in ['partial','swing']};matched.append({'video':video,'cycle':rep['index'],'labelId':lab['rep_id'],'iou':iou,'truth':truth,'model':row['decision']['targets'],'rules':{'partial':int(rep['amplitude']=='limited'),'lateral':int(rep['lateral']=='visible')}})
 small={}
 for target in ['partial','swing']:
  rows=[r for r in matched if r['model'][target]['state']!='unavailable'];small[target]=metric([r['truth'][target] for r in rows],[r['model'][target]['state']=='flagged' for r in rows])
 small['partial_rule']=metric([r['truth']['partial'] for r in matched],[r['rules']['partial'] for r in matched])
 return {'metrics':small,'matched':matched,'unmatched':unmatched,'note':'Existing personal labels; selected examples used during rule development; interval matching IoU>=0.5; not an independent performance estimate. No parameters adjusted to these results.'}
cached=compare(evaluation)
browser_path=ROOT/'mobile/tests/pullups-model-result.json'
browser=None
if browser_path.exists():
 raw=json.loads(browser_path.read_text());converted={'runs':[{'id':int(run['id'].split('-')[-1]),'results':[{'rep':x['rep'],'decision':x['rep']['model']} for x in run['modelResults']]} for run in raw['runs']]}
 browser=compare(converted)
result={'modelSha256':model['sourceSha256'],'independent_original_yolo_test':heldout,'development_mediapipe_check':cached,'browser_mediapipe_check':browser}
(ROOT/'mobile/research/model-usefulness.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps({'heldout':heldout,'cached':cached['metrics'],'browser':browser['metrics'] if browser else None,'matchedCached':len(cached['matched']),'matchedBrowser':len(browser['matched']) if browser else None},indent=2))
