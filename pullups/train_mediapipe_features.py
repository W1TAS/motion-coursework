#!/usr/bin/env python3
"""Train on completed causal MediaPipe features. Never select using test results."""
import argparse
from collections import Counter
import csv
import hashlib
import json
from pathlib import Path
import subprocess

import numpy as np
import torch
from sklearn.metrics import confusion_matrix
from threadpoolctl import threadpool_limits

from feature_model import classifier, metrics, run_candidate, MOTION_FEATS
from train import AUX_FEATS, training_samples, validate_splits

ROOT = Path(__file__).resolve().parents[1]
TARGETS = ('partial', 'swing')
CONFIGS = [dict(max_leaf_nodes=7, min_samples_leaf=20, l2_regularization=1.0, max_iter=100),
           dict(max_leaf_nodes=7, min_samples_leaf=35, l2_regularization=10.0, max_iter=180)]


def available(row, target):
    q = row.get('quality')
    if not q or row.get('features') is None:
        return False
    keys = ('nanFrac', 'confidence', 'wristMove', 'maxGap', 'bodyJump')
    if any(q.get(k) is None or not np.isfinite(q[k]) for k in keys):
        return False
    return (q['nanFrac'] <= .15 and q['confidence'] >= .45 and q['wristMove'] <= 1
            and q['maxGap'] <= .6 and q['bodyJump'] <= .2
            and (target != 'swing' or q.get('legs') is not None and q['legs'] >= .8))


def evaluate(y, p, threshold):
    result = metrics(y, p, threshold)
    tn, fp, fn, tp = confusion_matrix(y, p >= threshold, labels=[0, 1]).ravel()
    result.update(threshold=float(threshold), tp=int(tp), fp=int(fp), fn=int(fn), tn=int(tn))
    return result


