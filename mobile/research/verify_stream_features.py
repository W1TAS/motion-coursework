"""Independent Python reference for the causal adapter's numeric feature extraction."""
from pathlib import Path
from types import SimpleNamespace
import sys,json
import numpy as np
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'pullups'))
import rep_features as rf
from build_dataset import resample
from feature_model import motion_features
from train import AUX_FEATS
cases=json.loads((ROOT/'mobile/research/stream-feature-fixtures.json').read_text());max_error=0;details=[]
for case in cases:
 f=case['frames'];rep=case['rep'];previous=case['previous'];raw=np.asarray([r['p'] for r in f],dtype=float);t=np.array([r['t'] for r in f]);kp,conf=raw[:,:,:2],raw[:,:,2]
 P=rf.clean(kp,conf,t,SimpleNamespace(kp_conf=.3,smooth_s=.1,max_gap_s=.4));scale=np.nanmedian(rf.dist(P,5,6));S=rf.series(P,scale)
 ids=np.flatnonzero((t>=rep['sampleStart']/1000-1e-6)&(t<=rep['end']/1000+1e-6));a,b=int(ids[0]),int(ids[-1]);top=int(a+np.nanargmin(S['sh_y'][a:b+1]));features=rf.rep_feats(S,a,top,b,float(np.median(np.diff(t))))
 rise_px=features['rise']*scale;duration=(rep['end']-rep['sampleStart'])/1000
 features.update(rise_rel=rise_px/np.median([r['risePixels'] for r in previous]+[rise_px]) if len(previous)>=2 else np.nan,tilt_dev_abs=abs(np.nanmean(S['tilt'][a:b+1])-np.nanmedian(S['tilt'])),hip_dx_dev=abs(np.nanmean(S['hip_dx'][a:b+1])-np.nanmedian(S['hip_dx'])),dur_rel=duration/np.median([r['duration'] for r in previous]+[duration]))
 base=np.array([round(features[k],4) for k in AUX_FEATS],dtype=np.float32)
 mask=(t>=rep['sampleStart']/1000-.2)&(t<=rep['end']/1000+1e-6);center=np.nanmedian((P[:,5]+P[:,6])/2,axis=0)
 _,pos,c=resample((P[mask]-center)/scale,conf[mask],t[mask],30);c=np.where(np.isfinite(pos).all(axis=2),c,0).astype(np.float32);pos=np.nan_to_num(pos).astype(np.float32)
 expected=np.concatenate([base,motion_features(pos,c)]);actual=np.asarray(case['features'],dtype=float)
 np.testing.assert_allclose(actual,expected,rtol=2e-5,atol=2e-4,equal_nan=True,err_msg=case['id'])
 error=float(np.nanmax(np.abs(actual-expected)));max_error=max(max_error,error);details.append({'id':case['id'],'maxError':error})
result={'cases':len(cases),'maxAbsoluteFeatureError':max_error,'note':'Feature formula parity; does not validate YOLO-to-MediaPipe distribution transfer','details':details}
(ROOT/'mobile/tests/pullup-feature-parity-result.json').write_text(json.dumps(result,indent=2));print(result)
