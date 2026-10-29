"""Propose image bar edges independently of exercise labels; retain all candidates."""
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'pullups/dataset_mediapipe_gpu/human-reviews'
PACKET = BASE / 'expanded-3d/review/top-proxy'
OUT = BASE / 'top-proxy-v1/bar-offset-audit-v1'


def signed_distance(point, left, right):
    if left['x'] > right['x']:
        left, right = right, left
    dx, dy = right['x']-left['x'], right['y']-left['y']
    return float((dy*(point[0]-left['x'])-dx*(point[1]-left['y'])) / np.hypot(dx, dy))


def propose(image, ref, canny=(45,120), max_candidates=8):
    torso = ref['torsoPixels']; left, right = sorted([ref['left'], ref['right']], key=lambda p: p['x'])
    span = right['x']-left['x']; mid_y = (left['y']+right['y'])/2
    x0 = max(0, int(left['x']-.25*torso)); x1 = min(image.shape[1], int(right['x']+.25*torso))
    y0 = max(0, int(mid_y-.55*torso)); y1 = min(image.shape[0], int(mid_y+.15*torso))
    crop = image[y0:y1, x0:x1]
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, *canny)
    lines = cv2.HoughLinesP(edges, 1, np.pi/720, threshold=20,
                            minLineLength=max(20, int(span*.45)), maxLineGap=max(4, int(span*.08)))
    expected = np.arctan2(right['y']-left['y'], span)
    candidates = []
    if lines is not None:
        for line in lines.reshape(-1,4):
            ax, ay, bx, by = map(float, line)
            ax += x0; bx += x0; ay += y0; by += y0
            if ax > bx:
                ax, bx, ay, by = bx, ax, by, ay
            angle = np.arctan2(by-ay, bx-ax)
            if abs(angle-expected) > np.deg2rad(7):
                continue
            offset = signed_distance(((ax+bx)/2, (ay+by)/2), left, right)
            if not -.03*torso <= offset <= .45*torso:
                continue
            coverage = max(0, min(bx, right['x'])-max(ax, left['x'])) / span
            if coverage < .4:
                continue
            candidates.append(dict(a=[ax,ay],b=[bx,by],offsetPixels=offset,offsetTorso=offset/torso,
                                   angleDegrees=float(np.rad2deg(angle)),coverage=coverage,
                                   score=coverage-.4*max(0,offset/torso)))
    kept = []
    for c in sorted(candidates, key=lambda c: -c['score']):
        if not any(abs(c['offsetPixels']-p['offsetPixels'])<2 and abs(c['angleDegrees']-p['angleDegrees'])<2 for p in kept):
            kept.append(c)
        if len(kept)==max_candidates:
            break
    return dict(crop=[x0,y0,x1,y1],candidates=kept)


def main():
    packet_bytes = (PACKET/'packet-data.json').read_bytes()
    data = json.loads(packet_bytes)
    OUT.mkdir(parents=True, exist_ok=True)
    rows, tiles = [], []
    for number, item in enumerate(data['items'], 1):
        ref = item['measurement'].get('reference')
        if not ref:
            continue
        cap = cv2.VideoCapture(str(PACKET/item['file']))
        frames = []
        for delta in (-.16, -.08, 0, .08, .16):
            t = max(0, min(item['windowEnd'], item['windowStart']+delta))
            cap.set(cv2.CAP_PROP_POS_MSEC, t*1000)
            ok, frame = cap.read()
            if ok:
                frames.append(cv2.resize(frame, (ref['width'],ref['height'])))
        cap.release()
        if len(frames)<3:
            raise ValueError('Insufficient video frames')
        median = np.median(frames, axis=0).astype(np.uint8)
        image_name = f'scene-{number:02}-reference.png'
        cv2.imwrite(str(OUT/image_name), median)
        proposals = propose(median, ref)
        x0,y0,x1,y1 = proposals['crop']
        crop = median[y0:y1,x0:x1].copy()
        def point(p): return int(round(p[0]-x0)),int(round(p[1]-y0))
        left,right = ref['left'],ref['right']
        cv2.line(crop,point([left['x'],left['y']]),point([right['x'],right['y']]),(220,220,30),1,cv2.LINE_AA)
        for i,c in reversed(list(enumerate(proposals['candidates'][:3],1))):
            color = [(50,220,255),(150,90,255),(90,255,90)][i-1]
            cv2.line(crop,point(c['a']),point(c['b']),color,1,cv2.LINE_AA)
        cv2.imwrite(str(OUT/f'scene-{number:02}-candidates.png'),crop)
        tile = np.full((235,500,3),245,np.uint8)
        scale = min(490/crop.shape[1],170/crop.shape[0])
        shown = cv2.resize(crop,None,fx=scale,fy=scale,interpolation=cv2.INTER_CUBIC)
        tile[30:30+shown.shape[0],5:5+shown.shape[1]]=shown
        cv2.putText(tile,f'{number:02} {item["id"].split(":",1)[1]}',(5,21),cv2.FONT_HERSHEY_SIMPLEX,.5,(30,30,30),1,cv2.LINE_AA)
        offsets=' '.join(f'{i+1}: {c["offsetPixels"]:.1f}px/{c["offsetTorso"]:.3f}T' for i,c in enumerate(proposals['candidates'][:3]))
        cv2.putText(tile,offsets or 'No line candidate',(5,222),cv2.FONT_HERSHEY_SIMPLEX,.4,(30,30,30),1,cv2.LINE_AA)
        rows.append(dict(number=number,uid=item['id'],referenceImage=image_name,
                         imageReference=ref,**proposals))
        tiles.append(tile)
    sheet = np.vstack([np.hstack(tiles[i:i+3]) for i in range(0,len(tiles),3)])
    cv2.imwrite(str(OUT/'contact-sheet.jpg'),sheet)
    report = dict(schema=1,packetSha256=hashlib.sha256(packet_bytes).hexdigest(),
                  protocol='Median of five decoded frames around initial bottom. Image edges near the wrist line; no technique labels used. Hough candidates are unverified image structures, not detected bars.',
                  rows=rows)
    (OUT/'candidates.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(f'{len(rows)} scene proposals saved to {OUT}')


if __name__=='__main__':
    main()
