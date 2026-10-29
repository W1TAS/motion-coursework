"""Prepare a small phase/criterion review from existing development videos only."""
import gzip
import hashlib
import json
from pathlib import Path
import random
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT/'pullups/dataset_mediapipe_gpu'
OUT = BASE/'criteria-review-02'
# Visual checks of candidate frames; these are sampling exclusions, not relabels.
SAMPLING_EXCLUSIONS = {
    'Gu22bA5oZ64': 'Candidate is a rendered anatomy animation, not a human recording.',
    '6LLs8PFnevo': 'Upper-point candidate is seen from behind despite legacy front tag.',
    'Aj1hMhKKlak': 'Upper-point candidate is seen from behind despite legacy front tag.',
}


def main():
    OUT.mkdir(exist_ok=True)
    manifest = json.loads((BASE/'manifest.json').read_text())
    jobs = {s['uid']: j for j in manifest['jobs'] for s in j['samples']}
    samples = {s['uid']: s for j in manifest['jobs'] for s in j['samples']}
    previous = json.loads((BASE/'model/development-review-queue.json').read_text())['windows']
    features = json.loads((BASE/'approach-development-features.json').read_text())['rows']
    test_groups = {s['group'] for s in samples.values() if s['split'] == 'test'}
    used_groups = {r['group'] for r in previous}
    selected = [(samples[previous[i]['uid']], 'context_recheck', 2.5) for i in (1, 3, 6)]
    candidates = []
    for r in features:
        s, x = r['sample'], r['full']
        if s['split'] == 'test' or s['group'] in test_groups:
            raise ValueError('Test source in development feature file')
        if not x or s['group'] in used_groups or s['video_id'] in SAMPLING_EXCLUSIONS or s['facing'] != 'front' or not .7 <= float(s['duration']) <= 7:
            continue
        q, f = x['quality'], x['features']
        if (any(f[k] is None for k in (3, 4)) or not 15 <= f[4] <= 130 or
                not (q['nanFrac'] <= .15 and q['confidence'] >= .6 and q['maxGap'] <= .6 and q['bodyJump'] <= .2)):
            continue
        candidates.append(r)
    rng = random.Random(42)
    rng.shuffle(candidates)
    buckets = [
        ('bottom_candidate', 3, lambda s, f: s['partial'] == '1' and f[3] < 150, lambda r: r['full']['features'][3]),
        ('top_candidate', 2, lambda s, f: s['partial'] == '1' and f[4] > 65, lambda r: -r['full']['features'][4]),
        ('swing_candidate', 2, lambda s, f: s['swing'] == '1', lambda r: 0),
        ('normal_candidate', 2, lambda s, f: s['partial'] == '0' and s['swing'] == '0', lambda r: 0),
    ]
    for category, count, eligible, order in buckets:
        n = 0
        for r in sorted(candidates, key=order):
            s = r['sample']
            if s['group'] in used_groups or not eligible(s, r['full']['features']):
                continue
            selected.append((s, category, 1.25)); used_groups.add(s['group']); n += 1
            if n == count:
                break
        if n != count:
            raise ValueError(f'Insufficient distinct development groups for {category}')
    # Do not disclose candidate category/order in the human-facing packet.
    rng.shuffle(selected)
    items, poses, private, frame_times = [], {}, [], {}
    for i, (sample, category, context) in enumerate(selected, 1):
        job = jobs[sample['uid']]
        assert sample['split'] != 'test' and sample['group'] not in test_groups
        start, end = max(0, float(sample['start'])-context), float(sample['end'])+context
        filename = f'clip-{i:02}.mp4'; dest = OUT/filename
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                        '-ss', str(start), '-i', job['video'], '-t', str(end-start),
                        '-vf', 'scale=-2:640,fps=25', '-an', '-c:v', 'libx264', '-threads', '2',
                        '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
                        '-movflags', '+faststart', str(dest)], check=True)
        duration = float(json.loads(subprocess.check_output(['ffprobe', '-v', 'error',
            '-show_entries', 'format=duration', '-of', 'json', str(dest)]))['format']['duration'])
        frame_info = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', str(dest)]))
        frame_times[sample['uid']] = [float(f['best_effort_timestamp_time']) for f in frame_info['frames']]
        if duration < float(sample['end'])-start-.1:
            raise ValueError('Target not present in encoded clip')
        items.append(dict(id=sample['uid'], file=filename, sourceStart=start, duration=duration,
                          windowStart=float(sample['start'])-start, windowEnd=float(sample['end'])-start,
                          sha256=hashlib.sha256(dest.read_bytes()).hexdigest()))
        cached = json.loads(gzip.decompress((BASE/'poses'/f"{job['id']}.json.gz").read_bytes()))
        assert cached['fingerprint'] == job['fingerprint']
        frames = []
        for frame in cached['frames']:
            t = frame['now']/1000-start
            if not 0 <= t <= duration:
                continue
            points = frame['landmarks']
            frames.append(dict(t=round(t, 4), p=None if not points else [
                [round(p['x'], 5), round(p['y'], 5), round(min(p.get('visibility', 0), p.get('presence', 1)), 3)] for p in points]))
        poses[sample['uid']] = frames
        private.append(dict(clip=i, sample=sample, category=category, video=job['video'],
                            job_id=job['id'], cached_delegate=cached.get('delegate'),
                            sourceStart=start, sourceEnd=start+duration))
        print(filename, category, sample['uid'], flush=True)
    assert len({r['sample']['group'] for r in private}) == 12
    template = (ROOT/'pullups/criterion_review.html').read_text()
    html = template.replace('__ITEMS__', json.dumps(items, ensure_ascii=False)).replace('__POSES__', json.dumps(poses, separators=(',', ':'))).replace('__FRAME_TIMES__', json.dumps(frame_times, separators=(',', ':')))
    (OUT/'index.html').write_text(html)
    (OUT/'README.txt').write_text(
        'Распакуйте архив полностью. Откройте index.html в браузере на компьютере. Интернет не нужен.\n'
        '12 клипов: 9 новых и 3 с расширенным контекстом из первой партии. Прогнозы и старые метки скрыты.\n'
        'Сначала ответьте по видео. Отметьте кадры низа, верха и возврата либо «Не видно». '
        'Утрированная ошибка — отдельный тип попытки, её не нужно отбрасывать как другое движение.\n'
        'Скелет включается отдельно; оценка его качества не заменяет оценку техники. '
        'Если точки отсутствуют вне сохранённого диапазона, это не ошибка человека.\n'
        'Нажмите «Сохранить ответы JSON» и передайте pullup-criteria-02-answers.json. Можно сохранять частями.\n')
    (BASE/'human-reviews/review-02-selection.json').write_text(json.dumps(dict(
        note='Development only; source-group diversity, targeted candidates and controls. '
             'Legacy labels are sampling hints, not validated answers. Not a representative test. '
             'Different channels do not guarantee absence of reposts.',
        sampling_exclusions=SAMPLING_EXCLUSIONS, items=items, rows=private), ensure_ascii=False, indent=2)+'\n')
    archive = BASE/'pullup-criteria-12.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
        for name in ['index.html', 'README.txt', *[i['file'] for i in items]]:
            z.write(OUT/name, 'pullup-criteria/'+name)
    print(archive, archive.stat().st_size, flush=True)


if __name__ == '__main__':
    main()
