"""Freeze a small, channel-diverse upper-height diagnostic packet; never relabel."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'pullups/dataset_mediapipe_gpu'
RESEARCH = BASE / 'human-reviews/top-proxy-v1'
OUT = BASE / 'human-reviews/expanded-3d/review/top-proxy'
APPROVED = RESEARCH / 'review-selection.json'


def refresh_ui():
    data = json.loads((OUT / 'packet-data.json').read_text())
    assert data['items'] == json.loads(APPROVED.read_text())['items']
    shared = (ROOT / 'pullups/partial_subtype_review.template.html').read_text()
    css = re.search(r'<style>(.*?)</style>', shared, re.S).group(1)
    template = (ROOT / 'pullups/top_proxy_review.template.html').read_text()
    html = template.replace('__REVIEW_STYLE__', css).replace('__TOP_DATA__', json.dumps(data, separators=(',', ':')))
    html = html.replace('__TOP_JS__', (ROOT / 'pullups/top_proxy_review.js').read_text())
    (OUT / 'index.html').write_text(html)


def rank(row):
    m = row['measurement']; peak = m.get('peak') or {}
    state = peak.get('mouth', {}).get('state')
    conflict = (row['label'] == 1 and state == 'above') or (row['label'] == 0 and state == 'below')
    priority = 0 if conflict else 1 if row['label'] == 0 else 2 if state == 'near' else 3 if m['state'] == 'unavailable' else 4
    return priority, row['uid']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--refresh-ui', action='store_true')
    args = parser.parse_args()
    if args.refresh_ui:
        refresh_ui()
        return
    if APPROVED.exists() or (OUT / 'packet-data.json').exists():
        raise SystemExit('Packet frozen; use --refresh-ui.')
    result_bytes = (RESEARCH / 'results.json').read_bytes()
    report = json.loads(result_bytes)
    current = (BASE / 'human-reviews/criterion-labels.json').read_bytes()
    assert report['reviewSha256'] == hashlib.sha256(current).hexdigest()
    by_group = {}
    for row in report['rows']:
        assert row['split'] != 'test'
        by_group.setdefault(row['group'], []).append(row)
    chosen = sorted([min(rows, key=rank) for rows in by_group.values()], key=rank)
    assert len(chosen) == 12
    source = json.loads((BASE / 'manifest.json').read_text())
    jobs = {j['id']: j for j in source['jobs']}
    test_groups = {s['group'] for j in source['jobs'] for s in j['samples'] if s['split'] == 'test'}
    OUT.mkdir(parents=True, exist_ok=True)
    items, poses, times, caches = [], {}, {}, {}
    for number, row in enumerate(chosen, 1):
        assert row['group'] not in test_groups
        uid = row['uid']; job = jobs[row['jobId']]; phase = row['phase']
        begin = max(0, phase['bottom'] - .4)
        end = min(phase['top'] + .4, phase['fullEnd'])
        filename = f'clip-{number:02}.mp4'; dest = OUT / filename
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '2',
            '-ss', str(begin), '-i', row['sourceVideo'], '-t', str(end-begin), '-vf', 'scale=-2:720,fps=25',
            '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart', str(dest)], check=True)
        info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'format=duration:frame=best_effort_timestamp_time', '-of', 'json', str(dest)]))
        item = dict(id=uid, file=filename, sourceStart=begin, duration=float(info['format']['duration']),
                    windowStart=phase['bottom']-begin, windowEnd=phase['top']-begin,
                    sha256=hashlib.sha256(dest.read_bytes()).hexdigest(), priorTop=row['label'],
                    measurement=row['measurement'])
        assert 0 <= item['windowStart'] < item['windowEnd'] < item['duration']
        items.append(item)
        times[uid] = [float(f['best_effort_timestamp_time']) for f in info['frames']]
        if job['id'] not in caches:
            raw = (BASE / 'poses' / f"{job['id']}.json.gz").read_bytes()
            assert hashlib.sha256(raw).hexdigest() == row['rawCacheSha256']
            cache = json.loads(gzip.decompress(raw)); assert cache['fingerprint'] == job['fingerprint']
            caches[job['id']] = cache
        poses[uid] = [dict(t=round(f['now']/1000-begin, 5),p=None if not f['landmarks'] else
            [[p['x'],p['y'],min(p.get('visibility',0),p.get('presence',1))] for p in f['landmarks']])
            for f in caches[job['id']]['frames'] if begin <= f['now']/1000 <= begin+item['duration']]
        print(f'{number}/12 {uid}', flush=True)
    packet = dict(packetId='top-proxy-review-01',items=items,poses=poses,frameTimes=times)
    (OUT / 'packet-data.json').write_text(json.dumps(packet, separators=(',', ':')))
    APPROVED.write_text(json.dumps(dict(items=items, rows=chosen,
        resultSha256=hashlib.sha256(result_bytes).hexdigest(),
        note='One development clip per each of 12 accepted channels. Prioritize definite proxy disagreement, normal tops, near-line cases, unavailable measurements, then controls. '
             'Not an independent test. Prior label and proxy comparison hidden initially. New answers do not overwrite old labels.'), ensure_ascii=False, indent=2)+'\n')
    refresh_ui()


if __name__ == '__main__':
    main()
