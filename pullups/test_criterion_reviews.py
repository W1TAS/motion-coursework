import unittest
from criterion_reviews import compile_reviews, convert_v1, convert_v2, convert_v3, convert_top_adjudication, TOP_ADJUDICATION_SCHEMA


class CriterionReviewsTest(unittest.TestCase):
    def test_top_adjudication_preserves_other_criteria_and_phases(self):
        p = self.packet(); old = convert_v2('x', p['answers']['x'], p['items'][0])
        old['source_sha256'] = 'old'; old['partial_subtype'] = 'both'
        row = convert_top_adjudication('x',dict(review_status='sufficient',top_below_bar=0),old)
        self.assertEqual(row['targets'],dict(bottom_incomplete=0,top_below_bar=0,swing_ascent=1))
        self.assertEqual(row['phase_times'],old['phase_times'])
        self.assertEqual(row['phase_reference_sha256'],'old')
        self.assertEqual(row['prior_partial_subtype'],'both')
        self.assertNotIn('partial_subtype',row)
        self.assertIsNone(old['targets']['top_below_bar'])

    def test_top_uncertain_erases_only_the_previously_known_top(self):
        p=self.packet();p['answers']['x']['top_below_bar']='1'
        q=self.packet();q['schema']=TOP_ADJUDICATION_SCHEMA
        q['answers']['x']=dict(complete=True,review_status='uncertain',top_below_bar=None)
        samples={'x':dict(split='train',group='g',partial='1',swing='1')}
        r=compile_reviews([(p,{},'old'),(q,{},'new')],samples,{'x':p['items'][0]})['rows'][0]
        self.assertIsNone(r['targets']['top_below_bar'])
        self.assertEqual(r['targets']['bottom_incomplete'],0)
        self.assertFalse(r['ready_for_phase_features']['top_below_bar'])
        self.assertTrue(r['ready_for_phase_features']['bottom_incomplete'])

    def test_top_review_requires_consistent_status_and_existing_observation(self):
        p=self.packet();old=convert_v2('x',p['answers']['x'],p['items'][0])
        for answer in [dict(review_status='uncertain',top_below_bar=0),dict(review_status='sufficient',top_below_bar=True),dict(review_status='wrong',top_below_bar=1),dict(review_status='uncertain')]:
            with self.assertRaises(ValueError):convert_top_adjudication('x',answer,old)
        with self.assertRaises(ValueError):convert_top_adjudication('x',dict(review_status='sufficient',top_below_bar=0),None)

    def test_top_review_rejects_tampered_metadata_and_skips_unusable(self):
        p=self.packet();q=self.packet();q['schema']=TOP_ADJUDICATION_SCHEMA
        q['answers']['x']=dict(complete=True,review_status='unusable',top_below_bar=None)
        samples={'x':dict(split='train',group='g',partial='1',swing='1')}
        r=compile_reviews([(p,{},'old'),(q,{},'new')],samples,{'x':p['items'][0]})
        self.assertEqual(r['rows'],[])
        self.assertEqual(r['skipped'][0]['reason'],'upper_height_review_unusable')
        q['items'][0]['sourceStart']=99
        with self.assertRaises(ValueError):compile_reviews([(p,{},'old'),(q,{},'new')],samples,{'x':p['items'][0]})
    def test_subtype_only_does_not_invent_swing_phase_or_view_labels(self):
        row = convert_v3('x', dict(subtype='bottom_only'))
        self.assertEqual(row['targets'], dict(bottom_incomplete=1, top_below_bar=0, swing_ascent=None))
        self.assertIsNone(row['phase_times'])
        self.assertEqual(row['facing'], 'not_reviewed')
        self.assertTrue(all(v is None for v in convert_v3('x', dict(subtype='unknown'))['targets'].values()))

    def test_subtype_update_preserves_previous_phase_swing_and_view_evidence(self):
        p = self.packet(); old = convert_v2('x', p['answers']['x'], p['items'][0])
        old['source_sha256'] = 'previous'
        row = convert_v3('x', dict(subtype='top_only'), old)
        self.assertEqual(row['targets'], dict(bottom_incomplete=0, top_below_bar=1, swing_ascent=1))
        self.assertEqual(row['phase_times'], old['phase_times'])
        self.assertEqual(row['phase_reference_sha256'], 'previous')
        self.assertEqual(old['targets']['top_below_bar'], None)

    def test_subtype_packets_require_prepared_metadata_and_stay_without_human_phases(self):
        p = self.packet(); p['schema'] = 3
        p['answers']['x'] = dict(complete=True, subtype='both')
        sample = {'x': dict(split='train', group='g', partial='1', swing='0')}
        r = compile_reviews([(p, {}, 'sha')], sample, {'x': p['items'][0]})['rows'][0]
        self.assertEqual(r['targets']['bottom_incomplete'], 1)
        self.assertFalse(any(r['ready_for_phase_features'].values()))
        with self.assertRaises(ValueError):
            compile_reviews([(p, {}, 'sha')], sample, {'x': {}})

    def test_explicit_subtype_screening_rejects_clip_without_normal_labels(self):
        p = self.packet(); q = self.packet(); q['schema'] = 3
        q['answers']['x'] = dict(complete=True, subtype='unknown')
        samples = {'x': dict(split='train', group='g', partial='1', swing='0')}
        result = compile_reviews([(p, {}, 'old'), (q, {}, 'screened')], samples,
                                 screened_subtype_sources={'screened'})
        self.assertEqual(result['rows'], [])
        self.assertEqual(result['skipped'][0]['reason'], 'subtype_screening_rejected')
        self.assertEqual(result['screened_subtype_sources'], ['screened'])
        self.assertNotIn('targets', result['skipped'][0])

    def test_generic_unknown_still_preserves_previous_observations(self):
        p = self.packet(); q = self.packet(); q['schema'] = 3
        q['answers']['x'] = dict(complete=True, subtype='unknown')
        samples = {'x': dict(split='train', group='g', partial='1', swing='0')}
        result = compile_reviews([(p, {}, 'old'), (q, {}, 'ordinary')], samples,
                                 screened_subtype_sources={'other-source'})
        self.assertEqual(result['rows'][0]['targets']['bottom_incomplete'], 0)
        self.assertEqual(result['skipped'], [])

    def test_screening_acceptance_does_not_invent_exact_view_or_human_phases(self):
        p = self.packet(); p['schema'] = 3
        p['answers']['x'] = dict(complete=True, subtype='both')
        samples = {'x': dict(split='val', group='g', partial='1', swing='0')}
        row = compile_reviews([(p, {}, 'screened')], samples,
                              screened_subtype_sources={'screened'})['rows'][0]
        self.assertEqual(row['input_screening']['result'], 'accepted')
        self.assertEqual(row['facing'], 'not_reviewed')
        self.assertEqual(row['pose_quality'], 'not_reviewed')
        self.assertIsNone(row['phase_times'])
        self.assertFalse(any(row['ready_for_phase_features'].values()))

    def answer(self):
        return dict(window='Нет подтягивания', visible='Не могу определить',
                    bottom='Нижняя точка не видна / не могу определить',
                    top='Не достиг перекладины', swing='Не могу определить')

    def test_exaggerated_attempt_preserves_only_known_errors(self):
        row = convert_v1('x', self.answer(), {'attempt': 'exaggerated_error_demo'})
        self.assertEqual(row['targets'], dict(bottom_incomplete=None, top_below_bar=1, swing_ascent=None))
        self.assertEqual(row['attempt'], 'exaggerated_error_demo')

    def test_unrelated_movement_cannot_become_all_error_positive(self):
        self.assertTrue(all(v is None for v in convert_v1('x', self.answer(), {})['targets'].values()))

    def test_unsure_general_visibility_does_not_erase_specific_judgment(self):
        a = self.answer(); a['window'] = 'Одно полное повторение: низ → верх → низ'
        a['bottom'] = 'Полностью или почти полностью разогнуты'
        self.assertEqual(convert_v1('x', a, {})['targets']['bottom_incomplete'], 0)

    def packet(self):
        a = dict(complete=True, attempt='attempt', bottom_incomplete='0', top_below_bar='unknown',
                 swing_ascent='1', phase_times={'bottom': 1., 'top': 2., 'return': None})
        return {'schema': 2, 'items': [{'id': 'x', 'sourceStart': 10, 'duration': 5}], 'answers': {'x': a}}

    def test_unknown_is_not_negative_and_missing_return_does_not_hide_ascent(self):
        p = self.packet(); sample = {'x': dict(split='train', group='g', partial='0', swing='1')}
        result = compile_reviews([(p, {}, 'sha')], sample)['rows'][0]
        self.assertEqual(result['phase_times']['top'], 12)
        self.assertEqual(result['ready_for_phase_features'], dict(bottom_incomplete=True, top_below_bar=False, swing_ascent=True))
        self.assertIsNone(result['targets']['top_below_bar'])

    def test_reject_test_sources_and_bad_boundaries(self):
        p = self.packet()
        with self.assertRaises(ValueError):
            compile_reviews([(p, {}, 'sha')], {'x': dict(split='test')})
        p['answers']['x']['phase_times']['top'] = .5
        with self.assertRaises(ValueError):
            convert_v2('x', p['answers']['x'], p['items'][0])

    def test_partial_followup_does_not_erase_completed_answer(self):
        p = self.packet(); q = self.packet(); q['answers']['x']['complete'] = False
        sample = {'x': dict(split='train', group='g', partial='0', swing='1')}
        r = compile_reviews([(p, {}, 'first'), (q, {}, 'partial')], sample)
        self.assertEqual(r['rows'][0]['source_sha256'], 'first')

    def test_clip_offsets_cannot_silently_shift_source_annotations(self):
        p = self.packet(); approved = {'x': dict(p['items'][0])}
        p['items'][0]['sourceStart'] = 20
        with self.assertRaises(ValueError):
            compile_reviews([(p, {}, 'sha')], {'x': dict(split='train')}, approved)

    def test_human_view_is_preserved_and_validated_separately(self):
        p = self.packet(); answer = p['answers']['x']; answer['facing'] = 'front_oblique'
        row = convert_v2('x', answer, p['items'][0])
        self.assertEqual(row['facing'], 'front_oblique')
        answer['facing'] = 'made_up'
        with self.assertRaises(ValueError):
            convert_v2('x', answer, p['items'][0])

    def test_assisted_phases_keep_provenance(self):
        p = self.packet(); answer = p['answers']['x']
        answer['phase_sources'] = {'top': dict(kind='auto_confirmed', suggested_time=2, method='fixture')}
        row = convert_v2('x', answer, p['items'][0])
        self.assertEqual(row['phase_annotation_sources'], answer['phase_sources'])
        answer['phase_sources']['top']['suggested_time'] = 99
        with self.assertRaises(ValueError):
            convert_v2('x', answer, p['items'][0])

    def test_back_view_skip_excludes_earlier_labels_without_inventing_negatives(self):
        p = self.packet(); q = self.packet()
        q['answers']['x'] = dict(review_status='skipped_back', facing='back', complete=False)
        sample = {'x': dict(split='train', group='g', partial='0', swing='1')}
        r = compile_reviews([(p, {}, 'old'), (q, {}, 'skip')], sample)
        self.assertEqual(r['rows'], [])
        self.assertEqual(r['skipped'][0]['reason'], 'back_view')

    def test_optional_return_is_not_misrepresented_as_an_observed_phase(self):
        p = self.packet(); a = p['answers']['x']
        a['phase_sources'] = {'return': {'kind': 'not_required'}}
        row = convert_v2('x', a, p['items'][0])
        self.assertEqual(row['phase_annotation_sources']['return']['kind'], 'not_required')
        a['phase_sources'] = {'bottom': {'kind': 'not_required'}}
        with self.assertRaises(ValueError):
            convert_v2('x', a, p['items'][0])

    def test_unusable_skip_does_not_create_negative_targets(self):
        p = self.packet(); p['answers']['x'] = dict(review_status='skipped_unusable', complete=False)
        sample = {'x': dict(split='train', group='g', partial='0', swing='1')}
        r = compile_reviews([(p, {}, 'skip')], sample)
        self.assertEqual(r['rows'], [])
        self.assertEqual(r['skipped'][0]['reason'], 'unusable_clip')

    def test_repeated_review_can_use_a_second_exact_prepared_context(self):
        p = self.packet(); q = self.packet(); q['items'][0]['sourceStart'] = 11
        approved = {'x': [dict(p['items'][0]), dict(q['items'][0])]}
        samples = {'x': dict(split='train', group='g', partial='0', swing='1')}
        r = compile_reviews([(p, {}, 'first'), (q, {}, 'second')], samples, approved)
        self.assertEqual(r['rows'][0]['phase_times']['bottom'], 12)
        q['items'][0]['sourceStart'] = 99
        with self.assertRaises(ValueError):
            compile_reviews([(q, {}, 'tampered')], samples, approved)


if __name__ == '__main__':
    unittest.main()
