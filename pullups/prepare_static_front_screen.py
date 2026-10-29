"""Freeze a camera/view screening packet for reviewed development pullups.

Camera evidence uses background tracks, never wrist or face height predictions.
Human exercise labels stay separate from the agent's subsequent visual view audit.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'pullups/dataset_mediapipe_gpu'
RULES = dict(sampleIntervalMs=200, maxDisplacementAt640=6, minTracks=20,
             minInlierFraction=.65, minGridCells=4, forwardBackwardPixels=1,
             ransacPixels=2, minReliableFraction=.9)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def background_mask(frame):
    """Exclude the tracked subject with margin; do not infer camera from them."""
    h, w = frame['height'], frame['width']
    mask = np.full((h, w), 255, np.uint8)
    points = [(p['x'] * w, p['y'] * h) for p in (frame['landmarks'] or [])
              if min(p.get('visibility', 0), p.get('presence', 1)) >= .45
              and np.isfinite(p['x']) and np.isfinite(p['y'])]
    if not points:
        return np.zeros_like(mask)
    x, y = np.array(points).T
    margin = max(25, .15 * (y.max() - y.min()))
    cv2.rectangle(mask, (max(0, int(x.min() - margin)), max(0, int(y.min() - margin))),
                  (min(w - 1, int(x.max() + margin)), min(h - 1, int(y.max() + margin))), 0, -1)
    return mask


def estimate_background_motion(first, current, first_mask, current_mask):
    """Direct-to-first affine estimate avoids accumulation of tracking drift."""
    points = cv2.goodFeaturesToTrack(first, maxCorners=600, qualityLevel=.02,
                                    minDistance=10, mask=first_mask)
    if points is None or len(points) < RULES['minTracks']:
        return dict(state='unknown', reason='few_background_features')
    options = dict(winSize=(31, 31), maxLevel=4,
                   criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, .01))
    following, ok, _ = cv2.calcOpticalFlowPyrLK(first, current, points, None, **options)
    if following is None:
        return dict(state='unknown', reason='tracking_failed')
    returned, back_ok, _ = cv2.calcOpticalFlowPyrLK(current, first, following, None, **options)
    if returned is None:
        return dict(state='unknown', reason='backtracking_failed')
    p, q = points.reshape(-1, 2), following.reshape(-1, 2)
    h, w = first.shape
    finite = np.isfinite(q).all(axis=1)
    inside = finite & (q[:, 0] >= 0) & (q[:, 0] < w) & (q[:, 1] >= 0) & (q[:, 1] < h)
    bg = np.zeros(len(q), dtype=bool)
    bg[inside] = current_mask[q[inside, 1].astype(int), q[inside, 0].astype(int)] > 0
    good = (ok.ravel() > 0) & (back_ok.ravel() > 0) & bg
    good &= np.linalg.norm(returned.reshape(-1, 2) - p, axis=1) <= RULES['forwardBackwardPixels']
    p, q = p[good], q[good]
    if len(p) < RULES['minTracks']:
        return dict(state='unknown', reason='few_background_tracks', tracks=len(p))
    cv2.setRNGSeed(0)
    matrix, inliers = cv2.estimateAffinePartial2D(p, q, method=cv2.RANSAC,
                        ransacReprojThreshold=RULES['ransacPixels'], maxIters=2000,
                        confidence=.99, refineIters=10)
    if matrix is None:
        return dict(state='unknown', reason='no_background_consensus', tracks=len(p))
    accepted = p[inliers.ravel() > 0]
    cells = {(min(3, int(x / w * 4)), min(2, int(y / h * 3))) for x, y in accepted}
    ratio = len(accepted) / len(p)
    if len(accepted) < RULES['minTracks'] or ratio < RULES['minInlierFraction'] or len(cells) < RULES['minGridCells']:
        return dict(state='unknown', reason='weak_background_consensus', tracks=len(p),
                    inliers=len(accepted), inlierFraction=ratio, gridCells=len(cells))
    corners = np.array([[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]], float)
    moved = corners @ matrix[:, :2].T + matrix[:, 2]
    displacement = float(np.linalg.norm(moved - corners, axis=1).max() * 640 / h)
    return dict(state='measured', displacementAt640=displacement, tracks=len(p),
                inliers=len(accepted), inlierFraction=ratio, gridCells=len(cells), matrix=matrix.tolist())


def summarize_camera(measurements):
    good = [r for r in measurements if r['state'] == 'measured']
    peak = max((r['displacementAt640'] for r in good), default=None)
    # A reliable motion observation rejects even if other frames were unavailable.
    if peak is not None and peak > RULES['maxDisplacementAt640']:
        state = 'moving'
    elif not measurements or len(good) / len(measurements) < RULES['minReliableFraction']:
        state = 'unknown'
    else:
        state = 'near_static'
    return dict(state=state, measured=len(good), attempted=len(measurements),
                maxDisplacementAt640=peak)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', default='static-front-v1')
    args = parser.parse_args()
    if not args.out.replace('-', '').isalnum():
        raise SystemExit('Invalid version')
    out = BASE / 'human-reviews' / args.out
    if out.exists():
        raise SystemExit('Output exists; choose a new version')
    audit_raw = (BASE / 'human-reviews/pose-face-audit-v2/rows.json.gz').read_bytes()
    audit = json.loads(gzip.decompress(audit_raw))
    grouped = {}
    for row in audit['rows']:
        if row['screened'] and row['split'] != 'test':
            grouped.setdefault(row['jobId'], []).append(row)
    manifest_raw = (BASE / 'manifest.json').read_bytes()
    jobs = {j['id']: j for j in json.loads(manifest_raw)['jobs']}
    out.mkdir()
    (out / 'images').mkdir()
    protocol = dict(schema=1, testUsed=False, rules=RULES,
        auditSha256=sha(audit_raw), manifestSha256=sha(manifest_raw),
        sourceSha256=sha(Path(__file__).read_bytes()),
        candidates='All previously screened criterion-reviewed train+val examples, no largest-channel removal or prediction-based selection.',
        scope='Whole cached development fragment, sampled every 200 ms, background affine motion to first frame with tracked subject masked. Near-static means <=6px at height640, not mathematically zero motion.',
        view='Agent visual front/near-front audit saved separately before evaluation. No exact angle inferred from skeleton symmetry. Unknown/back/large-oblique excluded.',
        limitations='Background consensus is a diagnostic, not a validated camera classifier; other moving people, source edits, few features, and motion between samples can affect it. Scene-level view must agree with all reviewed repetition images.')
    (out / 'protocol.json').write_text(json.dumps(protocol, indent=2) + '\n')
    scenes = []
    for number, (job_id, rows) in enumerate(sorted(grouped.items()), 1):
        job = jobs[job_id]
        assert all(s['split'] != 'test' for s in job['samples'])
        raw = (BASE / 'poses' / (job_id + '.json.gz')).read_bytes()
        cache = json.loads(gzip.decompress(raw))
        assert cache['fingerprint'] == job['fingerprint']
        frames = cache['frames']
        times = np.arange(frames[0]['now'], frames[-1]['now'] + 1, RULES['sampleIntervalMs']).tolist()
        times.append(frames[-1]['now'])
        indexes = sorted({min(range(len(frames)), key=lambda i: abs(frames[i]['now'] - t)) for t in times})
        cap = cv2.VideoCapture(job['video'])
        assert cap.isOpened(), job_id

        def decode(f):
            cap.set(cv2.CAP_PROP_POS_MSEC, f['now'])
            ok, image = cap.read()
            assert ok, (job_id, f['now'])
            return cv2.resize(image, (f['width'], f['height']))

        first = decode(frames[indexes[0]])
        first_gray = cv2.cvtColor(first, cv2.COLOR_BGR2GRAY)
        mask = background_mask(frames[indexes[0]])
        measurements = []
        for i in indexes[1:]:
            f = frames[i]
            image = decode(f)
            result = estimate_background_motion(first_gray, cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), mask, background_mask(f))
            measurements.append(dict(timeMs=f['now'], **result))
        # Every reviewed start/top is visible to the angle audit, not only a scene's first frame.
        tiles = []
        image_records = []
        for row in rows:
            for phase in ('start', 'top'):
                f = min(frames, key=lambda f: abs(f['now'] - row['phase'][phase] * 1000))
                image = decode(f)
                shown = cv2.resize(image, (455, 256))
                tile = np.full((280, 455, 3), 245, np.uint8)
                tile[24:] = shown
                cv2.putText(tile, row['uid'].split(':')[-1] + ' ' + phase, (5, 16), cv2.FONT_HERSHEY_SIMPLEX, .4, (10, 10, 10), 1)
                tiles.append(tile)
                image_records.append(dict(uid=row['uid'], phase=phase, timeMs=f['now']))
        montage = np.vstack([np.hstack(tiles[i:i+2]) for i in range(0, len(tiles), 2)])
        filename = f'scene-{number:02}.jpg'
        cv2.imwrite(str(out / 'images' / filename), montage)
        cap.release()
        scenes.append(dict(id=job_id, number=number, group=rows[0]['group'],
            cacheSha256=sha(raw), video=job['video'], image=filename,
            imageSha256=sha((out / 'images' / filename).read_bytes()), imageFrames=image_records,
            camera=summarize_camera(measurements), cameraFrames=measurements,
            samples=[dict(uid=r['uid'], phase=r['phase']) for r in rows]))
        print(job_id, len(rows), scenes[-1]['camera'], flush=True)
    (out / 'screening-evidence.json').write_text(json.dumps(dict(scenes=scenes), indent=2) + '\n')
    (out / 'sources/pullups').mkdir(parents=True)
    (out / 'sources/pullups/prepare_static_front_screen.py').write_bytes(Path(__file__).read_bytes())


if __name__ == '__main__':
    main()
