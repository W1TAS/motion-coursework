"""Materialize automatic ascent windows from raw MediaPipe caches, without relabelling.

Reserved test times remain in the manifest, but their poses are not read/exported.
Coordinates are raw; no full-cycle normalization/smoothing can leak descent data.
"""
import argparse
from collections import Counter
import csv
import gzip
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'pullups/dataset_mediapipe_gpu'


def frames_between(frames, begin, end):
    return [f for f in frames if begin * 1000 - 1e-6 <= f['now'] <= end * 1000 + 1e-6]


def compact(frames, origin):
    return [dict(t=f['now'] / 1000 - origin, width=f['width'], height=f['height'],
                 p=None if not f['landmarks'] else [[p.get(k) for k in ('x', 'y', 'z', 'visibility', 'presence')]
                                                   for p in f['landmarks']]) for f in frames]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=BASE / 'ascent-v1')
    args = parser.parse_args()
    out = args.out
    if (out / 'manifest.json').exists():
        raise SystemExit('Export frozen; choose a new output directory for a new version.')
    raw_manifest = (BASE / 'manifest.json').read_bytes()
    manifest = json.loads(raw_manifest)
    reps = {r['rep_id']: r for r in csv.DictReader((ROOT / 'pullups/data_expanded/reps.csv').open())}
    review_bytes = (BASE / 'human-reviews/criterion-labels.json').read_bytes()
    review_data = json.loads(review_bytes)
    reviews = {r['uid']: r for r in review_data['rows']}
    skipped = {r['uid']: r for r in review_data['skipped']}
    rows = []
    for job in manifest['jobs']:
        for sample in job['samples']:
            begin, full_end = float(sample['start']), float(sample['end'])
            top = float(reps[sample['rep_id']]['top'])
            if not begin < top < full_end:
                raise ValueError('Legacy phase times are not ordered')
            review = reviews.get(sample['uid'])
            rows.append(dict(uid=sample['uid'], job_id=job['id'], group=sample['group'],
                split=sample['split'], fold=sample['fold'], start=begin, top=top, full_end=full_end,
                source_phase_origin='legacy_automatic_detector', facing_auto=sample.get('facing'),
                facing_human=review.get('facing') if review else None,
                legacy_labels={k: int(sample[k]) for k in ('partial', 'swing', 'asym')},
                criterion_labels=review['targets'] if review else dict.fromkeys(('bottom_incomplete', 'top_below_bar', 'swing_ascent')),
                human_phase_reference=review.get('phase_times') if review else None,
                human_phase_sources=review.get('phase_annotation_sources') if review else None,
                excluded_by_review=skipped.get(sample['uid']),
                export_status='reserved_test_not_exported' if sample['split'] == 'test' else 'pending'))
    by_job = {}
    for row in rows:
        if row['split'] != 'test':
            by_job.setdefault(row['job_id'], []).append(row)
    jobs = {j['id']: j for j in manifest['jobs']}
    counts, total_frames, total_bottom_frames = Counter(), 0, 0
    out.mkdir(parents=True, exist_ok=True)
    with gzip.open(out / 'development.jsonl.gz', 'wt', encoding='utf-8') as stream:
        for job_id, samples in by_job.items():
            job = jobs[job_id]
            cache_bytes = (BASE / 'poses' / f'{job_id}.json.gz').read_bytes()
            cache = json.loads(gzip.decompress(cache_bytes))
            if cache['fingerprint'] != job['fingerprint']:
                raise ValueError('Raw pose provenance mismatch')
            cache_sha = hashlib.sha256(cache_bytes).hexdigest()
            frames = cache['frames']
            if any(b['now'] <= a['now'] for a, b in zip(frames, frames[1:])):
                raise ValueError('Non-monotonic source poses')
            for row in samples:
                ascent = frames_between(frames, row['start'], row['top'])
                # Initial-state context, never the descent after this ascent.
                bottom = frames_between(frames, row['start'] - .12, min(row['start'] + .12, row['top']))
                available = [f for f in ascent if f['landmarks']]
                covered = bool(ascent and ascent[0]['now'] / 1000 <= row['start'] + .08
                               and ascent[-1]['now'] / 1000 >= row['top'] - .08)
                status = 'candidate' if covered and len(available) >= 6 else 'insufficient_pose_coverage'
                row.update(export_status=status, frames=len(ascent), frames_with_pose=len(available),
                           initial_context_frames=len(bottom), source_cache_sha256=cache_sha,
                           delegate=cache.get('delegate', 'unknown'))
                counts[status] += 1
                total_frames += len(ascent); total_bottom_frames += len(bottom)
                payload = dict(uid=row['uid'], frames=compact(ascent, row['start']),
                               initial_context=compact(bottom, row['start']))
                stream.write(json.dumps(payload, separators=(',', ':'), allow_nan=False) + '\n')
    report = dict(schema=1, source_manifest_sha256=hashlib.sha256(raw_manifest).hexdigest(),
        review_sha256=hashlib.sha256(review_bytes).hexdigest(), rows=rows,
        counts=dict(all_windows=len(rows), development_windows=sum(counts.values()),
                    reserved_test_not_exported=sum(r['split'] == 'test' for r in rows),
                    statuses=dict(counts), ascent_frames=total_frames, initial_context_frames=total_bottom_frames),
        protocol='Automatic old start-to-top timestamps; raw MediaPipe coordinates, no following descent, no normalization or smoothing. Initial context is a separate ±120ms window.',
        point_channels=['x', 'y', 'z', 'visibility', 'presence'],
        limitations=['Automatic temporal crops are candidates, not verified human boundaries.',
                     'Pose presence/coverage is not pose accuracy or training eligibility.',
                     'Old partial/swing/asym remain full-cycle labels. Unknown subtypes stay null.',
                     'One final bottom state of the old full cycle may differ from its initial state.',
                     'Test data are retained as reserved metadata only; no test pose access or metric selection.',
                     'Training/app model unchanged; no original cache or label writes.'])
    (out / 'manifest.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report['counts'], indent=2))


if __name__ == '__main__':
    main()
