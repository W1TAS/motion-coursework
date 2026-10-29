"""Refresh only the UI of the frozen review; preserve clips, IDs and storage keys."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'pullups/dataset_mediapipe_gpu/human-reviews/expanded-3d'


def embedded(html, prefix):
    return json.JSONDecoder().raw_decode(html.split(prefix, 1)[1])[0]


def main():
    packet = json.loads((BASE / 'review-selection.json').read_text())
    approved = {i['id']: i for i in packet['items']}
    results_bytes = (BASE / 'results.json').read_bytes()
    results = {r['uid']: r for r in json.loads(results_bytes)['rows']}
    template = (ROOT / 'pullups/criterion_review.html').read_text()
    template = template.replace('const fields=[', "const fields=[\n ['facing','Откуда снято движение?',[['front','Спереди'],['front_oblique','Спереди под небольшим углом'],['side','Сбоку'],['back','Со спины'],['unknown','Не могу определить']]],")
    template = template.replace('Заполни четыре ответа по видео.', 'Заполни ответы по видео, включая ракурс.')
    suggestions = {}
    for batch in range(1, 4):
        path = BASE / 'review' / f'batch-{batch}' / 'index.html'
        old = path.read_text()
        items = embedded(old, 'const items=')
        poses = embedded(old, ',poses=')
        times = embedded(old, 'const frameTimes=')
        hints = {}
        for item in items:
            assert item == approved[item['id']], 'Frozen clip metadata changed'
            rep = results[item['id']]['rep']
            if rep is None:
                continue
            values = {k: rep[field] / 1000 - item['sourceStart']
                      for k, field in [('bottom', 'sampleStart'), ('top', 'top'), ('return', 'end')]}
            if not 0 <= values['bottom'] < values['top'] < values['return'] < item['duration']:
                continue
            hints[item['id']] = dict(times=values, method='pullup-phase-engine-frozen-expanded-v1')
        suggestions.update(hints)
        html = template.replace('batch-02', f'batch-03-{batch}').replace('criteria-02', f'criteria-03-{batch}')
        html = html.replace('__ITEMS__', json.dumps(items)).replace('__POSES__', json.dumps(poses, separators=(',', ':'))).replace('__FRAME_TIMES__', json.dumps(times, separators=(',', ':')))
        html = html.replace('const phaseSuggestions={};', 'const phaseSuggestions=' + json.dumps(hints) + ';')
        path.write_text(html)
    (BASE / 'phase-suggestions.json').write_text(json.dumps(dict(
        method='Existing frozen phase detections matched to the target movement; no label predictions.',
        results_sha256=hashlib.sha256(results_bytes).hexdigest(), suggestions=suggestions,
        limitation='Human-confirmed automatic suggestions are assisted annotations, not independent phase ground truth.'
    ), ensure_ascii=False, indent=2) + '\n')
    with zipfile.ZipFile(BASE / 'pullup-3d-review-30.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in (BASE / 'review').rglob('*'):
            if path.is_file():
                archive.write(path, 'pullup-3d-review/' + path.relative_to(BASE / 'review').as_posix())
    print(f'Updated 3 batches, {len(suggestions)}/30 automatic phase triplets; frozen metadata preserved.')


if __name__ == '__main__':
    main()
