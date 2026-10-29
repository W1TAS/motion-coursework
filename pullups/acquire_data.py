#!/usr/bin/env python3
"""Возобновляемый сбор интернет-видео и подготовка очереди ручной разметки.

python acquire_data.py --out internet_data --max-downloads 24
python acquire_data.py --out internet_data --stage status
Не создаёт подтверждённые метки и не меняет исходный датасет.
"""
import argparse
from collections import Counter
import csv
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import random
import re
import shutil
import subprocess
import sys
from types import SimpleNamespace

import cv2
import numpy as np

BASE = Path(__file__).resolve().parent
VIDEO_EXT = {'.mp4', '.mkv', '.webm', '.mov', '.avi'}
# Категории запросов — намерение поиска, а не метки правильности техники.
QUERIES = [
    ('strict pull ups full body front view', 'control'),
    ('kipping pull ups front view full body', 'swing'),
    ('pull ups half reps form check', 'partial'),
    ('pull up form check full body', 'form'),
    ('подтягивания с раскачкой вид спереди', 'swing'),
    ('подтягивания неполная амплитуда', 'partial'),
    ('strict pull ups rear view full body', 'control'),
    ('butterfly pull ups front view', 'swing'),
    ('pull ups to failure form check', 'partial'),
    ('pull ups swinging legs form check', 'swing'),
    ('подтягивания техника проверка полный рост', 'form'),
    ('подтягивания строгие спереди', 'control'),
    ('dominadas balanceo cuerpo completo', 'swing'),
    ('dominadas recorrido incompleto', 'partial'),
    ('dominadas estrictas cuerpo completo', 'control'),
    ('barra fixa balancando corpo inteiro', 'swing'),
    ('barra fixa amplitude incompleta', 'partial'),
    ('barra fixa execucao corpo inteiro', 'form'),
    ('tractions balancement vue de face', 'swing'),
    ('tractions amplitude incomplete', 'partial'),
    ('tractions strictes corps entier', 'control'),
    ('podciaganie bujanie technika', 'swing'),
    ('podciaganie niepelny zakres ruchu', 'partial'),
    ('Klimmzuege Schwung ganze Koerper', 'swing'),
    ('Klimmzuege voller Bewegungsumfang', 'control'),
    ('pull up no rep competition front view', 'partial'),
    ('strict versus kipping pull ups full body', 'swing'),
    ('beginner pull ups form check front view', 'form'),
]


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def read_json(path, default):
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default


def read_jsonl(path):
    if not path.exists():
        return []
    result = []
    for index, line in enumerate(path.read_text(encoding='utf-8').splitlines()):
        if not line.strip():
            continue
        try:
            result.append(json.loads(line))
        except json.JSONDecodeError:
            # Только незавершённая последняя запись после прерывания допустима.
            if index != len(path.read_text(encoding='utf-8').splitlines()) - 1:
                raise
    return result


def atomic_json(path, value):
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    os.replace(tmp, path)


