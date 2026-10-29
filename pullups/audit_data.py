"""Воспроизводимый технический аудит. Не подменяет экспертную проверку техники."""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import numpy as np
from acquire_data import atomic_json, read_csv, read_jsonl, read_json, similar_fingerprints, write_csv, now


def audit_pool(root):
    rows = read_csv(root / 'reps.csv')
    by_id = {r['rep_id']: r for r in rows}
    journal = read_jsonl(root / 'labels.jsonl')
    latest = {r['rep_id']: r for r in journal if r.get('action') == 'label'}
    banned = {r['video_id'] for r in journal if r.get('action') == 'ban_video'}
    eligible, excluded, missing, bad_windows = [], Counter(), [], []
    for rid, lab in latest.items():
        r = by_id.get(rid)
        if r is None:
            excluded['unknown_rep_id'] += 1
            continue
        reasons = []
        if lab.get('bad'): reasons.append('bad')
        if lab.get('unsure'): reasons.append('unsure')
        if r['video_id'] in banned: reasons.append('banned_video')
        if r.get('usable') != '1': reasons.append('unusable')
        if reasons:
            excluded.update(reasons)
            continue
        if not 0 <= float(r['start']) < float(r['end']):
            bad_windows.append(rid)
            continue
        kp = root / 'kps' / f"{r['video_id']}_{r['segment_idx']}.npz"
        videos = [p for p in (root / 'videos').glob(r['video_id'] + '.*') if p.suffix in ('.mp4','.mkv','.webm','.avi','.mov')]
        if not kp.exists() or not videos:
            missing.append(rid)
            continue
        eligible.append((r, lab))
    classes = {}
    for target in ('partial', 'swing', 'asym'):
        positive = [(r, l) for r, l in eligible if l.get('labels', {}).get(target, 0) > 0]
        groups = Counter(r.get('channel_id') or r['video_id'] for r, _ in positive)
        classes[target] = {'positive': len(positive), 'positive_channels': len(groups),
                           'largest_channel_fraction': max(groups.values(), default=0) / max(1, len(positive))}
    segments = sorted({(r['video_id'],r['segment_idx']) for r,_ in eligible})
    invalid_skeletons = []
    for vid,idx in segments:
        try:
            with np.load(root/'kps'/f'{vid}_{idx}.npz') as d:
                t,kp,cf = d['t'],d['kp'],d['conf']
                if (len(t)<2 or kp.shape!=(len(t),17,2) or cf.shape!=(len(t),17)
                    or not np.isfinite(t).all() or not (np.diff(t)>0).all()
                    or not np.isfinite(cf).all() or cf.min()<0 or cf.max()>1):
                    invalid_skeletons.append(f'{vid}_{idx}')
        except (OSError,ValueError,KeyError): invalid_skeletons.append(f'{vid}_{idx}')
    return {'repetitions': len(rows), 'reviewed': len(latest),
            'confident_before_video_bans': sum(not r.get('bad') and not r.get('unsure') for r in latest.values()),
            'eligible': len(eligible), 'excluded_reasons': dict(excluded),
            'eligible_channels': len({r.get('channel_id') or r['video_id'] for r, _ in eligible}),
            'banned_videos': len(banned), 'missing_assets': missing, 'invalid_windows': bad_windows,
            'skeletons_checked': len(segments), 'invalid_skeletons': invalid_skeletons,
            'classes': classes, 'eligible_ids': [r['rep_id'] for r, _ in eligible]}


def audit_dataset(path, pools):
    rows = read_csv(path / 'samples.csv')
    groups, folds = defaultdict(set), defaultdict(set)
    banned = set()
    unsure = set()
    for root in pools:
        journal = read_jsonl(root / 'labels.jsonl')
        banned.update(r['video_id'] for r in journal if r.get('action') == 'ban_video')
        latest = {r['rep_id']: r for r in journal if r.get('action') == 'label'}
        unsure.update(rid for rid, r in latest.items() if r.get('unsure'))
    for r in rows:
        groups[r['group']].add(r['split'])
        if r['split'] != 'test' and r['source'] == 'pool': folds[r['group']].add(r['fold'])
    bad = [r for r in rows if r['video_id'] in banned]
    return {'n': len(rows), 'splits': dict(Counter(r['split'] for r in rows)),
            'groups_crossing_splits': sorted(g for g, splits in groups.items() if len(splits) > 1),
            'groups_crossing_folds': sorted(g for g, fs in folds.items() if len(fs) > 1),
            'banned_video_samples': len(bad), 'banned_by_split': dict(Counter(r['split'] for r in bad)),
            'banned_sample_uids': [r['uid'] for r in bad],
            'unsure_samples': [r['uid'] for r in rows if r['rep_id'] in unsure],
            'duplicate_uids': [uid for uid, n in Counter(r['uid'] for r in rows).items() if n > 1]}


