#!/usr/bin/env python3
"""Decode sequentially; browser seeking on a server without Range support is unreliable."""
from pathlib import Path
import subprocess,json,hashlib
ROOT=Path(__file__).resolve().parent
records=[]
for p in sorted((ROOT/'sources').glob('*.mp4')):
 out=ROOT/'frames'/p.stem;out.mkdir(parents=True,exist_ok=True)
 # This directory is generated exclusively by this tool; remove stale tail frames.
 for old in out.glob('*.jpg'):old.unlink()
 subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(p),'-vf','fps=10,scale=640:-2','-q:v','3',str(out/'%06d.jpg')],check=True)
 records.append({'source':p.stem,'video_sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'frames':len(list(out.glob('*.jpg'))),'fps':10,'width':640})
 print(p.stem,records[-1]['frames'],flush=True)
(ROOT/'decoding.json').write_text(json.dumps(records,indent=2))
