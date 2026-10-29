"""Development-only diagnostic: view restriction, ascent windows, simple angle rules.
No test access; no app model replacement. Top timestamps are old automatic proposals.
"""
import json
from pathlib import Path
import numpy as np
from threadpoolctl import threadpool_limits
from sklearn.metrics import f1_score,precision_score,recall_score,average_precision_score,confusion_matrix
from feature_model import run_candidate
from train import best_threshold
from train_mediapipe_features import available
p=Path(__file__).resolve().parent/'dataset_mediapipe_gpu'
rows=json.loads((p/'approach-development-features.json').read_text())['rows']
assert all(r['sample']['split']!='test' for r in rows)
rows=[r for r in rows if available(r['rise'],'partial') and available(r['full'],'partial')]
S=[r['sample'] for r in rows];front=np.array([s['facing']=='front' for s in S]);fold=np.array([int(s['fold']) for s in S]);y=np.array([int(s['partial']) for s in S])
config=dict(max_leaf_nodes=7,min_samples_leaf=35,l2_regularization=10.,max_iter=180)
def metric(yy,pred):
 tn,fp,fn,tp=confusion_matrix(yy,pred,labels=[0,1]).ravel()
 return dict(n=len(yy),positive=int(sum(yy)),tp=int(tp),fp=int(fp),fn=int(fn),tn=int(tn),f1=float(f1_score(yy,pred,zero_division=0)),precision=float(precision_score(yy,pred,zero_division=0)),recall=float(recall_score(yy,pred,zero_division=0)))
result={'protocol':'Development sources only; common windows with adequate poses in full and ascent views. Fixed HGB config, group folds retained. Exploratory comparison, not an independent generalization estimate. Stored automatic top timestamps; no online top detector.','common_n':len(rows),'front_n':int(front.sum()),'runs':[]}
with threadpool_limits(limits=2):
 for window in ['full','rise']:
  x=np.array([[np.nan if v is None else v for v in r[window]['features'][:16]] for r in rows],dtype=np.float32)
  for cohort in ['all','front']:
   mask=np.ones(len(rows),bool) if cohort=='all' else front
   ss=[s for s,yes in zip(S,mask) if yes];xx=x[mask];ff=fold[mask];yy=y[mask]
   report,prob=run_candidate(ss,xx,'partial',config,0)
   pred=np.zeros(len(yy),bool)
   for f in set(ff):
    v=ff==f;t=best_threshold(prob[~v],yy[~v])['threshold'];pred[v]=prob[v]>=t
   evaluate_front=np.array([s['facing']=='front' for s in ss])
   hgb={'method':'HGB','window':window,'training_cohort':cohort,'all':metric(yy,pred),'same_front_subset':metric(yy[evaluate_front],pred[evaluate_front]),'ap_front':float(average_precision_score(yy[evaluate_front],prob[evaluate_front])),'cv':report}
   result['runs'].append(hgb)
   rules=np.zeros(len(yy),bool);choices=[]
   for f in sorted(set(ff)):
    tr=ff!=f;va=~tr
    candidates=[]
    for bottom in [0,120,130,140,150,160]:
     for top in [55,65,75,85,95,105,115,180]:
      predicted=(xx[:,3]<bottom)|(xx[:,4]>top)
      candidates.append((f1_score(yy[tr],predicted[tr],zero_division=0),bottom,top,predicted))
    _,b,t,pr=max(candidates,key=lambda a:a[0]);rules[va]=pr[va];choices.append({'fold':int(f),'bottom':b,'top':t})
   result['runs'].append({'method':'two_angle_rules','window':window,'training_cohort':cohort,'all':metric(yy,rules),'same_front_subset':metric(yy[evaluate_front],rules[evaluate_front]),'thresholds_from_other_groups':choices})
   print(window,cohort,'HGB',hgb['same_front_subset'],'rules',result['runs'][-1]['same_front_subset'],flush=True)
(p/'approach-development-comparison.json').write_text(json.dumps(result,indent=2))
