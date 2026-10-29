"""Blind review of 30 distinct channels, packaged as three standalone batches."""
from pathlib import Path
import gzip
import hashlib
import json
import random
import subprocess
import zipfile

ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/'pullups/dataset_mediapipe_gpu/human-reviews/expanded-3d'

def main():
    output=BASE/'review'
    if (BASE/'review-selection.json').exists():
        raise SystemExit('Review already frozen; do not overwrite user packet')
    output.mkdir(exist_ok=True)
    result=json.loads((BASE/'results.json').read_text())
    jobs={j['uid']:j for j in json.loads((BASE/'selection.json').read_text())['jobs']}
    rows=[r for r in result['rows'] if not r['exclusion']]
    random.Random(291027).shuffle(rows)
    chosen=[];groups=set()
    buckets=[('disagreement',10,lambda r:None not in (r['predictions']['window2d'],r['predictions']['window3d']) and r['predictions']['window2d']!=r['predictions']['window3d']),
             ('both_negative',8,lambda r:r['predictions']['window2d']==r['predictions']['window3d']==0),
             ('both_positive',8,lambda r:r['predictions']['window2d']==r['predictions']['window3d']==1),
             ('unavailable',4,lambda r:r['predictions']['window2d'] is None or r['predictions']['window3d'] is None),
             ('legacy_partial_control',12,lambda r:r['legacyPartial']==1),
             ('coverage_fill',30,lambda r:True)]
    for category,n,eligible in buckets:
        added=0
        for r in rows:
            if len(chosen)>=30 or added>=n:break
            if r['group'] in groups or not eligible(r):continue
            chosen.append((r,category));groups.add(r['group']);added+=1
    assert len(chosen)==30 and len(groups)==30
    random.Random(291028).shuffle(chosen)
    template=(ROOT/'pullups/criterion_review.html').read_text()
    # View labels are ground truth, not inferred from the old unverified tags.
    template=template.replace("const fields=[", "const fields=[\n ['facing','Откуда снято движение?',[['front','Спереди'],['front_oblique','Спереди под небольшим углом'],['side','Сбоку'],['back','Со спины'],['unknown','Не могу определить']]],")
    template=template.replace('Заполни четыре ответа по видео.','Заполни ответы по видео, включая ракурс.')
    all_items=[];private=[]
    for batch in range(3):
        tag=f'03-{batch+1}';dest=output/f'batch-{batch+1}';dest.mkdir(exist_ok=True)
        items=[];poses={};times={}
        for number,(r,category) in enumerate(chosen[batch*10:(batch+1)*10],1):
            job=jobs[r['uid']];name=f'clip-{number:02}.mp4';video=dest/name
            subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-y','-threads','2',
                            '-ss',str(job['start']),'-i',job['video'],'-t',str(job['end']-job['start']),
                            '-vf','scale=-2:640,fps=25','-an','-c:v','libx264','-threads','2',
                            '-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-movflags','+faststart',str(video)],check=True)
            info=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','format=duration:frame=best_effort_timestamp_time','-of','json',str(video)]))
            item=dict(id=r['uid'],file=name,sourceStart=job['start'],duration=float(info['format']['duration']),
                      windowStart=float(job['sample']['start'])-job['start'],windowEnd=float(job['sample']['end'])-job['start'],sha256=hashlib.sha256(video.read_bytes()).hexdigest())
            assert item['windowEnd']<=item['duration']+.05
            items.append(item);all_items.append(item)
            times[r['uid']]=[float(f['best_effort_timestamp_time']) for f in info['frames']]
            cached=json.loads(gzip.decompress((BASE/'poses'/f"{r['uid'].replace(':','_')}-lite.json.gz").read_bytes()))
            poses[r['uid']]=[dict(t=round(f['now']/1000-job['start'],4),p=None if not f['landmarks'] else [[p['x'],p['y'],min(p.get('visibility',0),p.get('presence',1))] for p in f['landmarks']]) for f in cached['frames']]
            private.append(dict(uid=r['uid'],group=r['group'],category=category,batch=batch+1,clip=number))
        html=template.replace('batch-02',f'batch-{tag}').replace('criteria-02',f'criteria-{tag}')
        html=html.replace('__ITEMS__',json.dumps(items)).replace('__POSES__',json.dumps(poses,separators=(',',':'))).replace('__FRAME_TIMES__',json.dumps(times,separators=(',',':')))
        (dest/'index.html').write_text(html)
    (output/'index.html').write_text('''<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Проверка 2D и 3D</title><style>body{font:18px/1.6 system-ui;max-width:700px;margin:40px auto;padding:20px}a{display:block;margin:15px 0}</style><h1>30 клипов, три небольшие партии</h1><p>Оценивайте движения по видео. Ответы моделей скрыты. Укажите ракурс; если не удаётся оценить критерий, выбирайте «Не могу определить». Для каждого положения отметьте кадр или «Не видно».</p><p>После каждой партии сохраните JSON. Результаты остаются в этом браузере до очистки его данных.</p><a href="batch-1/index.html">Партия 1 — 10 клипов</a><a href="batch-2/index.html">Партия 2 — 10 клипов</a><a href="batch-3/index.html">Партия 3 — 10 клипов</a></html>''')
    (BASE/'review-selection.json').write_text(json.dumps(dict(items=all_items,rows=private,note='Targeted blind audit with agreement controls, 30 channels, not representative prevalence sample. No predictions exposed in review HTML. Source offsets verified against frozen extraction jobs.'),ensure_ascii=False,indent=2))
    archive=BASE/'pullup-3d-review-30.zip'
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
        for file in output.rglob('*'):
            if file.is_file():z.write(file,'pullup-3d-review/'+file.relative_to(output).as_posix())
    print(archive,archive.stat().st_size)

if __name__=='__main__':main()