def duplicate_candidates(base, out):
    root = base / 'internet_data'
    index = read_json(root / 'fingerprints.json', {})
    candidates = read_jsonl(root / 'candidates.jsonl')
    links, checked = [], 0
    for c in candidates:
        if not c.get('fingerprint'): continue
        for entry in index.values():
            if entry['video_id'] == c['id']: continue
            checked += 1
            if similar_fingerprints(c['fingerprint'], entry['hashes']):
                links.append({'video_id': c['id'], 'possible_duplicate': entry['video_id'],
                              'status': 'needs_visual_review', 'method': 'temporal_phash'})
    write_csv(out / 'duplicate_candidates.csv', links, ['video_id','possible_duplicate','status','method'])
    return {'compared_pairs': checked, 'suspicious_pairs': len(links),
            'coverage': 'cached original videos vs downloaded internet videos; not exhaustive',
            'guarantee': False}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--base', type=Path, default=Path(__file__).resolve().parent)
    ap.add_argument('--out', type=Path, default=Path('audit'))
    ap.add_argument('--duplicates', action='store_true')
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    pools = [args.base / n for n in ('data','internet_data')]
    report = {'generated_at': now(), 'audit_type': 'technical_and_provenance; not expert certification',
              'pools': {p.name: audit_pool(p) for p in pools},
              'historical_dataset': audit_dataset(args.base / 'dataset', pools),
              'unverified_source': {'path': 'mine', 'included_in_audited_training': False,
                                    'reason': 'ownership and recording provenance not confirmed'}}
    if args.duplicates: report['duplicates'] = duplicate_candidates(args.base, args.out)
    clean_path = args.base / 'dataset_audited'
    if (clean_path / 'samples.csv').exists(): report['audited_dataset'] = audit_dataset(clean_path, pools)
    atomic_json(args.out / 'data_audit.json', report)
    lines = ['# Проверка качества данных', '',
             'Это техническая проверка файлов, разметки и разделения источников. Она не подтверждает правильность техники без независимого просмотра.', '']
    for name, pool in report['pools'].items():
        lines += [f'## {name}', f"Повторений: {pool['repetitions']}; просмотрено: {pool['reviewed']}; пригодно по журналу и наличию файлов: {pool['eligible']}.",
                  f"Исключения (причины могут пересекаться): {pool['excluded_reasons']}.",
                  f"Пропавшие файлы: {len(pool['missing_assets'])}; неверные интервалы: {len(pool['invalid_windows'])}."]
        lines.append(f"Проверено скелетных отрезков: {pool['skeletons_checked']}; нарушений схемы или времени: {len(pool['invalid_skeletons'])}.")
        for target, stat in pool['classes'].items():
            lines.append(f"- {target}: {stat['positive']} положительных примеров, {stat['positive_channels']} каналов; крупнейший канал даёт {stat['largest_channel_fraction']:.0%}.")
        lines.append('')
    old = report['historical_dataset']
    lines += ['## Найденная ошибка',
              f"Исторический датасет содержит {old['banned_video_samples']} повторений из исключённых целиком видео: {old['banned_by_split']}.",
              'Исправленный сборщик исключает такие видео, сомнительные метки и непригодные окна. Старый датасет не изменяется.',
              'Метрики на исправленном тесте характеризуют другую совокупность и не должны выдаваться за прямое улучшение на прежнем тесте.', '',
              '## Что ещё нужно проверить',
              '- Независимо пересмотреть случайную часть разметки и оценить согласие разметчиков.',
              '- Проверить границы циклов: плечевые колебания не всегда являются подтягиванием.',
              '- Проверить подозрительные перезаливы; канал не гарантирует независимость человека.',
              '- Проверять каждый класс отдельно. Общая доля верных ответов скрывает редкие ошибки.',
              '- Не переносить тестовые источники в обучение и не настраивать пороги по тесту.',
              '- Асимметрия пока не имеет достаточной базы для отдельного обучаемого классификатора.']
    (args.out / 'DATA_AUDIT.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(json.dumps({k: {q: v[q] for q in ('reviewed','eligible','classes')} for k,v in report['pools'].items()},ensure_ascii=False,indent=2))
    print('Исторический датасет:', old['n'], 'из исключённых роликов:', old['banned_by_split'])


if __name__ == '__main__':
    main()
