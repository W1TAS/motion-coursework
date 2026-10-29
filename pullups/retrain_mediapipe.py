#!/usr/bin/env python3
"""Resumable offline MediaPipe extraction, grouped CV, then held-out comparison.

Run from any directory with pullups/.venv/bin/python. No downloads or app changes.
SIGINT/SIGTERM stops the current subprocess; completed segment caches survive.
"""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import signal
import shutil
import gzip
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_json(path, value):
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    tmp.replace(path)


def prepare(out, fps, delegate='CPU', reuse_cpu=None):
    samples_path = ROOT / 'pullups/dataset_audited/samples.csv'
    samples = list(csv.DictReader(samples_path.open()))
    from train import validate_splits
    validate_splits(samples)
    grouped = {}
    for row in samples:
        assert row['source'] == 'pool', 'Personal sources need separate provenance review'
        assert float(row['end']) > float(row['start']) >= 0
        grouped.setdefault((row['video_id'], row['segment_idx']), []).append(row)
    code_paths = ['mobile/app/pose-worker.mjs', 'mobile/app/pullup-model.mjs',
                  'mobile/app/vendor/vision_bundle.mjs',
                  'mobile/app/vendor/pose_landmarker_lite.task',
                  ('mobile/research/extract-training-gpu.cjs' if delegate == 'GPU'
                   else 'mobile/research/extract-training-poses.cjs')]
    provenance = {p: digest(ROOT / p) for p in code_paths}
    provenance['samples.csv'] = digest(samples_path)
    if delegate == 'GPU':
        provenance['delegate_override'] = 'GPU; NVIDIA EGL; same model and confidence settings'
    jobs = []
    for (vid, seg), rows in sorted(grouped.items()):
        files = [p for p in (ROOT / 'pullups/data_expanded/videos').glob(vid + '.*')
                 if p.suffix.lower() in ('.mp4', '.mkv', '.webm', '.mov')]
        if len(files) != 1:
            raise ValueError(f'{vid}: expected one source video, found {files}')
        video = files[0].resolve()
        start = max(0, min(float(s['start']) for s in rows) - .5)
        end = max(float(s['end']) for s in rows) + 1 / fps
        job = dict(id=f'{vid}_{seg}', video=str(video), start=start, end=end, fps=fps,
                   samples=sorted(rows, key=lambda s: (float(s['end']), float(s['start']))),
                   source_size=video.stat().st_size, source_mtime_ns=video.stat().st_mtime_ns)
        job['fingerprint'] = hashlib.sha256(json.dumps([job, provenance], sort_keys=True).encode()).hexdigest()
        jobs.append(job)
    manifest = dict(version=1, fps=fps, provenance=provenance, jobs=jobs,
                    note='Annotated windows; causal features, at most 60 s history. Not end-to-end counter accuracy.')
    old = out / 'manifest.json'
    if delegate == 'GPU':
        manifest['delegate'] = 'GPU'
        manifest['cache_reuse'] = []
    if reuse_cpu is not None:
        if delegate != 'GPU':
            raise ValueError('--reuse-cpu requires --delegate GPU')
        # Retain the original fingerprint and the exact cache bytes for CPU jobs.
        # New GPU jobs have their own fingerprint; the mixed origin is explicit.
        reuse_cpu = reuse_cpu.resolve()
        parent = json.loads((reuse_cpu / 'manifest.json').read_text())
        assert parent.get('delegate', 'CPU') == 'CPU'
        assert parent['fps'] == fps
        for key, value in parent['provenance'].items():
            if key != 'mobile/research/extract-training-poses.cjs':
                assert provenance.get(key) == value, f'CPU cache inputs differ: {key}'
        originals = {j['id']: j for j in parent['jobs']}
        pinned = ({r['id'] for r in json.loads(old.read_text())['cache_reuse']}
                  if old.exists() else None)
        manifest['parent_cpu_manifest_sha256'] = digest(reuse_cpu / 'manifest.json')
        (out / 'poses').mkdir(exist_ok=True)
        for job in jobs:
            source = reuse_cpu / 'poses' / (job['id'] + '.json.gz')
            if pinned is not None and job['id'] not in pinned or not source.exists():
                continue
            original = originals[job['id']]
            assert {k: v for k, v in job.items() if k != 'fingerprint'} == {
                k: v for k, v in original.items() if k != 'fingerprint'}
            cached = json.loads(gzip.decompress(source.read_bytes()))
            assert cached['fingerprint'] == original['fingerprint']
            job['fingerprint'] = original['fingerprint']
            job['delegate'] = 'CPU'
            job['inherited_from'] = manifest['parent_cpu_manifest_sha256']
            manifest['cache_reuse'].append(dict(id=job['id'], delegate='CPU', sha256=digest(source)))
            target = out / 'poses' / source.name
            if target.exists():
                assert digest(target) == digest(source), f'Changed inherited cache {target}'
            else:
                shutil.copy2(source, target)
        print(f'Reused {len(manifest["cache_reuse"])} CPU segment caches; remaining segments use GPU', flush=True)
    if old.exists() and json.loads(old.read_text()) != manifest:
        raise ValueError('Inputs changed: choose a new --out directory rather than mixing runs')
    atomic_json(old, manifest)
    print(f'Prepared {len(jobs)} segments, {len(samples)} labels, '
          f'{sum(j["end"]-j["start"] for j in jobs)/60:.1f} minutes of video', flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--out', type=Path)
    ap.add_argument('--delegate', choices=['CPU', 'GPU'], default='CPU')
    ap.add_argument('--reuse-cpu', type=Path, help='Preserve validated CPU caches with explicit per-segment provenance')
    ap.add_argument('--fps', type=int, default=25)
    ap.add_argument('--prepare-only', action='store_true')
    args = ap.parse_args()
    if not 10 <= args.fps <= 30:
        ap.error('--fps must be between 10 and 30')
    out = (args.out or ROOT / ('pullups/dataset_mediapipe_gpu' if args.delegate == 'GPU'
                              else 'pullups/dataset_mediapipe')).resolve()
    out.mkdir(parents=True, exist_ok=True)
    # Kernel lock is released on crashes as well as normal shutdown.
    import fcntl
    lock = (out / 'run.lock').open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('This output directory already has an active run')
    prepare(out, args.fps, args.delegate, args.reuse_cpu)
    if args.prepare_only:
        return
    child = None
    def stop(signum, _frame):
        if child is not None and child.poll() is None:
            child.send_signal(signal.SIGTERM)
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    started = datetime.now(timezone.utc).isoformat()
    def status(state, **extra):
        atomic_json(out / 'status.json', dict(state=state, pid=os.getpid(), started=started,
                    updated=datetime.now(timezone.utc).isoformat(), **extra))
    try:
        for phase, cmd in [
            ('extracting', ['node', str(ROOT / 'mobile/research' /
                ('extract-training-gpu.cjs' if args.delegate == 'GPU' else 'extract-training-poses.cjs')), str(out)]),
            ('training', [sys.executable, str(ROOT / 'pullups/train_mediapipe_features.py'), '--out', str(out)]),
        ]:
            status(phase)
            child = subprocess.Popen(cmd, cwd=ROOT)
            rc = child.wait()
            if rc:
                raise RuntimeError(f'{phase} exited with {rc}')
        status('complete')
        print(f'Complete. Report: {out / "model/evaluation_test.json"}', flush=True)
    except KeyboardInterrupt:
        if child is not None:
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        status('stopped', note='Rerun the same command to resume completed segment caches')
        print('Stopped; completed caches preserved.', flush=True)
    except Exception as exc:
        status('failed', error=str(exc))
        raise


if __name__ == '__main__':
    main()
