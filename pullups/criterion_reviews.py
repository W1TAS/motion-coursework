"""Compile per-criterion human observations without rewriting legacy labels.

Unknown targets are None, never negatives. Temporal supervision is stored
separately: a valid human judgment need not have usable feature boundaries yet.
"""
import argparse
import hashlib
import json
from pathlib import Path

TARGETS = ('bottom_incomplete', 'top_below_bar', 'swing_ascent')
SUBTYPES = {'bottom_only': (1, 0), 'top_only': (0, 1), 'both': (1, 1),
            'neither': (0, 0), 'unknown': (None, None)}
TOP_ADJUDICATION_SCHEMA = 'top-proxy-adjudication-v1'
TOP_REVIEW_STATUSES = {'sufficient': 0, 'insufficient': 1, 'uncertain': None, 'unusable': None}
MAPS = {
    'bottom_incomplete': ('bottom', {'Полностью или почти полностью разогнуты': 0,
                                    'Заметно согнуты': 1}),
    'top_below_bar': ('top', {'Видимо выше перекладины': 0, 'Не достиг перекладины': 1}),
    'swing_ascent': ('swing', {'Нет заметной раскачки или рывка ногами': 0,
                             'Видна раскачка или рывок ногами': 1}),
}


def convert_v1(uid, answer, override):
    event = ('not_pullup' if answer['window'] == 'Нет подтягивания' else 'attempt')
    event = override.get('attempt', event)
    targets = {t: mapping.get(answer[field]) for t, (field, mapping) in MAPS.items()}
    if event == 'not_pullup':
        targets = dict.fromkeys(TARGETS)
    return dict(uid=uid, attempt=event, targets=targets,
                phase_times=None, temporal_status='needs_phase_annotation',
                pose_quality='not_reviewed',
                visibility_note=answer['visible'], window_note=answer['window'],
                correction=override or None)


def convert_v2(uid, answer, item):
    event = answer['attempt']
    if event not in ('attempt', 'exaggerated_error_demo', 'not_pullup', 'unknown'):
        raise ValueError('Unknown attempt type')
    targets = {}
    for t in TARGETS:
        value = answer[t]
        if value not in ('0', '1', 'unknown'):
            raise ValueError(f'Incomplete or unknown target: {t}')
        targets[t] = None if value == 'unknown' else int(value)
    if event in ('not_pullup', 'unknown'):
        targets = dict.fromkeys(TARGETS)
    times = answer.get('phase_times', {})
    if set(times) != {'bottom', 'top', 'return'}:
        raise ValueError('Each phase must have a timestamp or explicit null')
    for v in times.values():
        if v is not None and (type(v) not in (int, float) or not 0 <= v <= item['duration']):
            raise ValueError('Invalid phase timestamp')
    observed = [times[k] for k in ('bottom', 'top', 'return') if times[k] is not None]
    if any(a >= b for a, b in zip(observed, observed[1:])):
        raise ValueError('Phases must be ordered')
    absolute = {k: None if v is None else v + item['sourceStart'] for k, v in times.items()}
    sources = answer.get('phase_sources', {})
    if not isinstance(sources, dict) or set(sources) - set(times):
        raise ValueError('Invalid phase annotation provenance')
    for phase, source in sources.items():
        if not isinstance(source, dict) or source.get('kind') not in ('manual', 'auto_confirmed', 'not_visible', 'not_required'):
            raise ValueError('Invalid phase annotation source')
        if source['kind'] == 'not_required' and (phase != 'return' or times[phase] is not None):
            raise ValueError('Only an unlabelled return may be optional')
        if source['kind'] == 'auto_confirmed':
            value = source.get('suggested_time')
            if times[phase] is None or type(value) not in (int, float) or not 0 <= value < item['duration']:
                raise ValueError('Invalid confirmed phase suggestion')
    # Keep assisted annotations distinguishable from independent human timing.
    pose = answer.get('pose_quality', 'not_reviewed')
    if pose not in ('not_reviewed', 'usable', 'unstable', 'missing'):
        raise ValueError('Invalid pose quality')
    facing = answer.get('facing', 'not_reviewed')
    if facing not in ('not_reviewed', 'front', 'front_oblique', 'side', 'back', 'unknown'):
        raise ValueError('Invalid human view label')
    return dict(uid=uid, attempt=event, targets=targets, phase_times=absolute,
                phase_annotation_sources=sources,
                temporal_status='human_phase_annotations', pose_quality=pose,
                facing=facing, note=answer.get('note', ''))


