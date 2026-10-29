#!/usr/bin/env python3
"""Flag likely visual reposts; never discard or label automatically.
Mirrored frames are checked; small/partial/cropped reposts can escape this audit.
Run with pullups/.venv/bin/python.
"""
from pathlib import Path
import cv2,numpy as np,json,itertools,hashlib
ROOT=Path(__file__).resolve().parent
fingerprints={};hashes={}
def phash(frame):
 gray=cv2.resize(cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY),(32,32)).astype(np.float32)
 d=cv2.dct(gray)[:8,:8].flatten()[1:];return d>np.median(d)
for p in sorted((ROOT/'sources').glob('*.mp4')):
 hashes[p.stem]=hashlib.sha256(p.read_bytes()).hexdigest()
 images=sorted((ROOT/'frames'/p.stem).glob('*.jpg'))
 if not images:raise SystemExit('Extract frames first: '+p.stem)
 frames=[]
 for index in np.linspace(len(images)*.12,len(images)*.92,24).astype(int):
  f=cv2.imread(str(images[index]))
  if f is not None:frames.append([phash(f),phash(cv2.flip(f,1))])
 fingerprints[p.stem]=np.array(frames)
rows=[]
for a,b in itertools.combinations(fingerprints,2):
 x,y=fingerprints[a],fingerprints[b];dist=np.count_nonzero(x[:,None,:,None,:]!=y[None,:,None,:,:],axis=-1).min(axis=(2,3))
 fraction=float(max(np.mean(dist.min(axis=0)<=6),np.mean(dist.min(axis=1)<=6)))
 rows.append({'a':a,'b':b,'sha_equal':hashes[a]==hashes[b],'visual_match_fraction':fraction,'review_duplicate':hashes[a]==hashes[b] or fraction>=.6})
(ROOT/'duplicates.json').write_text(json.dumps({'method':'24 frames, 63-bit DCT pHash, mirrors, distance <=6, flag fraction >=0.6; heuristic not guarantee','comparisons':rows},indent=2))
print(json.dumps(rows,indent=2))
