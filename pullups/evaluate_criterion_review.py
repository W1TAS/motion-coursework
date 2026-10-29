"""Small development-only audit; never exports an application model.

Compare the existing 150-degree extension threshold with a one-dimensional
threshold fitted only on other source groups. Human-marked phases are inputs,
so results are not end-to-end performance of the automatic repetition detector.
"""
import hashlib
import json
from pathlib import Path

BASE = Path(__file__).parent / 'dataset_mediapipe_gpu/human-reviews'


def metrics(rows):
    result = {k: 0 for k in ('tp', 'fp', 'tn', 'fn')}
    for row in rows:
        result[('tp' if row['predicted'] else 'fn') if row['label']
               else ('fp' if row['predicted'] else 'tn')] += 1
    tp, fp, tn, fn = (result[k] for k in ('tp', 'fp', 'tn', 'fn'))
    result['f1'] = 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 0
    result['balanced_accuracy'] = ((tp / (tp + fn) + tn / (tn + fp)) / 2
                                   if tp + fn and tn + fp else None)
    return result


def fit_threshold(rows):
    if {r['label'] for r in rows} != {0, 1}:
        raise ValueError('Both classes are required in each training fold')
    angles = sorted({r['angle'] for r in rows})
    candidates = [angles[0] - 1, angles[-1] + 1]
    candidates += [(a + b) / 2 for a, b in zip(angles, angles[1:])]

    def score(t):
        m = metrics([dict(r, predicted=int(r['angle'] < t)) for r in rows])
        # Fixed prior tie-break; no held-out labels or angles enter fitting.
        return m['balanced_accuracy'], -abs(t - 150), -t

    return max(candidates, key=score)


def main():
    feature_path = BASE / 'criterion-features.json'
    features = json.loads(feature_path.read_text())
    packet = json.loads((BASE / 'review-02-answers.json').read_text())
    rows = []
    for r in features['rows']:
        x = r['inputs']['bottom_incomplete']
        if r['attempt'] != 'attempt' or x['status'] != 'available':
            continue
        assert r['split'] != 'test' and r['labels']['bottom_incomplete'] in (0, 1)
        rows.append(dict(uid=r['uid'], group=r['group'],
                         label=r['labels']['bottom_incomplete'], angle=x['features'][0]))
    fixed = [dict(r, predicted=int(r['angle'] < 150)) for r in rows]
    held_out = []
    for group in sorted({r['group'] for r in rows}):
        train = [r for r in rows if r['group'] != group]
        val = [r for r in rows if r['group'] == group]
        assert not {r['group'] for r in train} & {r['group'] for r in val}
        threshold = fit_threshold(train)
        held_out.extend(dict(r, predicted=int(r['angle'] < threshold),
                             threshold=threshold, training_groups=sorted({t['group'] for t in train}))
                        for r in val)
    result = dict(
        protocol='bottom-median-threshold-leave-one-source-group-out-v1',
        input_sha256=hashlib.sha256(feature_path.read_bytes()).hexdigest(),
        limitations=[
            'Targeted development examples, not representative or reserved test data.',
            'Human phase timestamps; automatic phase detection is not evaluated.',
            'One annotator; two positive source groups only; different channels may contain reposts.',
            'Contains rear-view context check; not evidence for a frontal-only application.',
            'Criterion upper height lacks bar/chin input; swing has no confirmed positives.',
            'No fitted threshold or new weights are deployed.'],
        n=len(rows), groups=len({r['group'] for r in rows}),
        positive_groups=len({r['group'] for r in rows if r['label']}),
        fixed_150=dict(metrics=metrics(fixed), rows=fixed),
        learned_threshold_group_holdout=dict(metrics=metrics(held_out), rows=held_out),
        review_status=[dict(clip=i, uid=item['id'], complete=packet['answers'].get(item['id'], {}).get('complete', False),
                            answer=packet['answers'].get(item['id'], {}))
                       for i, item in enumerate(packet['items'], 1)])
    out = BASE / 'review-02-experiment.json'
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k: result[k] if k in ('n', 'groups', 'positive_groups') else result[k]['metrics']
                      for k in ('n', 'groups', 'positive_groups', 'fixed_150', 'learned_threshold_group_holdout')}, indent=2))


if __name__ == '__main__':
    main()
