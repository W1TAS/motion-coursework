#!/usr/bin/env python3
"""Классификатор на признаках движения и сравнение вариантов по CV по каналам.

python feature_model.py --dataset dataset --pool data --own mine
Результаты: model_v2_features/{cv_report.json,oof_predictions.csv,model_final.pt}.
Тестовые каналы не участвуют ни в обучении, ни в выборе конфигурации/порогов.
"""
import argparse
import csv
import json
from pathlib import Path

import numpy as np
import torch
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import average_precision_score, f1_score, precision_score, recall_score, roc_auc_score
from threadpoolctl import threadpool_limits

from train import ALL_TARGETS, AUX_FEATS, best_threshold, load_aux, load_dataset, training_samples, validate_splits

SIGNALS = ['hip_wrist_dx', 'hip_shoulder_dx', 'knee_hip_dx', 'ankle_hip_dx',
           'torso_tilt', 'left_knee_angle', 'right_knee_angle', 'elbow_angle_diff']
MOTION_FEATS = [f'{s}_{stat}' for s in SIGNALS for stat in ('median', 'range90', 'speed90')]


def motion_features(pos, conf, fps=30.0):
    """Геометрия внутри одного повторения. Пропуски не создают ложную скорость."""
    p = np.asarray(pos, dtype=float).copy()
    valid = (np.asarray(conf) >= 0.3) & np.isfinite(p).all(axis=-1)
    p[~valid] = np.nan

    def center(a, b):
        return (p[:, a] + p[:, b]) / 2

    def angle(a, b, c):
        u, v = p[:, a] - p[:, b], p[:, c] - p[:, b]
        den = np.linalg.norm(u, axis=1) * np.linalg.norm(v, axis=1)
        dot = np.sum(u * v, axis=1)
        return np.degrees(np.arccos(np.clip(np.divide(dot, den, out=np.full(len(p), np.nan), where=den > 1e-8), -1, 1)))

    shoulder, hip = center(5, 6), center(11, 12)
    knee, ankle, wrist = center(13, 14), center(15, 16), center(9, 10)
    torso = shoulder - hip
    signals = [hip[:, 0] - wrist[:, 0], hip[:, 0] - shoulder[:, 0],
               knee[:, 0] - hip[:, 0], ankle[:, 0] - hip[:, 0],
               np.degrees(np.arctan2(torso[:, 0], -torso[:, 1])),
               angle(11, 13, 15), angle(12, 14, 16),
               np.abs(angle(5, 7, 9) - angle(6, 8, 10))]
    out = []
    for signal in signals:
        good = np.isfinite(signal)
        if good.sum() < 4:
            out.extend([np.nan] * 3)
            continue
        q = np.percentile(signal[good], [5, 50, 95])
        steps = good[1:] & good[:-1]
        speed = np.abs(np.diff(signal)[steps]) * fps
        out.extend([q[1], q[2] - q[0], np.percentile(speed, 90) if len(speed) >= 3 else np.nan])
    return np.asarray(out, dtype=np.float32)


def feature_matrix(samples, kp, conf, offsets, aux_map, feature_set):
    rows = []
    for s in samples:
        base = aux_map.get(s['uid'], np.full(len(AUX_FEATS), np.nan))
        if feature_set == 'motion':
            a, b = offsets[s['_seg']:s['_seg'] + 2]
            base = np.concatenate([base, motion_features(kp[a:b], conf[a:b], float(s['fps']))])
        rows.append(base)
    return np.asarray(rows, dtype=np.float32)


def metrics(y, prob, threshold=None):
    known = np.asarray(y) >= 0
    y, prob = np.asarray(y)[known], np.asarray(prob)[known]
    both = len(np.unique(y)) == 2
    result = {'n': len(y), 'n_pos': int(y.sum()),
              'auc': float(roc_auc_score(y, prob)) if both else None,
              'ap': float(average_precision_score(y, prob)) if both else None}
    if threshold is not None:
        pred = prob >= threshold
        result.update(precision=float(precision_score(y, pred, zero_division=0)),
                      recall=float(recall_score(y, pred, zero_division=0)),
                      f1=float(f1_score(y, pred, zero_division=0)))
    return result