def atomic_jsonl(path, rows):
    tmp = path.with_suffix(path.suffix + '.tmp')
    with tmp.open('w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False, allow_nan=False) + '\n')
    os.replace(tmp, path)


def write_csv(path, rows, fields=None):
    if not rows and fields is None:
        return
    tmp = path.with_suffix(path.suffix + '.tmp')
    with tmp.open('w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields or list(rows[0]), extrasaction='ignore')
        w.writeheader()
        w.writerows(rows)
    os.replace(tmp, path)


def read_csv(path):
    if not path.exists():
        return []
    with path.open(encoding='utf-8', newline='') as f:
        return list(csv.DictReader(f))


def existing_sources(roots, dataset):
    vids, channels = set(), set()
    for root in roots:
        root = Path(root)
        for p in (root / 'videos').glob('*'):
            if p.suffix.lower() in VIDEO_EXT:
                vids.add(p.stem)
        for r in read_jsonl(root / 'candidates.jsonl'):
            vids.add(r['id'])
            if r.get('channel_id'):
                channels.add(r['channel_id'])
        for r in read_csv(root / 'reps.csv'):
            vids.add(r['video_id'])
            if r.get('channel_id'):
                channels.add(r['channel_id'])
    test_channels = set()
    for s in read_csv(Path(dataset) / 'samples.csv'):
        vids.add(s['video_id'])
        if s['source'] == 'pool' and s['group'].startswith('pool:'):
            ch = s['group'][5:]
            channels.add(ch)
            if s['split'] == 'test':
                test_channels.add(ch)
    return vids, channels, test_channels


def source_split(channel, seed, fraction):
    value = int(hashlib.sha256(f'{seed}:{channel}'.encode()).hexdigest()[:16], 16) / 2**64
    return 'test' if value < fraction else 'train'


def merge_candidate(candidates, entry, query, tag):
    vid = entry.get('id')
    if not vid or not all(c.isalnum() or c in '_-' for c in vid):
        return
    c = candidates.setdefault(vid, {'id': vid, 'url': f'https://www.youtube.com/watch?v={vid}',
                                   'queries': [], 'tags': [], 'status': 'discovered', 'attempts': 0})
    for key in ('title', 'channel_id', 'channel', 'duration', 'view_count', 'live_status'):
        if entry.get(key) is not None:
            c[key] = entry[key]
    if query not in c['queries']:
        c['queries'].append(query)
    if tag not in c['tags']:
        c['tags'].append(tag)


def rejection(candidate, args, old_vids, old_channels, protected):
    if candidate['id'] in old_vids:
        return 'already_known_video'
    channel = candidate.get('channel_id')
    if not channel:
        return 'unknown_channel'
    if channel in protected:
        return 'protected_test_channel'
    if channel in old_channels:
        return 'already_known_channel'
    title = candidate.get('title')
    if title and not re.search(r'pull[\s-]*ups?|chin[\s-]*ups?|подтяг|dominad|barra\s+fixa|traction|podci|klimm', title, re.I):
        return 'unrelated_title'
    if candidate.get('live_status') in {'is_live', 'is_upcoming'}:
        return 'live_stream'
    duration = candidate.get('duration')
    if duration is None or not args.min_duration <= duration <= args.max_duration:
        return 'duration_outside_limits'
    return None


def ranked_candidates(candidates, args):
    rng = random.Random(args.seed)
    buckets = {}
    for c in sorted(candidates.values(), key=lambda c: c['id']):
        if c['status'] not in {'discovered', 'download_failed'}:
            continue
        if c['status'] == 'download_failed' and not args.retry_failed:
            continue
        if c.get('attempts', 0) >= args.max_attempts:
            continue
        title = c.get('title', '').lower()
        if re.search(r'kipping|butterfly|swing|раскач|читинг|balanceo|balanc|bujani|schwung', title):
            tag = 'swing'
        elif re.search(r'half|partial|incomplet|неполн|неполный|parcial', title):
            tag = 'partial'
        elif re.search(r'strict|строги|estrict|правильн|completo', title):
            tag = 'control'
        else:
            tag = 'form'
        buckets.setdefault(tag, []).append(c)
    for entries in buckets.values():
        rng.shuffle(entries)
        # Небольшие демонстрации стоят дешевле длинных лекций. Просмотры не критерий качества.
        entries.sort(key=lambda c: float(c.get('duration') or 1e9) // 60)
    result = []
    while any(buckets.values()):
        for tag in ('swing', 'partial', 'control', 'form'):
            if buckets.get(tag):
                result.append(buckets[tag].pop(0))
    return result


class QuietLog:
    def debug(self, message):
        pass

    def warning(self, message):
        pass

    def error(self, message):
        pass


def ydl_options(args):
    return {'quiet': True, 'logger': QuietLog(), 'cachedir': str(args.out / '.cache' / 'yt-dlp'),
            'socket_timeout': 15, 'retries': 2, 'extractor_retries': 1,
            'sleep_interval_requests': 0.5, 'js_runtimes': {'node': {'path': shutil.which('node')}},
            'noplaylist': True, 'no_warnings': True}


def network_blocked(error):
    text = str(error).lower()
    return any(word in text for word in ('not a bot', 'sign in', '429', 'failed to resolve',
                                         'name or service not known', 'temporary failure in name resolution'))


def discover(args, candidates, state):
    import yt_dlp
    queries = QUERIES
    if args.queries_file:
        queries = []
        for line in args.queries_file.read_text(encoding='utf-8').splitlines():
            if line.strip() and not line.lstrip().startswith('#'):
                q, _, tag = line.partition('|')
                queries.append((q.strip(), tag.strip() or 'form'))
    pending = [(q, tag) for q, tag in queries if f'{q}|{args.per_query}' not in state['searched']]
    if args.search_limit:
        pending = pending[:args.search_limit]
    options = {**ydl_options(args), 'extract_flat': 'in_playlist', 'skip_download': True}
    with yt_dlp.YoutubeDL(options) as ydl:
        for q, tag in pending:
            print(f'Поиск: {q}', flush=True)
            try:
                info = ydl.extract_info(f'ytsearch{args.per_query}:{q}', download=False)
                entries = list(info.get('entries') or []) if info else []
                if not entries:
                    raise RuntimeError('Поиск вернул пустой результат')
                for entry in entries:
                    if entry:
                        merge_candidate(candidates, entry, q, tag)
                state['searched'].append(f'{q}|{args.per_query}')
                state.pop('blocked', None)
            except Exception as exc:
                state.setdefault('search_errors', []).append({'query': q, 'time': now(), 'error': str(exc)[:1000]})
                print(f'Поиск не завершён: {exc}', flush=True)
                if network_blocked(exc):
                    state['blocked'] = str(exc)[:1000]
                    save(args, candidates, state)
                    raise RuntimeError('Сетевой доступ ограничен. Причина сохранена в run_state.json.') from exc
            save(args, candidates, state)
    if args.urls_file:
        # Ссылки — дополнительный вход, а не необходимая ручная работа пользователя.
        with yt_dlp.YoutubeDL(options) as ydl:
            for url in args.urls_file.read_text(encoding='utf-8').splitlines():
                if not url.strip() or url.lstrip().startswith('#'):
                    continue
                info = ydl.extract_info(url.strip(), download=False)
                if info:
                    for entry in info.get('entries') or [info]:
                        if entry:
                            merge_candidate(candidates, entry, 'provided_url', 'form')
                save(args, candidates, state)


def save(args, candidates, state):
    atomic_jsonl(args.out / 'candidates.jsonl', sorted(candidates.values(), key=lambda c: c['id']))
    state['updated_at'] = now()
    atomic_json(args.out / 'run_state.json', state)


def valid_video(path):
    cap = cv2.VideoCapture(str(path))
    n, fps = cap.get(cv2.CAP_PROP_FRAME_COUNT), cap.get(cv2.CAP_PROP_FPS)
    ok, _ = cap.read()
    if ok and n >= 8:
        cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, int(n) - 2))
        ok, _ = cap.read()
    cap.release()
    return bool(ok and n >= 8 and math.isfinite(fps) and fps > 0)


def video_path(root, vid):
    return next((p for p in (root / 'videos').glob(f'{vid}.*') if p.suffix.lower() in VIDEO_EXT and valid_video(p)), None)


def fingerprint(path):
    """Консервативный pHash: совпадение подозрительно, но не доказывает дубль."""
    cap = cv2.VideoCapture(str(path))
    n = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    hashes = []
    if n > 0:
        for frac in np.linspace(0.08, 0.92, 12):
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(frac * (n - 1)))
            ok, frame = cap.read()
            if not ok:
                continue
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            small = cv2.resize(gray, (32, 32)).astype(np.float32)
            dct = cv2.dct(small)[:8, :8].flatten()[1:]
            bits = dct > np.median(dct)
            hashes.append(hex(sum(int(b) << i for i, b in enumerate(bits))))
    cap.release()
    return hashes


