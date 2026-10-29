"""Explain legacy proxy refusals separately from face-point availability; no fitting."""
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'pullups/dataset_mediapipe_gpu'


def valid(p):
    return (p is not None and all(isinstance(p.get(k), (int, float)) and math.isfinite(p[k]) for k in ('x', 'y'))
            and 0 < p['x'] < 1 and 0 < p['y'] < 1 and min(p.get('visibility', 0), p.get('presence', 1)) >= .45)


def distance(a, b):
    return math.hypot(a['x']-b['x'], a['y']-b['y'])


def frame_reason(f, ref):
    p = f['landmarks']
    if not p or not all(valid(p[i]) for i in (11, 12, 15, 16, 23, 24)):
        return 'body_or_wrists_confidence'
    def pixel(i):
        return dict(x=p[i]['x']*f['width'], y=p[i]['y']*f['height'])
    shoulder = {k: (pixel(11)[k]+pixel(12)[k])/2 for k in ('x', 'y')}
    hip = {k: (pixel(23)[k]+pixel(24)[k])/2 for k in ('x', 'y')}
    torso = distance(shoulder, hip)
    if torso < f['height']*.03 or hip['y'] <= shoulder['y'] or distance(pixel(15), pixel(16)) < torso*.5:
        return 'body_geometry'
    if not all(valid(p[i]) for i in (0, 9, 10)):
        return 'face_confidence'
    if max(distance(pixel(15), ref['left']), distance(pixel(16), ref['right'])) > .25*ref['torsoPixels']:
        return 'wrist_drift'
    if not min(ref['left']['x'], ref['right']['x'])-.2*ref['torsoPixels'] <= pixel(0)['x'] <= max(ref['left']['x'], ref['right']['x'])+.2*ref['torsoPixels']:
        return 'face_outside_hands'
    if (pixel(9)['y']+pixel(10)['y'])/2 < pixel(0)['y']:
        return 'mouth_above_nose'
    return 'accepted'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audit', default='pose-face-audit-v2')
    args = parser.parse_args()
    if not args.audit.replace('-', '').isalnum():
        raise SystemExit('Invalid audit version')
    folder = BASE / 'human-reviews' / args.audit
    raw = (folder/'rows.json.gz').read_bytes()
    rows = json.loads(gzip.decompress(raw))['rows']
    report, controls, caches = [], 0, {}
    for r in rows:
        if not r['screened']:
            continue
        proxy = r['proxy']
        if proxy.get('reason') in ('reference_wrists_unavailable', 'reference_wrists_unstable'):
            report.append(dict(uid=r['uid'], reason=proxy['reason']))
            continue
        job = r['jobId']
        if job not in caches:
            caches[job] = json.loads(gzip.decompress((BASE/'poses'/(job+'.json.gz')).read_bytes()))
        top, start = r['phase']['top']*1000, r['phase']['start']*1000
        local = [f for f in caches[job]['frames'] if max(start, top-200) <= f['now'] <= top]
        counts = {}
        for f in local:
            reason = frame_reason(f, proxy['reference'])
            counts[reason] = counts.get(reason, 0)+1
        accepted = counts.get('accepted', 0)
        enough = len(local) > 0 and accepted >= 3 and accepted/len(local) >= .8
        assert enough == (proxy['state'] == 'measured'), r['uid']
        if proxy['state'] == 'measured':
            controls += 1
        else:
            report.append(dict(uid=r['uid'], reason=proxy['reason'], counts=counts))
    result = dict(auditRowsSha256=hashlib.sha256(raw).hexdigest(),
                  sourceSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  measuredPositiveControls=controls, refusals=report,
                  scope='Replay of unchanged legacy proxy filters, not an image-based landmark accuracy estimate.')
    with (folder/'proxy-rejections.json').open('x') as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
