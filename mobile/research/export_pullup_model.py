"""Export existing numeric HGB trees, without refitting or changing thresholds."""
from pathlib import Path
import json,hashlib,sys
import numpy as np
import torch
from threadpoolctl import threadpool_limits
threadpool_limits(limits=2)
torch.set_num_threads(2)
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'pullups'))
from train import load_aux,load_dataset
from feature_model import motion_features
path=ROOT/'pullups/dataset_audited/model/model_final.pt';ckpt=torch.load(path,map_location='cpu',weights_only=False)
model={'version':1,'kind':'hist_gradient_boosting_binary','sourceSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'auxFeatures':ckpt['aux_feats'],'motionFeatures':ckpt['motion_features'],'models':{},'scope':'Experimental MediaPipe adapter. Original model trained on YOLO features; scores are not calibrated confidence.'}
for target,entry in ckpt['models'].items():
 m=entry['model'];trees=[]
 for stage in m._predictors:
  assert len(stage)==1
  nodes=stage[0].nodes;assert not nodes['is_categorical'].any()
  trees.append([[int(n['is_leaf']),float(n['value']),int(n['feature_idx']),float(n['num_threshold']),int(n['missing_go_to_left']),int(n['left']),int(n['right'])] for n in nodes])
 model['models'][target]={'features':entry['feature_set'],'baseline':float(m._baseline_prediction[0,0]),'threshold':ckpt['operating_point'][target]['threshold'],'trees':trees}
(ROOT/'mobile/app/models/pullup-hgb.json').write_text(json.dumps(model,separators=(',',':'),allow_nan=False))
# All held-out feature rows plus random/missing vectors verify the exported evaluator.
samples,kp,conf,offsets=load_dataset(ROOT/'pullups/dataset_audited');aux=load_aux(ROOT/'pullups/data_expanded',None);cases=[]
for i,s in enumerate(samples):
 if s['split']!='test':continue
 a,b=offsets[i:i+2];base=aux[s['uid']];x=np.concatenate([base,motion_features(kp[a:b],conf[a:b])]);cases.append({'uid':s['uid'],'x':x,'labels':{t:int(s[t]) for t in ckpt['targets']}})
rng=np.random.default_rng(42)
for i in range(100):
 x=rng.normal(size=40).astype(np.float32)*50;x[rng.random(40)<.25]=np.nan
 cases.append({'uid':f'random-{i}','x':x,'labels':{}})
cases.append({'uid':'all-missing','x':np.full(40,np.nan,dtype=np.float32),'labels':{}})
for row in cases:
 row['expected']={t:float(v['model'].predict_proba(row['x'][None,:16 if v['feature_set']=='base' else 40])[0,1]) for t,v in ckpt['models'].items()}
 row['x']=[float(v) if np.isfinite(v) else None for v in row['x']]
(ROOT/'mobile/research/pullup-model-fixtures.json').write_text(json.dumps(cases,allow_nan=False))
print('Exported',sum(len(x['trees']) for x in model['models'].values()),'trees;',len(cases),'parity cases;', (ROOT/'mobile/app/models/pullup-hgb.json').stat().st_size,'bytes')