def similar_fingerprints(a, b):
    if min(len(a), len(b)) < 6:
        return False
    aa, bb = [int(v, 16) for v in a], [int(v, 16) for v in b]
    # Стабильный фон и почти неподвижный человек не достаточны для решения.
    if max((aa[i] ^ aa[i - 1]).bit_count() for i in range(1, len(aa))) < 8:
        return False
    used, matches = set(), 0
    for value in aa:
        eligible = [(value ^ other).bit_count() if j not in used else 64 for j, other in enumerate(bb)]
        j = int(np.argmin(eligible))
        if eligible[j] <= 5:
            matches += 1
            used.add(j)
    return matches >= 6


def index_existing(args, state):
    index_path = args.out / 'fingerprints.json'
    index = read_json(index_path, {})
    if not args.skip_visual_dedupe:
        paths = [p for root in args.existing for p in (root / 'videos').glob('*') if p.suffix.lower() in VIDEO_EXT]
        for i, p in enumerate(sorted(paths)):
            key = str(p.resolve())
            stamp = [p.stat().st_size, p.stat().st_mtime_ns]
            if key not in index or index[key]['stamp'] != stamp:
                index[key] = {'stamp': stamp, 'hashes': fingerprint(p), 'video_id': p.stem}
            if (i + 1) % 25 == 0:
                atomic_json(index_path, index)
                print(f'Индекс дублей: {i + 1}/{len(paths)} исходных видео', flush=True)
    atomic_json(index_path, index)
    return index