def classifier(config, seed):
    # Фиксированное число итераций: скрытое случайное разбиение повторений для
    # early stopping нарушило бы требование разделять целые каналы.
    return HistGradientBoostingClassifier(learning_rate=0.05, early_stopping=False,
                                         random_state=seed, **config)


def run_candidate(samples, x, target, config, seed):
    y = np.array([int(s[target]) for s in samples])
    folds = np.array([int(s['fold']) for s in samples])
    own = np.array([s['source'] == 'own' for s in samples])
    weights = np.array([float(s['w_group']) for s in samples])
    probs = np.full(len(samples), np.nan)
    reports = []
    for f in sorted(set(folds[~own])):
        train = (own | (folds != f)) & (y >= 0)
        val = ~own & (folds == f) & (y >= 0)
        if len(np.unique(y[train])) != 2:
            raise ValueError(f'{target}: недостаточно меток в обучении фолда {f}')
        m = classifier(config, seed)
        m.fit(x[train], y[train], sample_weight=weights[train])
        if val.any():
            probs[val] = m.predict_proba(x[val])[:, 1]
            reports.append({'fold': int(f), **metrics(y[val], probs[val])})
    known = np.isfinite(probs)
    op = best_threshold(probs[known], y[known])
    op.update(n=int(known.sum()), n_pos=int(y[known].sum()))
    # Каждый порог подбирается по ДРУГИМ фолдам; F1 на том же наборе, где
    # оптимизировали порог, оставлен лишь как диагностическая рабочая точка.
    cross_pred = np.zeros(len(samples), dtype=bool)
    for r in reports:
        val = known & (folds == r['fold'])
        rest = known & (folds != r['fold'])
        thr = best_threshold(probs[rest], y[rest])['threshold']
        cross_pred[val] = probs[val] >= thr
        r['cross_threshold'] = thr
        r['cross_threshold_metrics'] = metrics(y[val], probs[val], thr)
    aucs = [r['auc'] for r in reports if r['auc'] is not None]
    aps = [r['ap'] for r in reports if r['ap'] is not None]
    summary = {'auc_mean': float(np.mean(aucs)) if aucs else None,
               'auc_std': float(np.std(aucs)) if aucs else None,
               'ap_mean': float(np.mean(aps)) if aps else None,
               'cross_threshold_f1': float(f1_score(y[known], cross_pred[known], zero_division=0)),
               'cross_threshold_precision': float(precision_score(y[known], cross_pred[known], zero_division=0)),
               'cross_threshold_recall': float(recall_score(y[known], cross_pred[known], zero_division=0))}
    return {'config': config, 'folds': reports, 'summary': summary, 'operating_point': op}, probs


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--dataset', default='dataset')
    ap.add_argument('--pool', default='data')
    ap.add_argument('--own', default='mine')
    ap.add_argument('--targets', default='partial,swing')
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--threads', type=int, default=2)
    ap.add_argument('--out', default=None)
    args = ap.parse_args()
    targets = args.targets.split(',')
    if not targets or any(t not in ALL_TARGETS for t in targets):
        ap.error('Недопустимый список целей')
    all_samples, kp, conf, offsets = load_dataset(Path(args.dataset))
    validate_splits(all_samples)
    samples = training_samples(all_samples)
    if any(abs(float(s['fps']) - 30.0) > 1e-3 for s in samples):
        ap.error('Для признаков скорости нужен датасет с частотой 30 кадров/с (--fps 30 в build_dataset.py)')
    aux = load_aux(args.pool, args.own)
    if not aux:
        ap.error('Не найдены признаки reps.csv')
    out = Path(args.out or Path(args.dataset) / 'model_v2_features')
    out.mkdir(parents=True, exist_ok=True)
    configs = [dict(max_leaf_nodes=7, min_samples_leaf=20, l2_regularization=1.0, max_iter=100),
               dict(max_leaf_nodes=7, min_samples_leaf=35, l2_regularization=10.0, max_iter=180)]
    candidates = {t: [] for t in targets}
    raw = {}
    matrices = {}
    with threadpool_limits(limits=args.threads):
        for feature_set in ('base', 'motion'):
            x = matrices[feature_set] = feature_matrix(samples, kp, conf, offsets, aux, feature_set)
            for ci, config in enumerate(configs):
                for t in targets:
                    report, prob = run_candidate(samples, x, t, config, args.seed)
                    report['feature_set'] = feature_set
                    candidates[t].append(report)
                    raw[(t, feature_set, ci)] = prob
                    s, op = report['summary'], report['operating_point']
                    print(f'{feature_set}/{ci} {t}: AP {s["ap_mean"]:.3f}, F1 {op["f1"]:.3f}, '
                          f'F1 с порогом других фолдов {s["cross_threshold_f1"]:.3f}', flush=True)
        models, selected, op, oof = {}, {}, {}, {}
        weights = np.array([float(s['w_group']) for s in samples])
        for t in targets:
            # Для редких ошибок критерий — AP, независимо от ручного выбора порога.
            best = max(candidates[t], key=lambda r: r['summary']['ap_mean'] or -1)
            selected[t] = best
            op[t] = best['operating_point']
            ci = configs.index(best['config'])
            oof[t] = raw[(t, best['feature_set'], ci)]
            y = np.array([int(s[t]) for s in samples])
            known = y >= 0
            m = classifier(best['config'], args.seed)
            m.fit(matrices[best['feature_set']][known], y[known], sample_weight=weights[known])
            models[t] = {'model': m, 'feature_set': best['feature_set']}
    report = {'targets': targets, 'selection_metric': 'mean AP over held-out channels',
              'selected': selected, 'candidates': candidates, 'args': vars(args),
              'n_development': len(samples), 'test_used': False,
              'limitation': 'CV used for configuration selection; independent test required for final claims.'}
    (out / 'cv_report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    rows = []
    for i, s in enumerate(samples):
        if s['source'] != 'pool':
            continue
        row = {k: s[k] for k in ('uid', 'group', 'fold', 'video_id', 'start', 'end')}
        for t in targets:
            row[t + '_true'] = int(s[t])
            row[t + '_prob'] = float(oof[t][i]) if np.isfinite(oof[t][i]) else ''
        rows.append(row)
    with (out / 'oof_predictions.csv').open('w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    torch.save({'model_type': 'features', 'models': models, 'targets': targets,
                'aux_dim': len(AUX_FEATS), 'aux_feats': AUX_FEATS, 'aux_preprocessing': 'model',
                'operating_point': op, 'train_uids': [s['uid'] for s in samples],
                'train_groups': sorted({s['group'] for s in samples}),
                'feature_version': 1, 'required_fps': 30.0, 'motion_features': MOTION_FEATS}, out / 'model_final.pt')
    print(f'Сохранено: {out}', flush=True)


def load_feature_predictor(ckpt):
    def predict(x, mask, lengths, aux=None):
        if aux is None:
            raise ValueError('Необходимы признаки reps.csv')
        base = aux.detach().cpu().numpy()
        xx = x.detach().cpu().numpy()
        # SkeletonDataset подаёт позиции, уверенности и скорости, ровно в таком порядке.
        motion = None
        if any(entry['feature_set'] == 'motion' for entry in ckpt['models'].values()):
            motion = np.stack([motion_features(xx[i, :int(n), :34].reshape(-1, 17, 2),
                                             xx[i, :int(n), 34:51]) for i, n in enumerate(lengths)])
        result = {}
        for t, entry in ckpt['models'].items():
            features = np.concatenate([base, motion], axis=1) if entry['feature_set'] == 'motion' else base
            with threadpool_limits(limits=2):
                prob = entry['model'].predict_proba(features)[:, 1]
            result[t] = torch.as_tensor(prob, dtype=torch.float32)
        return result
    return predict, ckpt['targets'], ckpt['operating_point']


if __name__ == '__main__':
    main()