def convert_v3(uid, answer, previous=None):
    subtype = answer.get('subtype')
    if subtype not in SUBTYPES:
        raise ValueError('Unknown partial subtype')
    row = dict(previous) if previous else dict(uid=uid, attempt='unknown',
        targets=dict.fromkeys(TARGETS), phase_times=None, temporal_status='needs_phase_annotation',
        pose_quality='not_reviewed', facing='not_reviewed')
    row['targets'] = dict(row['targets'])
    if subtype != 'unknown':
        row['attempt'] = 'attempt'
        row['targets'].update(zip(('bottom_incomplete', 'top_below_bar'), SUBTYPES[subtype]))
    if previous and previous.get('phase_times'):
        row['phase_reference_sha256'] = previous.get('phase_reference_sha256', previous.get('source_sha256'))
    row['partial_subtype'] = subtype
    row['annotation_scope'] = 'subtype_only_no_new_phase_or_view_annotations'
    return row


def convert_top_adjudication(uid, answer, previous):
    if previous is None:
        raise ValueError('Top adjudication requires the previous criterion observation')
    status = answer.get('review_status')
    if status not in TOP_REVIEW_STATUSES:
        raise ValueError('Invalid top review status')
    if 'top_below_bar' not in answer:
        raise ValueError('Top review requires a label or explicit null')
    label = answer.get('top_below_bar')
    expected = TOP_REVIEW_STATUSES[status]
    if label != expected or (expected is not None and type(label) is not int):
        raise ValueError('Top review status and label disagree')
    row = dict(previous)
    row['targets'] = dict(previous['targets'])
    row['top_review_previous'] = dict(label=previous['targets']['top_below_bar'],
                                      source_sha256=previous.get('source_sha256'))
    row['targets']['top_below_bar'] = label
    if status in ('sufficient', 'insufficient'):
        row['attempt'] = 'attempt'
    if row.get('phase_times'):
        row['phase_reference_sha256'] = previous.get('phase_reference_sha256', previous.get('source_sha256'))
    if 'partial_subtype' in row:
        row['prior_partial_subtype'] = row.pop('partial_subtype')
    row['top_review_status'] = status
    row['annotation_scope'] = 'upper_height_only_no_new_bottom_swing_phase_or_view_annotations'
    return row