def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def download_candidates(args, candidates, state, index):
    import yt_dlp
    state.pop('budget_stop', None)
    old_vids, old_channels, protected = existing_sources(args.existing, args.dataset)
    for c in candidates.values():
        if c['status'] in {'discovered', 'download_failed'}:
            reason = rejection(c, args, old_vids, old_channels, protected)
            if reason:
                c.update(status='rejected', rejection=reason)
        if c['status'] == 'rejected' and rejection(c, args, old_vids, old_channels, protected) is None:
            c['status'] = 'discovered'
            c.pop('rejection', None)
    assignments = read_json(args.out / 'source_assignments.json', {})
    counts = Counter(c.get('channel_id') for c in candidates.values() if c['status'] in {'downloaded', 'duplicate_review'} or
                     (c['status'] == 'processed' and c.get('quality_reps', c.get('n_segments', 0)) > 0))
    attempted = 0
    for c in ranked_candidates(candidates, args):
        reason = rejection(c, args, old_vids, old_channels, protected)
        if reason:
            c.update(status='rejected', rejection=reason)
            continue
        channel = c['channel_id']
        if counts[channel] >= args.max_per_channel:
            # Не делаем окончательный отказ: квоту можно повысить в следующем запуске.
            continue
        if attempted >= args.max_downloads:
            break
        used_bytes = sum(p.stat().st_size for p in (args.out / 'videos').glob('*') if p.is_file())
        estimated = c['duration'] * 3_000_000 / 8
        if used_bytes + estimated > args.max_gb * 1024**3 or shutil.disk_usage(args.out).free < estimated + 1024**3:
            state['budget_stop'] = 'disk_budget'
            break
        attempted += 1
        print(f'Видео {attempted}/{args.max_downloads}: {c.get("title", c["id"])}', flush=True)
        try:
            existing = video_path(args.out, c['id'])
            if existing is None:
                remaining = min(args.max_file_mb * 1024**2, args.max_gb * 1024**3 - used_bytes)
                def check_budget(progress):
                    if progress.get('downloaded_bytes', 0) > remaining:
                        raise yt_dlp.utils.DownloadError('Превышен бюджет размера видео')
                opts = {**ydl_options(args),
                        'format': f'bv*[height<={args.height}][vcodec^=avc1]/bv*[height<={args.height}][ext=mp4]/bv*[height<={args.height}]/b[height<={args.height}]',
                        'outtmpl': str(args.out / 'videos' / '%(id)s.%(ext)s'),
                        'max_filesize': int(args.max_file_mb * 1024**2),
                        'progress_hooks': [check_budget],
                        'sleep_interval': 1, 'max_sleep_interval': 2,
                        'postprocessors': [{'key': 'FFmpegVideoRemuxer', 'preferedformat': 'mp4'}]}
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(c['url'], download=False)
                    if not info:
                        raise RuntimeError('Недоступное видео')
                    if info.get('channel_id') != channel:
                        raise RuntimeError('Канал не совпадает с результатом поиска')
                    if not args.min_duration <= float(info.get('duration') or 0) <= args.max_duration:
                        raise RuntimeError('Уточнённая длительность вне лимита')
                    ydl.process_ie_result(info, download=True)
                existing = video_path(args.out, c['id'])
            if existing is None:
                raise RuntimeError('Нет завершённого декодируемого видео')
            c['sha256'] = sha256(existing)
            c['fingerprint'] = fingerprint(existing)
            dup = next((x['id'] for x in candidates.values() if x['id'] != c['id'] and x.get('sha256') == c['sha256']), None)
            similar = [v['video_id'] for v in index.values() if similar_fingerprints(c['fingerprint'], v['hashes'])]
            similar += [x['id'] for x in candidates.values() if x['id'] != c['id'] and similar_fingerprints(c['fingerprint'], x.get('fingerprint', []))]
            c.update(status='duplicate_review' if dup or similar else 'downloaded', duplicate_candidates=sorted(set(similar + ([dup] if dup else []))), downloaded_at=now())
            assignments.setdefault(channel, source_split(channel, args.seed, args.test_fraction))
            c['split'] = assignments[channel]
            counts[channel] += 1
            state.pop('blocked', None)
            atomic_json(args.out / 'meta' / f'{c["id"]}.json', c)
            atomic_json(args.out / 'source_assignments.json', assignments)
        except Exception as exc:
            c['attempts'] = c.get('attempts', 0) + 1
            c.update(status='download_failed', last_error=str(exc)[:1000], last_attempt=now())
            print(f'Не скачано: {exc}', flush=True)
            if network_blocked(exc):
                state['blocked'] = str(exc)[:1000]
                save(args, candidates, state)
                raise RuntimeError('YouTube/сеть ограничили доступ; повторные массовые запросы остановлены.') from exc
        save(args, candidates, state)
    save(args, candidates, state)
    return attempted


