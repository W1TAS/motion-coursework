"""Fixed exploratory baselines with leave-one-channel-out development predictions.

Run: pullups/.venv/bin/python pullups/compare_screened_bottom.py
No deployment model is fitted or exported. No model/threshold search or test access.
"""
from collections import Counter
import hashlib
import json
from pathlib import Path

import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import confusion_matrix, f1_score
from sklearn.preprocessing import StandardScaler
from threadpoolctl import threadpool_limits

BASE = Path(__file__).resolve().parent / 'dataset_mediapipe_gpu/human-reviews/bottom-baseline-v1'


def train_weights(y, groups):
    """Equal channel mass first, then equal total mass for the two classes."""
    counts = Counter(groups)
    weights = np.array([1 / counts[g] for g in groups], dtype=float)
    for label in (0, 1):
        mask = y == label
        if not mask.any():
            raise ValueError('Training fold has only one class')
        weights[mask] *= (len(y) / 2) / weights[mask].sum()
    assert np.isfinite(weights).all()
    return weights


def summarize(rows, predictions):
    y = np.array([r['label'] for r in rows])
    tn, fp, fn, tp = confusion_matrix(y, predictions, labels=[0, 1]).ravel()
    by_class = {}
    for label in (0, 1):
        group_recalls = []
        for group in sorted({r['group'] for r in rows}):
            mask = np.array([r['group'] == group and r['label'] == label for r in rows])
            if mask.any():
                group_recalls.append(float(np.mean(predictions[mask] == label)))
        by_class[str(label)] = float(np.mean(group_recalls)) if group_recalls else None
    return dict(n=len(rows), TP=int(tp), FN=int(fn), FP=int(fp), TN=int(tn),
                f1=float(f1_score(y, predictions, zero_division=0)),
                group_macro_recall_by_class=by_class,
                group_macro_balanced_accuracy=float(np.mean(list(by_class.values()))))


def compare(rows):
    assert rows and all(r['split'] != 'test' for r in rows)
    x = np.asarray([r['features'] for r in rows], dtype=float)
    y = np.asarray([r['label'] for r in rows])
    groups = np.asarray([r['group'] for r in rows])
    assert np.isfinite(x).all() and set(y) == {0, 1}
    prob = {name: np.full(len(rows), np.nan) for name in ('logistic', 'random_forest')}
    folds = []
    for group in sorted(set(groups)):
        test = groups == group
        train = ~test
        assert not (set(groups[train]) & set(groups[test]))
        assert len(set(y[train])) == 2
        weights = train_weights(y[train], groups[train])
        # Scaling and all fitting use this training fold only.
        scaler = StandardScaler().fit(x[train], sample_weight=weights)
        linear = LogisticRegression(C=1.0, solver='lbfgs', max_iter=1000, random_state=17)
        linear.fit(scaler.transform(x[train]), y[train], sample_weight=weights)
        forest = RandomForestClassifier(n_estimators=128, max_depth=3, min_samples_leaf=3,
                                        max_features=None, n_jobs=2, random_state=17)
        forest.fit(x[train], y[train], sample_weight=weights)
        prob['logistic'][test] = linear.predict_proba(scaler.transform(x[test]))[:, 1]
        prob['random_forest'][test] = forest.predict_proba(x[test])[:, 1]
        folds.append(dict(held_out_channel=str(group), train=int(train.sum()), evaluated=int(test.sum()),
                          training_channels=sorted(set(groups[train]))))
    assert all(np.isfinite(p).all() for p in prob.values())
    predictions = {'rule_150': (x[:, 0] < 150).astype(int),
                   **{k: (p >= .5).astype(int) for k, p in prob.items()}}
    return dict(clips=len(rows), groups=len(set(groups)), counts=dict(Counter(map(str, y))),
                models={k: summarize(rows, p) for k, p in predictions.items()}, folds=folds,
                predictions=[dict(uid=r['uid'], group=r['group'], label=r['label'],
                                  rule=int(predictions['rule_150'][i]),
                                  probabilities={k: float(p[i]) for k, p in prob.items()}) for i, r in enumerate(rows)])


def main():
    raw = (BASE / 'inputs.json').read_bytes()
    data = json.loads(raw)
    rows = [r for r in data['rows'] if r['status'] == 'available']
    largest, count = Counter(r['group'] for r in rows).most_common(1)[0]
    with threadpool_limits(limits=2):
        all_channels = compare(rows)
        # Completely remove the largest channel from BOTH training and evaluation.
        without_largest = compare([r for r in rows if r['group'] != largest])
    report = dict(schema=1, inputSha256=hashlib.sha256(raw).hexdigest(), testUsed=False,
                  protocol='Leave-one-channel-out on strict reviewed development clips. Fixed 150-degree rule, '
                           'fixed logistic and shallow forest, fixed 0.5 ML threshold. No hyperparameter selection. '
                           'Inverse-channel weights with class mass balanced within each training fold.',
                  eligible=len(data['rows']), poseUnavailable=len(data['rows']) - len(rows),
                  largestChannel=dict(group=largest, available_clips=count),
                  allChannels=all_channels, withoutLargestChannel=without_largest,
                  limitations=['Exploratory development comparison after earlier development analyses, not a final test.',
                               'Human-reviewed clips were targeted, not a representative random sample.',
                               'Few error channels and unknown cross-channel reuploads limit independence.',
                               'Automatic bottom times can be wrong; feature coverage is reported separately.',
                               'Only initial elbow extension is evaluated. No claims about top height or ascent swing.',
                               'No final model, threshold tuning or app replacement performed.'])
    (BASE / 'comparison.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: {name: run[name] for name in ('clips', 'groups', 'models')} for k, run in
                      [('all', all_channels), ('without_largest', without_largest)]}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
