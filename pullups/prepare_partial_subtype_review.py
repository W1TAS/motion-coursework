"""Prepare the frozen, one-question legacy partial-subtype viewer."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'pullups/dataset_mediapipe_gpu'
OUT = BASE / 'human-reviews/expanded-3d/review/partial-subtypes'
APPROVED = BASE / 'human-reviews/partial-subtypes-selection.json'
# Checked representative frames for every selected segment before publishing.
# These are sampling exclusions, not relabelled technique or human view answers.
SAMPLING_EXCLUSIONS = {
    '-phbNTs-SwU': 'Rear view in the selected segment',
    '13mjJ59UKOE': 'Rear view in the selected segment',
    '6LLs8PFnevo': 'Rear view in the selected segment',
    'Aj1hMhKKlak': 'Rear view in both selected segments',
    'CsGvVtj5tdg': 'Rear/side view in the selected segment',
    'Gu22bA5oZ64': 'Rendered anatomy animation, not a human recording',
    'VDixSPMKxUA': 'Rear view in both selected segments',
    'dMcOvSL1Ob4': 'Rear view in the selected segment',
    'nPgovRqfXf0': 'Rear view in the selected segment',
}


def refresh_ui():
    data = json.loads((OUT / 'packet-data.json').read_text())
    assert data['items'] == json.loads(APPROVED.read_text())['items']
    html = (ROOT / 'pullups/partial_subtype_review.template.html').read_text()
    html = html.replace('__SUBTYPE_JS__', (ROOT / 'pullups/partial_subtype_review.js').read_text())
    html = html.replace('__SUBTYPE_DATA__', json.dumps(data, separators=(',', ':')))
    (OUT / 'index.html').write_text(html)
    with zipfile.ZipFile(BASE / 'human-reviews/pullup-partial-subtypes.zip', 'w', zipfile.ZIP_DEFLATED) as z:
        for name in ['index.html', *[i['file'] for i in data['items']]]:
            z.write(OUT / name, 'pullup-partial-subtypes/' + name)
    print('Viewer ready; existing browser answers and frozen clips preserved.', flush=True)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--refresh-ui', action='store_true')
    args = p.parse_args()
    if args.refresh_ui:
        refresh_ui()
        return
    if APPROVED.exists() or (OUT / 'packet-data.json').exists():
        raise SystemExit('Packet frozen. Use --refresh-ui for interface changes.')
    queue_bytes = (BASE / 'ascent-v1/partial-subtype-candidates.json').read_bytes()
    queue = json.loads(queue_bytes)
    source = json.loads((BASE / 'manifest.json').read_text())
    lookup = {s['uid']: (j, s) for j in source['jobs'] for s in j['samples']}
    test_groups = {s['group'] for _, s in lookup.values() if s['split'] == 'test'}
    excluded = [dict(uid=c['uid'], reason=SAMPLING_EXCLUSIONS[lookup[c['uid']][1]['video_id']])
                for c in queue['items'] if lookup[c['uid']][1]['video_id'] in SAMPLING_EXCLUSIONS]
    candidates = [c for c in queue['items'] if lookup[c['uid']][1]['video_id'] not in SAMPLING_EXCLUSIONS]
    OUT.mkdir(parents=True, exist_ok=True)
    items, poses, times, private = [], {}, {}, []
    previous_job, cache = None, None
    for number, candidate in enumerate(candidates, 1):
        uid = candidate['uid'];job, sample = lookup[uid]
        assert sample['split'] != 'test' and sample['group'] not in test_groups and sample['partial'] == '1'
        assert float(sample['start']) == candidate['start'] and float(sample['end']) == candidate['full_end']
        begin = max(0, candidate['start'] - .65)
        end = min(candidate['top'] + .55, candidate['full_end'] + .15)
        filename = f'clip-{number:03}.mp4';dest = OUT / filename
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '2',
            '-ss', str(begin), '-i', job['video'], '-t', str(end - begin), '-vf', 'scale=-2:640,fps=25',
            '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '23',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(dest)], check=True)
        info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'format=duration:frame=best_effort_timestamp_time', '-of', 'json', str(dest)]))
        item = dict(id=uid, file=filename, sourceStart=begin, duration=float(info['format']['duration']),
                    windowStart=candidate['start'] - begin, windowEnd=candidate['top'] - begin,
                    sha256=hashlib.sha256(dest.read_bytes()).hexdigest())
        assert 0 <= item['windowStart'] < item['windowEnd'] < item['duration']
        items.append(item)
        times[uid] = [float(f['best_effort_timestamp_time']) for f in info['frames']]
        if previous_job != job['id']:
            cache = json.loads(gzip.decompress((BASE / 'poses' / f"{job['id']}.json.gz").read_bytes()))
            previous_job = job['id']
            assert cache['fingerprint'] == job['fingerprint']
        poses[uid] = [dict(t=round(f['now'] / 1000 - begin, 4), p=None if not f['landmarks'] else
            [[round(p['x'], 5), round(p['y'], 5), round(min(p.get('visibility', 0), p.get('presence', 1)), 3)] for p in f['landmarks']])
            for f in cache['frames'] if begin <= f['now'] / 1000 <= begin + item['duration']]
        private.append(dict(uid=uid, sample=sample, source_video=job['video'],
                            phase_proposals=dict(bottom=candidate['start'], top=candidate['top']),
                            phase_origin='legacy_automatic_not_human', view_origin='legacy_automatic_unverified'))
        print(f'{number}/{len(candidates)} {uid}', flush=True)
    (OUT / 'packet-data.json').write_text(json.dumps(dict(items=items, poses=poses, frameTimes=times), separators=(',', ':')))
    APPROVED.write_text(json.dumps(dict(items=items, rows=private, sampling_exclusions=excluded,
        source_queue_sha256=hashlib.sha256(queue_bytes).hexdigest(),
        note='Old partial-positive development windows only. Human subtype labels, not human phase or view annotations. '
             'Original labels untouched. Targeted refinement, not independent test data. No old tag or model prediction shown.'), ensure_ascii=False, indent=2) + '\n')
    refresh_ui()


if __name__ == '__main__':
    main()