def prepare(args, candidates, state):
    import torch
    torch.set_num_threads(args.threads)
    os.environ.setdefault('YOLO_CONFIG_DIR', str(args.out / '.cache' / 'ultralytics'))
    from ultralytics import YOLO
    from filter_videos import process_video
    from extract_keypoints import process_segment
    done = {r['video_id']: r for r in read_jsonl(args.out / 'video_report.jsonl')}
    segments = read_jsonl(args.out / 'segments.jsonl')
    if getattr(args, 'recheck_rejected', False):
        for c in candidates.values():
            if c['status'] == 'processed' and c.get('n_segments', 0) == 0:
                c['status'] = 'downloaded'
                done.pop(c['id'], None)
    model = YOLO(str(args.pose_model)) if any(c['status'] == 'downloaded' for c in candidates.values()) else None
    cfg = SimpleNamespace(device='cpu', imgsz=640, batch=8, kp_conf=0.3, min_person_h=0.35,
                          other_person_ratio=0.25, no_knees=False, wrist_margin=0.08, min_ratio=getattr(args, 'min_view_ratio', 0.4),
                          views='any', coarse_step=0.5, fine_step=0.1, max_gap=1.5, min_seg=3.0,
                          min_coverage=0.7, min_reps=getattr(args, 'min_reps', 1), rep_prominence=0.10, min_rep_s=0.65,
                          max_analyze_s=args.max_duration, whole_video=False, target_fps=30.0, pad=0.5)
    for c in sorted(candidates.values(), key=lambda c: c['id']):
        if c['status'] != 'downloaded':
            continue
        path = video_path(args.out, c['id'])
        if path is None:
            c.update(status='download_failed', last_error='Повреждён/отсутствует локальный файл')
            continue
        print(f'Отбор и скелет: {c["id"]}', flush=True)
        try:
            if c['id'] not in done:
                report, found = process_video(model, path, cfg)
                segments = [s for s in segments if s['video_id'] != c['id']]
                for i, s in enumerate(found):
                    s.update(video_id=c['id'], segment_idx=i, title=c.get('title'),
                             channel_id=c['channel_id'], channel=c.get('channel'), tags=c['tags'], queries=c['queries'])
                    segments.append(s)
                done[c['id']] = report
                # Отрезки пишутся первыми; при прерывании незавершённый статус можно восстановить.
                atomic_jsonl(args.out / 'segments.jsonl', segments)
                atomic_jsonl(args.out / 'video_report.jsonl', done.values())
            selected = [s for s in segments if s['video_id'] == c['id']]
            cap = cv2.VideoCapture(str(path))
            fps = cap.get(cv2.CAP_PROP_FPS)
            if not math.isfinite(fps) or fps <= 0:
                raise RuntimeError('Не удалось определить частоту кадров')
            try:
                for s in selected:
                    dst = args.out / 'kps' / f'{c["id"]}_{s["segment_idx"]}.npz'
                    if dst.exists():
                        with np.load(dst) as d:
                            if len(d['t']) >= 10:
                                continue
                    result = process_segment(model, cap, fps, s, cfg)
                    if result is None:
                        raise RuntimeError('Не удалось извлечь скелет принятого отрезка')
                    tmp = dst.with_suffix('.tmp.npz')
                    np.savez_compressed(tmp, **result)
                    os.replace(tmp, dst)
            finally:
                cap.release()
            c.update(status='processed', n_segments=len(selected))
        except Exception as exc:
            c['processing_error'] = str(exc)[:1000]
            print(f'Ошибка обработки: {exc}', flush=True)
        save(args, candidates, state)
    if segments:
        subprocess.run([sys.executable, str(BASE / 'rep_features.py'), '--data', str(args.out),
                        '--min-rep-s', '0.65', '--rep-prominence', '0.10'], check=True)
        build_review_queue(args)
        counts = Counter(r['video_id'] for r in read_csv(args.out / 'quality_report.csv') if r['quality_partial'] == '1')
        for c in candidates.values():
            if c['status'] == 'processed':
                c['quality_reps'] = counts[c['id']]
        save(args, candidates, state)


def fnum(row, name, default=0.0):
    try:
        x = float(row[name])
        return x if math.isfinite(x) else default
    except (KeyError, TypeError, ValueError):
        return default


def quality(row):
    # Руки на неподвижной перекладине не должны смещаться по вертикали
    # больше ширины плеч. Это консервативный отсев подготовки/прыжка
    # и сильного движения камеры, а не оценка амплитуды подтягивания.
    core = (row.get('usable') == '1' and fnum(row, 'nan_frac', 1) <= 0.15
            and fnum(row, 'kp_conf') >= 0.45 and fnum(row, 'box_jump', 1) <= 0.2
            and fnum(row, 'wr_move', 0.0) <= 1.0)
    legs = fnum(row, 'knees_ok') >= 0.8 and fnum(row, 'ankles_ok') >= 0.8
    return core, core and legs


def scene_cuts(path):
    """Резкие смены большей части изображения; быстрое движение тела само по себе не причина."""
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS)
    previous, cuts, i = None, [], 0
    while math.isfinite(fps) and fps > 0:
        ok, frame = cap.read()
        if not ok:
            break
        small = cv2.resize(frame, (96, 54)).astype(np.int16)
        if previous is not None:
            difference = np.abs(small - previous).mean(axis=2)
            if float((difference > 40).mean()) > 0.35 and float(difference.mean()) > 25:
                cuts.append(i / fps)
        previous = small
        i += 1
    cap.release()
    return cuts