def export_model(ckpt, checkpoint_path, dest):
    result = dict(version=1, kind='hist_gradient_boosting_binary',
                  sourceSha256=hashlib.sha256(checkpoint_path.read_bytes()).hexdigest(),
                  auxFeatures=AUX_FEATS, motionFeatures=MOTION_FEATS, models={},
                  scope='Experimental classifier retrained on causal MediaPipe features; annotated repetition windows. Scores are not calibrated confidence.')
    for target, entry in ckpt['models'].items():
        model = entry['model']
        trees = []
        for stage in model._predictors:
            assert len(stage) == 1 and not stage[0].nodes['is_categorical'].any()
            trees.append([[int(n['is_leaf']), float(n['value']), int(n['feature_idx']),
                           float(n['num_threshold']), int(n['missing_go_to_left']),
                           int(n['left']), int(n['right'])] for n in stage[0].nodes])
        result['models'][target] = dict(features=entry['feature_set'],
            baseline=float(model._baseline_prediction[0, 0]), trees=trees,
            threshold=ckpt['operating_point'][target]['threshold'])
    dest.write_text(json.dumps(result, allow_nan=False, separators=(',', ':')))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--out', required=True, type=Path)
    args = ap.parse_args()
    out = args.out.resolve()
    manifest_bytes = (out / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    done = json.loads((out / 'extraction-complete.json').read_text())
    assert done['manifestSha256'] == hashlib.sha256(manifest_bytes).hexdigest()
    samples = [s for job in manifest['jobs'] for s in job['samples']]
    validate_splits(samples)
    rows = [json.loads(line) for line in (out / 'features.jsonl').read_text().splitlines()]
    lookup = {r['uid']: r for r in rows}
    assert len(lookup) == len(rows) == len(samples) == done['rows']
    assert set(lookup) == {s['uid'] for s in samples}
    for row in rows:
        assert row['features'] is None or len(row['features']) == 40
    model_dir = out / 'model'
    model_dir.mkdir(exist_ok=True)
    torch.set_num_threads(2)
    old_path = ROOT / 'pullups/dataset_audited/model/model_final.pt'
    old = torch.load(old_path, weights_only=False, map_location='cpu')
    development = training_samples(samples)
    test = [s for s in samples if s['split'] == 'test']
    assert not ({s['group'] for s in development} & {s['group'] for s in test})
    report = dict(selection_metric='mean AP over held-out channels in development',
                  test_used_for_selection=False, targets={},
                  limitation='Annotated windows, not end-to-end counting. Context begins 0.5 s before the first audited window; previous statistics use audited windows only. Original labels and original group split retained. Missing/unstable poses produce abstentions; coverage must accompany scores.')
    report['pose_delegates_by_split'] = {
        split: dict(Counter(lookup[s['uid']].get('delegate', 'CPU') for s in samples if s['split'] == split))
        for split in ('train', 'val', 'test')}
    if manifest.get('delegate') == 'GPU':
        report['limitation'] += (' Same MediaPipe model with GPU delegate for new segments and preserved CPU caches. '
                                'Backend outputs are not identical; this test is not an all-CPU mobile deployment evaluation.')
    models, operating, train_ids, selected, oof_rows = {}, {}, {}, {}, []

    def matrix(ss, feature_set):
        n = 16 if feature_set == 'base' else 40
        return np.asarray([[np.nan if v is None else v for v in lookup[s['uid']]['features'][:n]]
                           for s in ss], dtype=np.float32).reshape(len(ss), n)

    with threadpool_limits(limits=2):
        # Finish ALL model/threshold selection before computing ANY test scores.
        for target in TARGETS:
            train = [s for s in development if int(s[target]) >= 0 and available(lookup[s['uid']], target)]
            if len({s['group'] for s in train if int(s[target]) == 1}) < 3:
                raise ValueError(f'{target}: insufficient positive training groups after pose quality filtering')
            candidates, predictions = [], {}
            for feature_set in ('base', 'motion'):
                x = matrix(train, feature_set)
                for ci, config in enumerate(CONFIGS):
                    candidate, prob = run_candidate(train, x, target, config, seed=0)
                    candidate['feature_set'] = feature_set
                    candidates.append(candidate)
                    predictions[(feature_set, ci)] = prob
                    print(f'{target} {feature_set}/{ci}: CV AP={candidate["summary"]["ap_mean"]:.3f}, '
                          f'cross-threshold F1={candidate["summary"]["cross_threshold_f1"]:.3f}', flush=True)
            best = max(candidates, key=lambda c: c['summary']['ap_mean'] if c['summary']['ap_mean'] is not None else -1)
            selected[target] = best
            operating[target] = best['operating_point']
            model = classifier(best['config'], seed=0)
            model.fit(matrix(train, best['feature_set']), np.array([int(s[target]) for s in train]),
                      sample_weight=np.array([float(s['w_group']) for s in train]))
            models[target] = dict(model=model, feature_set=best['feature_set'])
            train_ids[target] = [s['uid'] for s in train]
            prob = predictions[(best['feature_set'], CONFIGS.index(best['config']))]
            for s, p in zip(train, prob):
                oof_rows.append(dict(uid=s['uid'], group=s['group'], fold=s['fold'], target=target,
                                     label=int(s[target]), probability=float(p)))
            report['targets'][target] = dict(candidates=candidates, selected=best, n_development=len(train))

        ckpt = dict(model_type='features', models=models, targets=list(TARGETS), aux_dim=16,
                    aux_feats=AUX_FEATS, aux_preprocessing='model', operating_point=operating,
                    train_uids=sorted(set(sum(train_ids.values(), []))), train_uids_by_target=train_ids,
                    train_groups=sorted({s['group'] for s in development if any(s['uid'] in ids for ids in train_ids.values())}),
                    feature_version=2, required_fps=30., motion_features=MOTION_FEATS,
                    extraction_fps=manifest['fps'], pose_backend='app MediaPipe Pose Landmarker Lite',
                    pose_delegates_by_split=report['pose_delegates_by_split'],
                    manifest_sha256=done['manifestSha256'], window_protocol='annotated-causal-prefix-60s')
        checkpoint_path = model_dir / 'model_final.pt'
        torch.save(ckpt, checkpoint_path)
        (model_dir / 'cv_report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False))
        export_model(ckpt, checkpoint_path, model_dir / 'pullup-hgb.json')
        with (model_dir / 'oof_predictions.csv').open('w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=list(oof_rows[0]))
            writer.writeheader()
            writer.writerows(oof_rows)

        evaluation = dict(protocol='Same held-out sources and same eligible MediaPipe windows for old/new model. Thresholds frozen from development.',
                          old_model_sha256=hashlib.sha256(old_path.read_bytes()).hexdigest(),
                          new_model_sha256=hashlib.sha256(checkpoint_path.read_bytes()).hexdigest(),
                          original_test_windows=len(test), original_test_groups=len({s['group'] for s in test}),
                          limitation=report['limitation'], targets={})
        predictions = []
        parity = []
        for target in TARGETS:
            eligible = [s for s in test if int(s[target]) >= 0 and available(lookup[s['uid']], target)]
            known = [s for s in test if int(s[target]) >= 0]
            info = dict(coverage=dict(total_known=len(known), evaluated=len(eligible),
                total_positive=sum(int(s[target]) for s in known), evaluated_positive=sum(int(s[target]) for s in eligible),
                groups=len({s['group'] for s in eligible})), models={})
            for name, checkpoint in [('old', old), ('retrained', ckpt)]:
                entry = checkpoint['models'][target]
                p = entry['model'].predict_proba(matrix(eligible, entry['feature_set']))[:, 1] if eligible else np.array([])
                threshold = checkpoint['operating_point'][target]['threshold']
                y = np.array([int(s[target]) for s in eligible], dtype=int)
                info['models'][name] = evaluate(y, p, threshold) if eligible else {'n': 0}
                for s, value in zip(eligible, p):
                    predictions.append(dict(uid=s['uid'], group=s['group'], target=target, label=int(s[target]),
                                            model=name, probability=float(value), threshold=threshold))
            evaluation['targets'][target] = info
        # Numerical export checks use feature rows, not test labels.
        for s in samples:
            if lookup[s['uid']]['features'] is not None:
                x = matrix([s], 'motion')[0]
                parity.append(dict(uid=s['uid'], x=[None if not np.isfinite(v) else float(v) for v in x],
                    expected={t:float(e['model'].predict_proba(x[None,:16 if e['feature_set']=='base' else 40])[0,1]) for t,e in models.items()}))
        (model_dir / 'parity-fixtures.json').write_text(json.dumps(parity, allow_nan=False))
    (model_dir / 'evaluation_test.json').write_text(json.dumps(evaluation, indent=2, ensure_ascii=False))
    (model_dir / 'predictions_test.json').write_text(json.dumps(predictions, indent=2))
    subprocess.run(['node', str(ROOT / 'mobile/research/verify-trained-model.mjs'), str(model_dir)], check=True)
    coverage = {}
    for split in ('train', 'val', 'test'):
        ss = [s for s in samples if s['split'] == split]
        coverage[split] = {t:dict(original=dict(Counter(s[t] for s in ss)),
                                 accepted=dict(Counter(s[t] for s in ss if available(lookup[s['uid']], t)))) for t in TARGETS}
    (model_dir / 'coverage.json').write_text(json.dumps(coverage, indent=2))
    text = ['# Результат переобучения на MediaPipe', '',
            'Координаты получены тем же распознавателем позы, что и в приложении. '
            'Подбор параметров и порогов выполнялся только на обучающих источниках. '
            'Старая модель и установленное приложение не изменены.', '',
            '| Ошибка | Пригодных тестовых окон | Положительных | F1 старой | F1 новой |',
            '|---|---:|---:|---:|---:|']
    for target, name in [('partial', 'Неполная амплитуда'), ('swing', 'Раскачка')]:
        info = evaluation['targets'][target]
        c, m = info['coverage'], info['models']
        text.append(f'| {name} | {c["evaluated"]}/{c["total_known"]} | {c["evaluated_positive"]}/{c["total_positive"]} | '
                    f'{m["old"].get("f1", 0):.3f} | {m["retrained"].get("f1", 0):.3f} |')
    text += ['', 'F1 сравнивается на одинаковых окнах и координатах MediaPipe. Непригодные окна — отказы от оценки, а не правильные ответы.', '',
             'Это проверка классификации размеченных повторений. Границы взяты из разметки; '
             'она не измеряет качество выделения повторений во всём видеопотоке. '
             'Для окончательного вывода нужна проверка вместе со счётчиком в приложении. '
             'В прежней разметке и независимости перезаливов остаются ограничения аудита.']
    if manifest.get('delegate') == 'GPU':
        text += ['', 'Новые отрезки обработаны на GPU; готовые CPU-отрезки сохранены с указанием происхождения. '
                 'Координаты двух режимов не полностью совпадают. Эти метрики ещё не проверяют всю модель '
                 'на CPU телефона. Число окон каждого режима по частям выборки — в cv_report.json.']
    (out / 'RESULTS.md').write_text('\n'.join(text) + '\n')
    print('\n'.join(text), flush=True)


if __name__ == '__main__':
    main()
