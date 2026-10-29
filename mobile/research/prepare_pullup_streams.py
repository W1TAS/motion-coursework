"""Re-encode continuous approaches. No pose/rep/classification data in app assets."""
from pathlib import Path
import json,subprocess,hashlib
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'mobile/app/samples/pullups'
SOURCES=[('VID_20260920_121803',12,40),('VID_20260920_122332',19,63),('VID_20260920_122909',32,80)]
manifest=[]
for i,(name,start,end) in enumerate(SOURCES,1):
 source=ROOT/f'pullups/mine/videos/{name}.mp4';output=OUT/f'example-{i}.mp4'
 subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-ss',str(start),'-i',str(source),'-t',str(end-start),'-an','-vf','scale=-2:640,fps=25,setsar=1','-c:v','libx264','-profile:v','baseline','-level','3.0','-pix_fmt','yuv420p','-crf','24','-preset','fast','-g','25','-movflags','+faststart',str(output)],check=True)
 manifest.append({'id':f'example-{i}','title':f'Запись {i}','video':output.name,'duration':end-start,'source':source.name,'sourceStart':start,'sourceEnd':end,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()})
 print(output.name,end-start,'seconds',flush=True)
(OUT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
# Obsolete precomputed outputs are retained in research/archived-0.1.5, not shipped.
for i in range(1,4):(OUT/f'example-{i}.json').unlink(missing_ok=True)