def balanced_review(rows, args, reviewed=(), banned=()):
    rng = random.Random(args.seed)
    reviewed, banned = set(reviewed), set(banned)
    train = [r for r in rows if r['split'] == 'train' and r['quality_partial']
             and r['rep_id'] not in reviewed and r['video_id'] not in banned]
    random_part = train[:]
    rng.shuffle(random_part)
    queue, used, group_counts, video_counts = [], set(), Counter(), Counter()
    # Лимиты учитывают уже просмотренные клипы, включая отклонённые:
    # новая партия не должна снова заполняться тем же человеком.
    for r in rows:
        if r['split'] == 'train' and r['rep_id'] in reviewed:
            group_counts[r['channel_id']] += 1
            video_counts[r['video_id']] += 1
    # Резервируем случайные примеры ДО отбора по прогнозам. Иначе случайные
    # слоты получались бы только из остатка после приоритетного отбора.
    random_quota = min(max(1, args.review_limit // 4), max(1, len(train) // 4))
    for r in random_part:
        if group_counts[r['channel_id']] >= args.review_per_channel or video_counts[r['video_id']] >= args.review_per_video:
            continue
        queue.append(dict(r, selection='random', rank=len(queue) + 1))
        used.add(r['rep_id'])
        group_counts[r['channel_id']] += 1
        video_counts[r['video_id']] += 1
        if len(queue) >= random_quota:
            break
    buckets = {
        'partial': sorted(train, key=lambda r: -r['partial_prob']),
        'swing': sorted([r for r in train if r['quality_swing']], key=lambda r: -r['swing_prob']),
        'uncertain': sorted(train, key=lambda r: r['uncertainty']),
    }
    while len(queue) < args.review_limit and any(buckets.values()):
        progress = False
        for name in ('partial', 'swing', 'uncertain'):
            while buckets[name]:
                r = buckets[name].pop(0)
                if r['rep_id'] in used or group_counts[r['channel_id']] >= args.review_per_channel or video_counts[r['video_id']] >= args.review_per_video:
                    continue
                r = dict(r, selection=name, rank=len(queue) + 1)
                queue.append(r)
                used.add(r['rep_id'])
                group_counts[r['channel_id']] += 1
                video_counts[r['video_id']] += 1
                progress = True
                break
            if len(queue) >= args.review_limit:
                break
        if not progress:
            break
    return queue


def build_review_queue(args):
    import torch
    import rep_features as rf
    from build_dataset import load_segment, resample
    from feature_model import motion_features
    from train import load_aux
    ckpt = torch.load(args.classifier, map_location='cpu', weights_only=False)
    if ckpt.get('model_type') != 'features':
        raise ValueError('Для автоматического приоритета нужен model_v2_features/model_final.pt')
    assignments = read_json(args.out / 'source_assignments.json', {})
    aux = load_aux(args.out, None)
    rows = read_csv(args.out / 'reps.csv')
    cut_index = read_json(args.out / 'scene_cuts.json', {})
    for vid in sorted({r['video_id'] for r in rows}):
        path = video_path(args.out, vid)
        if path is None:
            continue
        stamp = [path.stat().st_size, path.stat().st_mtime_ns]
        if vid not in cut_index or cut_index[vid]['stamp'] != stamp:
            cut_index[vid] = {'stamp': stamp, 'times': scene_cuts(path)}
    atomic_json(args.out / 'scene_cuts.json', cut_index)
    records = []
    cfg = SimpleNamespace(kp_conf=0.3, smooth_s=0.1, max_gap_s=0.4)
    for r in rows:
        r['split'] = assignments[r['channel_id']]
        core, legs = quality(r)
        crossing_cut = any(float(r['start']) - 0.2 < t < float(r['end']) + 0.2 for t in cut_index.get(r['video_id'], {}).get('times', []))
        if crossing_cut:
            core = legs = False
            r['usable'] = '0'
        record = {k: r.get(k, '') for k in ('rep_id', 'video_id', 'channel_id', 'start', 'end', 'facing', 'split')}
        record.update(quality_partial=int(core), quality_swing=int(legs), scene_cut=int(crossing_cut), partial_prob=0.0, swing_prob=0.0, uncertainty=1.0)
        # Отложенные каналы не оцениваются классификатором и не отбираются по вероятности ошибки.
        if core and r['split'] == 'train':
            t, p, conf, scale, center, _, _ = load_segment(str(args.out), r['video_id'], int(r['segment_idx']), cfg, rf)
            mask = (t >= float(r['start']) - 0.2) & (t <= float(r['end']) + 0.2)
            if mask.sum() < 8 or not math.isfinite(scale) or scale < 5:
                record['quality_partial'] = record['quality_swing'] = 0
            else:
                _, pos, c = resample((p[mask] - center) / scale, conf[mask], t[mask], 30.0)
                valid = np.isfinite(pos).all(axis=2)
                c = np.where(valid, c, 0.0)
                pos = np.nan_to_num(pos).astype(np.float32)
                base = aux[f'pool:{r["rep_id"]}']
                for target in ('partial', 'swing'):
                    entry = ckpt['models'][target]
                    values = np.concatenate([base, motion_features(pos, c)]) if entry['feature_set'] == 'motion' else base
                    prob = float(entry['model'].predict_proba(values[None])[0, 1])
                    record[target + '_prob'] = prob
                distances = [abs(record[t + '_prob'] - ckpt['operating_point'][t]['threshold']) for t in ('partial', 'swing') if t == 'partial' or legs]
                record['uncertainty'] = min(distances)
        records.append(record)
    # Фиксируем назначение источника в reps.csv для существующего инструмента разметки.
    write_csv(args.out / 'reps.csv', rows)
    journal = read_jsonl(args.out / 'labels.jsonl')
    reviewed = {r['rep_id'] for r in journal if r.get('action') in ('label', 'skip')}
    banned = {r['video_id'] for r in journal if r.get('action') == 'ban_video'}
    queue = balanced_review(records, args, reviewed, banned)
    fields = ['rep_id', 'video_id', 'channel_id', 'start', 'end', 'facing', 'split', 'quality_partial', 'quality_swing', 'scene_cut', 'partial_prob', 'swing_prob', 'uncertainty', 'selection', 'rank']
    write_csv(args.out / 'quality_report.csv', records, fields[:-2])
    write_csv(args.out / 'review_queue.csv', queue, fields)
    test = [dict(r) for r in records if r['split'] == 'test' and r['quality_partial'] and r['quality_swing']
            and r['rep_id'] not in reviewed and r['video_id'] not in banned]
    random.Random(args.seed).shuffle(test)
    counts, test_queue = Counter(), []
    for r in records:
        if r['split'] == 'test' and r['rep_id'] in reviewed:
            counts[r['channel_id']] += 1
    for r in test:
        if counts[r['channel_id']] < args.review_per_channel:
            test_queue.append(dict(r, selection='random_test', rank=len(test_queue) + 1, partial_prob='', swing_prob='', uncertainty=''))
            counts[r['channel_id']] += 1
    write_csv(args.out / 'test_review_queue.csv', test_queue, fields)
    # Один просмотрщик для человека; назначение train/test берётся из reps.csv
    # и сохраняется в ответе, подсказки модели скрыты для обеих частей.
    write_csv(args.out / 'annotation_queue.csv', queue + test_queue, fields)


def pending_clips(out):
    journal = read_jsonl(out / 'labels.jsonl')
    seen = {r['rep_id'] for r in journal if r.get('action') in ('label', 'skip')}
    banned = {r['video_id'] for r in journal if r.get('action') == 'ban_video'}
    return len({r['rep_id'] for r in read_csv(out / 'annotation_queue.csv')
                if r['rep_id'] not in seen and r['video_id'] not in banned})


def collect_to_target(args, candidates, state, index):
    """Проверяем выход фильтра после каждого блока, не обещая нужный выход заранее."""
    budget = args.max_downloads
    collection = state['collection'] = {'target_clips': args.target_clips, 'attempts': 0,
                                        'max_downloads': budget, 'round': 0, 'started_at': now(),
                                        'status': 'running', 'pending_clips': pending_clips(args.out)}
    try:
        # Подхватить скачанные файлы после прерывания и убрать старые ответы из очереди.
        prepare(args, candidates, state)
        while True:
            collection['pending_clips'] = pending_clips(args.out)
            if collection['pending_clips'] >= args.target_clips:
                collection.update(status='complete', stop_reason='target_reached')
                break
            remaining = budget - collection['attempts']
            if remaining <= 0:
                collection.update(status='limited', stop_reason='download_limit')
                break
            args.max_downloads = min(args.download_chunk, remaining)
            collection['round'] += 1
            print(f"Партии: готово {collection['pending_clips']}/{args.target_clips} новых клипов; "
                  f"блок {collection['round']}, до {args.max_downloads} видео", flush=True)
            save(args, candidates, state)
            attempted = download_candidates(args, candidates, state, index)
            collection['attempts'] += attempted
            prepare(args, candidates, state)
            collection['pending_clips'] = pending_clips(args.out)
            save(args, candidates, state)
            summary(args, candidates, state)
            if collection['pending_clips'] >= args.target_clips:
                continue
            if not attempted or state.get('budget_stop'):
                collection.update(status='limited', stop_reason=state.get('budget_stop', 'no_candidates'))
                break
    except BaseException:
        collection.update(status='interrupted', pending_clips=pending_clips(args.out))
        raise
    finally:
        args.max_downloads = budget
        collection['updated_at'] = now()
        save(args, candidates, state)
    return collection


def summary(args, candidates, state):
    reps = read_csv(args.out / 'reps.csv')
    q = read_csv(args.out / 'quality_report.csv')
    statuses = Counter(c['status'] for c in candidates.values())
    labels = {r['rep_id']: r for r in read_jsonl(args.out / 'labels.jsonl') if r.get('action') == 'label'}
    report = {'updated_at': now(), 'status_counts': dict(statuses),
              'rejections': dict(Counter(c.get('rejection') for c in candidates.values() if c.get('rejection'))),
              'searched_queries': len(state['searched']), 'videos_with_segments': sum(c.get('n_segments', 0) > 0 for c in candidates.values()),
              'n_reps': len(reps), 'quality_partial': sum(r.get('quality_partial') == '1' for r in q),
              'quality_swing': sum(r.get('quality_swing') == '1' for r in q),
              'review_queue': len(read_csv(args.out / 'review_queue.csv')),
              'test_review_queue': len(read_csv(args.out / 'test_review_queue.csv')),
              'annotation_queue': len(read_csv(args.out / 'annotation_queue.csv')),
              'channels': len({r['channel_id'] for r in q}),
              'facing': dict(Counter(r['facing'] for r in q)), 'blocked': state.get('blocked'),
              'confirmed_labels': len(labels),
              'accepted_labels': sum(not r.get('bad') and not r.get('unsure') for r in labels.values()),
              'bad_labels': sum(bool(r.get('bad')) for r in labels.values()),
              'unsure_labels': sum(bool(r.get('unsure')) for r in labels.values()),
              'collection': state.get('collection'),
              'note': 'Search tags and model probabilities are not confirmed labels.'}
    atomic_json(args.out / 'acquisition_report.json', report)
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


def parse():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--out', type=Path, default=BASE / 'internet_data')
    p.add_argument('--stage', choices=['all', 'discover', 'prepare', 'status'], default='all')
    p.add_argument('--existing', type=Path, nargs='*', default=[BASE / 'data', BASE / 'mine'])
    p.add_argument('--dataset', type=Path, default=BASE / 'dataset')
    p.add_argument('--pose-model', type=Path, default=BASE / 'yolo11m-pose.pt')
    p.add_argument('--classifier', type=Path, default=BASE / 'dataset/model_v2_features/model_final.pt')
    p.add_argument('--queries-file', type=Path)
    p.add_argument('--urls-file', type=Path)
    p.add_argument('--per-query', type=int, default=20)
    p.add_argument('--search-limit', type=int, default=0, help='0 — все ещё не выполненные запросы')
    p.add_argument('--max-downloads', type=int, default=24, help='максимум попыток скачивания за запуск')
    p.add_argument('--target-clips', type=int, default=0, help='набирать новые клипы после фильтрации; 0 — один обычный проход')
    p.add_argument('--download-chunk', type=int, default=12, help='в целевом сборе обновлять очередь после блока видео')
    p.add_argument('--max-per-channel', type=int, default=1)
    p.add_argument('--min-duration', type=float, default=8)
    p.add_argument('--max-duration', type=float, default=240)
    p.add_argument('--height', type=int, default=720)
    p.add_argument('--max-gb', type=float, default=5, help='общий бюджет папки videos, включая предыдущие запуски')
    p.add_argument('--max-file-mb', type=float, default=150)
    p.add_argument('--test-fraction', type=float, default=0.2)
    p.add_argument('--seed', type=int, default=42)
    p.add_argument('--threads', type=int, default=2)
    p.add_argument('--review-limit', type=int, default=150)
    p.add_argument('--review-per-channel', type=int, default=8)
    p.add_argument('--review-per-video', type=int, default=6)
    p.add_argument('--retry-failed', action='store_true')
    p.add_argument('--max-attempts', type=int, default=3)
    p.add_argument('--skip-visual-dedupe', action='store_true', help='отключить индекс pHash (точные ID всё равно исключаются)')
    p.add_argument('--min-view-ratio', type=float, default=0.4, help='порог отношения ширины плеч к длине торса')
    p.add_argument('--min-reps', type=int, default=1, help='минимум циклов в демонстрации')
    p.add_argument('--recheck-rejected', action='store_true', help='повторно проверить скачанные видео без принятых отрезков')
    args = p.parse_args()
    if min(args.per_query, args.max_downloads, args.max_per_channel, args.max_gb, args.threads, args.max_attempts, args.review_limit, args.review_per_channel, args.review_per_video) <= 0:
        p.error('Лимиты должны быть положительными')
    if not 0 < args.test_fraction < 1 or not 0 < args.min_duration < args.max_duration:
        p.error('Некорректная доля теста или длительность')
    if not 0 <= args.min_view_ratio <= 2 or args.min_reps < 1 or args.max_file_mb <= 0:
        p.error('Некорректный порог ракурса, число повторений или размер файла')
    if args.target_clips < 0 or args.download_chunk <= 0:
        p.error('Цель должна быть неотрицательной, размер блока — положительным')
    if args.target_clips and args.stage != 'all':
        p.error('--target-clips используется со --stage all')
    args.out = args.out.resolve()
    args.existing = [r.resolve() for r in args.existing]
    if args.out in args.existing or args.out == args.dataset.resolve():
        p.error('Сбор должен идти в отдельную папку')
    return args


def main():
    args = parse()
    args.out.mkdir(parents=True, exist_ok=True)
    for name in ('videos', 'meta', 'kps', '.cache/ultralytics'):
        (args.out / name).mkdir(parents=True, exist_ok=True)
    with (args.out / '.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('Эта папка уже обрабатывается другим запуском')
        candidates = {r['id']: r for r in read_jsonl(args.out / 'candidates.jsonl')}
        state = read_json(args.out / 'run_state.json', {'searched': [], 'created_at': now()})
        profile = {'seed': args.seed, 'test_fraction': args.test_fraction,
                   'existing': [str(r) for r in args.existing], 'dataset': str(args.dataset.resolve())}
        if state.get('profile', profile) != profile:
            raise SystemExit('Изменились правила источников/теста; для нового эксперимента нужна отдельная папка')
        state['profile'] = profile
        try:
            if args.stage in {'all', 'discover'}:
                discover(args, candidates, state)
            if args.stage == 'all':
                index = index_existing(args, state)
                if args.target_clips:
                    collect_to_target(args, candidates, state, index)
                else:
                    download_candidates(args, candidates, state, index)
            if args.stage == 'prepare' or (args.stage == 'all' and not args.target_clips):
                prepare(args, candidates, state)
            state.pop('last_error', None)
        except KeyboardInterrupt:
            state['interrupted'] = now()
            print('Прервано; готовые результаты сохраняются.', flush=True)
        except Exception as exc:
            state['last_error'] = str(exc)[:1000]
            save(args, candidates, state)
            summary(args, candidates, state)
            raise
        save(args, candidates, state)
        summary(args, candidates, state)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'Сбор не завершён: {exc}', file=sys.stderr)
        raise SystemExit(1)
