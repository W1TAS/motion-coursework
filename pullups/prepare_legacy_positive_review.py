"""Freeze a small legacy-positive clarification packet; refresh UI separately."""
import argparse
import csv
import gzip
import hashlib
import json
from pathlib import Path
import random
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'pullups/dataset_mediapipe_gpu'
OUT = BASE / 'human-reviews/expanded-3d/review/legacy-positive'
MANIFEST = BASE / 'human-reviews/review-04-selection.json'
# Mid-movement frames inspected before freezing. View remains a human question.
# Distinct development channels; 8 legacy partial positives, 4 swing positives.
SELECTED = [
 'pool:xd2z_8dM120_6_6', 'pool:drG-mYmRbfs_1_2', 'pool:4NLSEnVqP8Q_1_1',
 'pool:Et8LuxZFtaw_0_2', 'pool:41MfaaNz408_0_6', 'pool:bi2A0tAEoMs_0_1',
 'pool:dc7ptiv8O5A_0_20', 'pool:nyrdnyxTEk4_0_20', 'pool:u8cd9wmVn9I_0_12',
 'pool:VN9DSQSBYxI_0_8', 'pool:fkRpV2DhQeo_0_6', 'pool:6lQHxxUsHaQ_0_0',
]


def refresh_ui():
    data = json.loads((OUT / 'packet-data.json').read_text())
    approved = json.loads(MANIFEST.read_text())
    assert data['items'] == approved['items'], 'Frozen packet changed'
    template = (ROOT / 'pullups/criterion_review_fast.html').read_text()
    script = (ROOT / 'pullups/criterion_review_fast.js').read_text()
    html = template.replace('__FAST_JS__', script).replace('__REVIEW_DATA__', json.dumps(data, separators=(',', ':')))
    (OUT / 'index.html').write_text(html)
    archive = BASE / 'human-reviews/pullup-criteria-04.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
        for name in ['index.html', *[i['file'] for i in data['items']]]:
            z.write(OUT / name, 'pullup-criteria-04/' + name)
    print('UI refreshed; frozen clips, identities and browser storage unchanged.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--refresh-ui', action='store_true')
    args = parser.parse_args()
    if args.refresh_ui:
        refresh_ui()
        return
    if MANIFEST.exists() or (OUT / 'packet-data.json').exists():
        raise SystemExit('Packet already frozen. Use --refresh-ui for interface changes.')
    manifest = json.loads((BASE / 'manifest.json').read_text())
    samples = {s['uid']: (j, s) for j in manifest['jobs'] for s in j['samples']}
    test_groups = {s['group'] for _, s in samples.values() if s['split'] == 'test'}
    previous = json.loads((BASE / 'human-reviews/criterion-labels.json').read_text())
    previous_uids = {r['uid'] for r in previous['rows']}
    reps = {r['rep_id']: r for r in csv.DictReader((ROOT / 'pullups/data_expanded/reps.csv').open())}
    selected = list(SELECTED)
    random.Random(291104).shuffle(selected)
    assert len({samples[u][1]['group'] for u in selected}) == len(selected)
    OUT.mkdir(parents=True, exist_ok=True)
    items, poses, times, suggestions, private = [], {}, {}, {}, []
    for number, uid in enumerate(selected, 1):
        job, sample = samples[uid]
        assert sample['split'] != 'test' and sample['group'] not in test_groups and uid not in previous_uids
        assert sample['partial'] == '1' or sample['swing'] == '1'
        begin, end = max(0, float(sample['start']) - 1), float(sample['end']) + .6
        filename = f'clip-{number:02}.mp4'
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '2',
                        '-ss', str(begin), '-i', job['video'], '-t', str(end - begin),
                        '-vf', 'scale=-2:640,fps=25', '-an', '-c:v', 'libx264', '-threads', '2',
                        '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(OUT / filename)], check=True)
        info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'format=duration:frame=best_effort_timestamp_time', '-of', 'json', str(OUT / filename)]))
        item = dict(id=uid, file=filename, sourceStart=begin, duration=float(info['format']['duration']),
                    windowStart=float(sample['start']) - begin, windowEnd=float(sample['end']) - begin,
                    sha256=hashlib.sha256((OUT / filename).read_bytes()).hexdigest())
        assert item['windowEnd'] <= item['duration'] + .05
        items.append(item)
        times[uid] = [float(f['best_effort_timestamp_time']) for f in info['frames']]
        cache_bytes = (BASE / 'poses' / f"{job['id']}.json.gz").read_bytes()
        cache = json.loads(gzip.decompress(cache_bytes))
        assert cache['fingerprint'] == job['fingerprint']
        poses[uid] = [dict(t=round(f['now'] / 1000 - begin, 4), p=None if not f['landmarks'] else
            [[round(p['x'], 5), round(p['y'], 5), round(min(p.get('visibility', 0), p.get('presence', 1)), 3)] for p in f['landmarks']])
            for f in cache['frames'] if begin <= f['now'] / 1000 <= begin + item['duration']]
        top = float(reps[sample['rep_id']]['top']) - begin
        if 0 <= item['windowStart'] < top < item['duration']:
            suggestions[uid] = dict(times=dict(bottom=item['windowStart'], top=top), method='legacy-automatic-phase-hints-v1')
        private.append(dict(clip=number, uid=uid, sample=sample, video=job['video'], job_id=job['id'],
                            source_pose_sha256=hashlib.sha256(cache_bytes).hexdigest(),
                            legacy_view_origin='Automatic face-landmark-confidence heuristic, not a human answer',
                            preliminary_frame_check='Face/front or oblique visible in sampled frame; final view must be labelled by user'))
        print(f'{number}/{len(selected)} {uid}', flush=True)
    packet = dict(items=items, poses=poses, frameTimes=times, suggestions=suggestions)
    (OUT / 'packet-data.json').write_text(json.dumps(packet, separators=(',', ':')))
    MANIFEST.write_text(json.dumps(dict(items=items, rows=private,
        note='Targeted legacy-positive development audit, 12 distinct channels. Eight partial-positive and four swing-positive samples. '
             'Legacy facing is automatic and unverified; legacy labels/categories hidden in UI. '
             'Human annotation covers initial bottom and ascent; return not required. Phase hints require explicit confirmation. '
             'No reserved test groups and no prior completed criterion UIDs. Not representative accuracy data.'), ensure_ascii=False, indent=2) + '\n')
    refresh_ui()


if __name__ == '__main__':
    main()
