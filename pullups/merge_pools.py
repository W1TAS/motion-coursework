#!/usr/bin/env python3
"""Объединяет интернет-пулы без копирования видео и сохраняет прежний тест.

python merge_pools.py --sources data internet_data --out data_expanded --dataset dataset
python build_dataset.py --pool data_expanded --out dataset_expanded --split-manifest data_expanded/split_manifest.json
Размечать следует исходные пулы; labels.jsonl объединённого пула — экспорт.
"""
import argparse
import json
from pathlib import Path
from acquire_data import atomic_json, atomic_jsonl, now, read_csv, read_json, read_jsonl, write_csv


def split_manifest(dataset, sources):
    result = {}
    for s in read_csv(dataset / 'samples.csv'):
        if s['group'] in result and result[s['group']] != s['split']:
            raise ValueError('Исходная группа пересекает части датасета')
        result[s['group']] = s['split']
    for source in sources:
        for channel, split in read_json(source / 'source_assignments.json', {}).items():
            group = f'pool:{channel}'
            if group in result and result[group] != split:
                raise ValueError(f'Конфликт назначения источника {group}')
            result[group] = split
    return result


def link_assets(source, out, name):
    dst = out / name
    dst.mkdir(parents=True, exist_ok=True)
    for src in (source / name).glob('*'):
        if not src.is_file():
            continue
        target = dst / src.name
        if target.is_symlink() and target.resolve() == src.resolve():
            continue
        if target.exists() or target.is_symlink():
            raise ValueError(f'Разные файлы с одинаковым именем: {target}')
        target.symlink_to(src.resolve())


def merge(sources, out, dataset):
    sources = [s.resolve() for s in sources]
    out = out.resolve()
    if out in sources or out == dataset.resolve():
        raise ValueError('Для объединения нужна отдельная папка')
    marker = out / 'merge_manifest.json'
    if out.exists() and any(out.iterdir()) and not marker.exists():
        raise ValueError('Папка содержит сторонние файлы; используйте новую папку')
    previous = read_json(marker, {})
    if previous and previous['sources'] != [str(s) for s in sources]:
        raise ValueError('Состав источников изменился; создайте отдельный экспорт')
    out.mkdir(parents=True, exist_ok=True)
    rows, fields, records, seen_reps = [], [], [], set()
    exclusions = {}
    for source in sources:
        for r in read_csv(source / 'reps.csv'):
            if r['rep_id'] in seen_reps:
                raise ValueError(f'Повторение встречается в нескольких пулах: {r["rep_id"]}')
            seen_reps.add(r['rep_id']); rows.append(r)
            fields.extend(k for k in r if k not in fields)
        source_records = read_jsonl(source / 'labels.jsonl')
        records.extend(source_records)
        # В новом интернет-пуле сомнительные ответы сохраняем в журнале,
        # но до пересмотра не считаем подтверждёнными обучающими примерами.
        if (source / 'source_assignments.json').exists():
            latest = {r['rep_id']: r for r in source_records if r.get('action') == 'label'}
            exclusions.update({f'pool:{rid}': 'unsure' for rid, r in latest.items() if r.get('unsure')})
    if not rows:
        raise ValueError('В исходных пулах нет reps.csv с повторениями')
    manifest = split_manifest(dataset, sources)
    unique = {json.dumps(r, sort_keys=True, ensure_ascii=False): r for r in records}
    labels = sorted(unique.values(), key=lambda r: r.get('saved_at', ''))
    if any(json.dumps(r, sort_keys=True, ensure_ascii=False) not in unique for r in read_jsonl(out / 'labels.jsonl')):
        raise ValueError('В экспорте есть отдельная разметка. Сохраните её в исходном пуле перед повторным объединением.')
    for source in sources:
        for name in ('videos', 'kps', 'meta', 'clips', 'proxies'):
            link_assets(source, out, name)
    write_csv(out / 'reps.csv', rows, fields)
    atomic_jsonl(out / 'labels.jsonl', labels)
    atomic_json(out / 'split_manifest.json', manifest)
    frozen_folds = {}
    for row in read_csv(dataset / 'samples.csv'):
        if row.get('source') == 'pool' and int(row.get('fold', -1)) >= 0:
            fold = int(row['fold'])
            if row['group'] in frozen_folds and frozen_folds[row['group']] != fold:
                raise ValueError('Исходная группа пересекает фолды')
            frozen_folds[row['group']] = fold
    atomic_json(out / 'fold_manifest.json', frozen_folds)
    atomic_json(out / 'sample_exclusions.json', exclusions)
    atomic_json(marker, {'sources': [str(s) for s in sources], 'created_at': now(),
                         'n_reps': len(rows), 'n_label_records': len(labels),
                         'note': 'Videos and skeletons are linked; label original pools.'})
    return {'n_reps': len(rows), 'n_label_records': len(labels), 'protected_groups': len(manifest),
            'excluded_unsure': len(exclusions)}


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--sources', type=Path, nargs='+', required=True)
    p.add_argument('--out', type=Path, default=Path('data_expanded'))
    p.add_argument('--dataset', type=Path, default=Path('dataset'))
    args = p.parse_args()
    print(json.dumps(merge(args.sources, args.out, args.dataset), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
