"""Prepare a small scene-diverse development pilot; freeze selection before calibration."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'pullups/dataset_mediapipe_gpu'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', default='actual-bar-pilot-v1')
    args = parser.parse_args()
    if not args.out.replace('-', '').isalnum():
        raise SystemExit('Invalid version')
    out = BASE / 'human-reviews' / args.out
    if out.exists():
        raise SystemExit('Output exists; choose a new version')
    audit_path = BASE / 'human-reviews/pose-face-audit-v2/rows.json.gz'
    audit_raw = audit_path.read_bytes()
    audit = json.loads(gzip.decompress(audit_raw))
    summary = json.loads((audit_path.parent/'summary.json').read_text())
    largest = summary['withoutLargest']['excluded']
    grouped = {}
    for row in audit['rows']:
        if row['screened'] and row['group'] != largest:
            grouped.setdefault(row['jobId'], []).append(row)
    selected = {j for j, rows in grouped.items() if any(r['topLabel'] == 0 or r['proxy']['state'] == 'unavailable' for r in rows)}
    controls = [j for j in sorted(grouped) if j not in selected]
    selected.update(controls[:max(0, 10-len(selected))])
    assert len(selected) == 10
    manifest_raw = (BASE/'manifest.json').read_bytes()
    manifest = json.loads(manifest_raw)
    jobs = {j['id']: j for j in manifest['jobs']}
    out.mkdir()
    (out/'images').mkdir()
    scenes, tiles = [], []
    for number, job_id in enumerate(sorted(selected), 1):
        job, rows = jobs[job_id], grouped[job_id]
        assert all(s['split'] != 'test' for s in job['samples'])
        raw = (BASE/'poses'/(job_id+'.json.gz')).read_bytes()
        cache = json.loads(gzip.decompress(raw))
        assert cache['fingerprint'] == job['fingerprint']
        first = min(r['phase']['start'] for r in rows)
        last = max(r['phase']['top'] for r in rows)
        times = [first, (first+last)/2, last]
        cap = cv2.VideoCapture(job['video'])
        assert cap.isOpened(), job_id
        anchors = []
        for name, t in zip(('initial', 'middle', 'last'), times):
            pose = min(cache['frames'], key=lambda f: abs(f['now']-t*1000))
            cap.set(cv2.CAP_PROP_POS_MSEC, pose['now'])
            ok, image = cap.read()
            assert ok, (job_id, t)
            image = cv2.resize(image, (pose['width'], pose['height']))
            filename = f'scene-{number:02}-{name}.png'
            assert cv2.imwrite(str(out/'images'/filename), image)
            anchors.append(dict(name=name,timeMs=pose['now'],image=filename,
                                sha256=sha((out/'images'/filename).read_bytes())))
        cap.release()
        # Wrist coordinates only choose a viewing crop; they never define the bar.
        local = [f for f in cache['frames'] if abs(f['now']-first*1000) <= 200]
        points = [(p['x']*f['width'], p['y']*f['height']) for f in local if f['landmarks']
                  for p in (f['landmarks'][15], f['landmarks'][16]) if p.get('visibility',0) >= .45]
        first_image = cv2.imread(str(out/'images'/anchors[0]['image']))
        height, width = first_image.shape[:2]
        if points:
            xs, ys = zip(*points)
            x0, x1 = max(0,int(min(xs)-120)), min(width,int(max(xs)+120))
            y0, y1 = max(0,int(np.median(ys)-110)), min(height,int(np.median(ys)+90))
        else:
            x0,y0,x1,y1 = 0,0,width,min(height,300)
        for anchor in anchors:
            image = cv2.imread(str(out/'images'/anchor['image']))
            crop = image[y0:y1,x0:x1].copy()
            scale = min(2, 1000/max(1,crop.shape[1]))
            crop = cv2.resize(crop,None,fx=scale,fy=scale)
            for x in range((x0//20+1)*20,x1,20):
                xx=round((x-x0)*scale)
                cv2.line(crop,(xx,0),(xx,crop.shape[0]-1),(150,150,150),1)
                cv2.putText(crop,str(x),(xx+2,13),cv2.FONT_HERSHEY_SIMPLEX,.35,(0,0,255),1)
            for y in range((y0//10+1)*10,y1,10):
                yy=round((y-y0)*scale)
                cv2.line(crop,(0,yy),(crop.shape[1]-1,yy),(150,150,150),1)
                cv2.putText(crop,str(y),(2,yy-2),cv2.FONT_HERSHEY_SIMPLEX,.35,(0,0,255),1)
            grid=anchor['image'].replace('.png','-grid.png')
            cv2.imwrite(str(out/'images'/grid),crop)
            anchor['grid']=grid
        tile=np.full((245,500,3),245,np.uint8)
        cv2.putText(tile,f'{number:02} {job_id}',(6,18),cv2.FONT_HERSHEY_SIMPLEX,.5,(10,10,10),1)
        for k,anchor in enumerate((anchors[0],anchors[-1])):
            image=cv2.imread(str(out/'images'/anchor['image']))
            crop=image[y0:y1,x0:x1]
            shown=cv2.resize(crop,(240,190))
            tile[35:225,5+k*250:245+k*250]=shown
        tiles.append(tile)
        scenes.append(dict(number=number,id=job_id,group=rows[0]['group'],width=width,height=height,
                           sourceVideo=job['video'],cacheSha256=sha(raw),crop=[x0,y0,x1,y1],anchors=anchors,
                           samples=[dict(uid=r['uid'],start=r['phase']['start'],top=r['phase']['top']) for r in rows]))
    sheet=np.vstack([np.hstack(tiles[i:i+2]) for i in range(0,len(tiles),2)])
    cv2.imwrite(str(out/'contact-sheet.jpg'),sheet)
    protocol=dict(schema=1,testUsed=False,auditSha256=sha(audit_raw),manifestSha256=sha(manifest_raw),
                  sourceSha256=sha(Path(__file__).read_bytes()),
                  selection='All non-largest-channel screened scenes with normal tops or old proxy refusals; fill to 10 with sorted error control scenes. Selected before new calibration and measurements. Not representative test sampling.',
                  cameraCheck='Initial, middle, last anchor images must show the same bar at the same image coordinates; moving/ambiguous scenes require abstention or a separate scene.',
                  calibration='Upper visible edge of the gripped straight bar, two image points. Agent visual estimates retained separately from human exercise labels; no fitting to outcomes.',
                  comparison='Frozen old method plus a common face sampler with wrist-prior reference versus actual bar. Pose-only face landmarks; no extra model or inferred chin.')
    (out/'selection.json').write_text(json.dumps(dict(protocol=protocol,scenes=scenes),ensure_ascii=False,indent=2)+'\n')
    print(f'{len(scenes)} scenes, {sum(len(s["samples"]) for s in scenes)} reviewed repetitions: {out}')


if __name__=='__main__':
    main()