def compile_reviews(reviews, samples, approved_items=None, screened_subtype_sources=()):
    merged, provenance, skipped = {}, [], {}
    for packet, corrections, source_sha in reviews:
        provenance.append(source_sha)
        items = {i['id']: i for i in packet['items']}
        if len(items) != len(packet['items']):
            raise ValueError('Duplicate items')
        for uid, a in packet['answers'].items():
            if uid not in items or uid not in samples or samples[uid]['split'] == 'test':
                raise ValueError('Review includes unknown or test UID')
            if packet['schema'] in (2, 3, TOP_ADJUDICATION_SCHEMA) and approved_items is not None:
                approved = approved_items.get(uid)
                variants = approved if isinstance(approved, list) else [approved]
                if items[uid] not in variants:
                    raise ValueError('Packet metadata differs from the prepared clip')
            if packet['schema'] == 1:
                row = convert_v1(uid, a, corrections.get('overrides', {}).get(uid, {}))
            elif packet['schema'] == 2:
                if a.get('review_status') in ('skipped_back', 'skipped_unusable'):
                    if a['review_status'] == 'skipped_back' and a.get('facing') != 'back':
                        raise ValueError('Skipped back view must have a back view label')
                    merged.pop(uid, None)
                    skipped[uid] = dict(uid=uid, reason='back_view' if a['review_status'] == 'skipped_back' else 'unusable_clip', facing=a.get('facing') or 'not_reviewed',
                                        note=a.get('note', ''), source_sha256=source_sha)
                    continue
                # A partial export may contain unfinished rows. It must not
                # erase a previously completed observation for the same UID.
                if not a.get('complete'):
                    continue
                row = convert_v2(uid, a, items[uid])
            elif packet['schema'] == 3:
                if not a.get('complete'):
                    continue
                # This interpretation requires an explicit, source-specific
                # statement by the annotator. A generic "unknown" answer alone
                # must not erase earlier independent observations.
                screened = source_sha in screened_subtype_sources
                if screened and a.get('subtype') == 'unknown':
                    merged.pop(uid, None)
                    skipped[uid] = dict(uid=uid, reason='subtype_screening_rejected',
                        source_sha256=source_sha, partial_subtype='unknown',
                        screening_scope='prepared_pose_window',
                        note='Annotator screened strong side angles and pose tracking faults; '
                             'the exact reason for each rejected clip was not collected.')
                    continue
                row = convert_v3(uid, a, merged.get(uid))
                if screened:
                    row['input_screening'] = dict(result='accepted',
                        scope='prepared_pose_window', source_sha256=source_sha,
                        note='Accepted under annotator angle/pose screening; '
                             'no exact human facing, pose score or phase time inferred.')
            elif packet['schema'] == TOP_ADJUDICATION_SCHEMA:
                if not a.get('complete'):
                    continue
                row = convert_top_adjudication(uid, a, merged.get(uid))
                if a['review_status'] == 'unusable':
                    merged.pop(uid, None)
                    skipped[uid] = dict(uid=uid, reason='upper_height_review_unusable',
                                        scope='prepared_pose_window', source_sha256=source_sha,
                                        note='Explicit unusable angle/pose answer; exact reason not collected.')
                    continue
            else:
                raise ValueError('Unsupported review schema')
            row.update(group=samples[uid]['group'], split=samples[uid]['split'],
                       source_sha256=source_sha, legacy_labels={
                           t: int(samples[uid][t]) for t in ('partial', 'swing')})
            skipped.pop(uid, None)
            # Do not train phase-specific inputs on unconfirmed legacy windows.
            times = row['phase_times'] or {}
            valid_event = row['attempt'] in ('attempt', 'exaggerated_error_demo')
            row['ready_for_phase_features'] = {
                t: valid_event and row['targets'][t] is not None and
                (times.get('bottom') is not None if t == 'bottom_incomplete' else
                 times.get('top') is not None if t == 'top_below_bar' else
                 times.get('bottom') is not None and times.get('top') is not None)
                for t in TARGETS}
            merged[uid] = row
    stats = {}
    for t in TARGETS:
        stats[t] = {name: sum(r['targets'][t] == label for r in merged.values())
                    for name, label in [('negative', 0), ('positive', 1), ('unknown', None)]}
        stats[t]['ready_for_phase_features'] = sum(r['ready_for_phase_features'][t] for r in merged.values())
        stats[t]['positive_groups'] = len({r['group'] for r in merged.values() if r['targets'][t] == 1})
    return dict(schema=1, targets=list(TARGETS), rows=list(merged.values()), counts=stats,
                skipped=list(skipped.values()),
                screened_subtype_sources=sorted(screened_subtype_sources),
                sources=provenance, legacy_labels_modified=False,
                note='Human video judgments; one annotator, development only. '
                     'Pose quality is separate. Ready for features is NOT training eligibility '
                     'or evidence that a criterion is observable from skeleton alone.')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--review', type=Path, action='append', required=True)
    p.add_argument('--corrections', type=Path)
    p.add_argument('--packet', type=Path, action='append', help='Approved selection manifest; repeat for multiple batches')
    p.add_argument('--screened-subtypes', type=Path, action='append', default=[],
                   help='A schema-3 --review whose unknown answers the annotator explicitly declared unusable after angle/pose screening')
    p.add_argument('--dataset', type=Path, default=Path(__file__).parent/'dataset_mediapipe_gpu')
    p.add_argument('--out', type=Path, required=True)
    args = p.parse_args()
    manifest = json.loads((args.dataset/'manifest.json').read_text())
    samples = {s['uid']: s for job in manifest['jobs'] for s in job['samples']}
    corrections = json.loads(args.corrections.read_text()) if args.corrections else {}
    reviews = [(json.loads(f.read_bytes()), corrections, hashlib.sha256(f.read_bytes()).hexdigest())
               for f in args.review]
    screened = {hashlib.sha256(f.read_bytes()).hexdigest() for f in args.screened_subtypes}
    if not screened <= {sha for packet, _, sha in reviews if packet['schema'] == 3}:
        raise ValueError('--screened-subtypes must refer to a supplied schema-3 --review')
    if any(r[0]['schema'] in (2, 3, TOP_ADJUDICATION_SCHEMA) for r in reviews) and not args.packet:
        raise ValueError('Prepared review schemas require --packet to verify clip offsets and identity')
    approved = {} if args.packet else None
    for packet in args.packet or []:
        for item in json.loads(packet.read_text())['items']:
            # The same repetition may be deliberately reviewed with a different
            # context cut. Accept only exact, prepared variants, never arbitrary
            # offsets from the answer file.
            variants = approved.setdefault(item['id'], [])
            if item not in variants:
                variants.append(item)
    result = compile_reviews(reviews, samples, approved, screened)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(result['counts'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
