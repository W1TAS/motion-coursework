from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import cv2
import numpy as np
from acquire_data import (atomic_json, atomic_jsonl, balanced_review, merge_candidate, read_json,
                          prepare, quality, read_jsonl, rejection, source_split, valid_video, write_csv)
from acquire_data import scene_cuts
from acquire_data import ranked_candidates
from acquire_data import collect_to_target, pending_clips
from label_tool import App, build_queue, collection_status, stop_collection
from merge_pools import merge, split_manifest


class AcquisitionTests(unittest.TestCase):
    def test_stop_interrupts_only_verified_collection_worker(self):
        import signal
        with tempfile.TemporaryDirectory() as tmp:
            data=Path(tmp)
            atomic_json(data/'bulk_collection_job.json',{'pid':43210,'argv':['worker']})
            with patch('label_tool.collection_worker_running',return_value=True), patch('label_tool.os.kill') as kill:
                self.assertEqual(stop_collection(data)[0],200)
                kill.assert_called_once_with(43210,signal.SIGINT)
            with patch('label_tool.collection_worker_running',return_value=False), patch('label_tool.os.kill') as kill:
                self.assertEqual(stop_collection(data)[0],200)
                kill.assert_not_called()
            atomic_json(data/'bulk_collection_job.json',{'pid':1,'argv':['worker']})
            with patch('label_tool.collection_worker_running',return_value=True), patch('label_tool.os.kill') as kill:
                stop_collection(data)
                kill.assert_not_called()

    def test_empty_queue_distinguishes_running_collection_from_finished(self):
        with tempfile.TemporaryDirectory() as tmp:
            data=Path(tmp)
            self.assertIsNone(collection_status(data))
            atomic_json(data/'bulk_collection_job.json',{'pid':1,'argv':['worker'],'target_clips':100})
            atomic_json(data/'run_state.json',{'collection':{'status':'running','pending_clips':0}})
            with patch('label_tool.collection_worker_running',return_value=True):
                self.assertTrue(collection_status(data)['active'])
            with patch('label_tool.collection_worker_running',return_value=False):
                self.assertFalse(collection_status(data)['active'])

    def test_target_counts_only_unseen_unbanned_clips(self):
        with tempfile.TemporaryDirectory() as tmp:
            out=Path(tmp)
            write_csv(out/'annotation_queue.csv',[dict(rep_id=str(i),video_id=str(i)) for i in range(5)])
            atomic_jsonl(out/'labels.jsonl',[dict(rep_id='0',action='label'),
                                           dict(rep_id='1',action='skip'),
                                           dict(video_id='2',action='ban_video')])
            self.assertEqual(pending_clips(out),2)

    def test_collection_stops_at_filtered_target_and_respects_total_budget(self):
        for target,budget,expected_status,expected_attempts in [(3,6,'complete',4),(9,3,'limited',3)]:
            with self.subTest(target=target), tempfile.TemporaryDirectory() as tmp:
                out=Path(tmp); args=SimpleNamespace(out=out,target_clips=target,max_downloads=budget,download_chunk=2)
                state={}; downloaded=[]
                def fake_download(args,candidates,state,index):
                    count=args.max_downloads
                    downloaded.extend(range(len(downloaded),len(downloaded)+count))
                    return count
                def fake_prepare(args,candidates,state):
                    write_csv(out/'annotation_queue.csv',[dict(rep_id=str(i),video_id=str(i)) for i in downloaded],['rep_id','video_id'])
                with patch('acquire_data.download_candidates',side_effect=fake_download), \
                     patch('acquire_data.prepare',side_effect=fake_prepare), patch('acquire_data.summary'):
                    result=collect_to_target(args,{},state,{})
                self.assertEqual(result['status'],expected_status)
                self.assertEqual(result['attempts'],expected_attempts)
                self.assertEqual(args.max_downloads,budget)

    def test_collection_stops_when_no_sources_remain(self):
        with tempfile.TemporaryDirectory() as tmp:
            args=SimpleNamespace(out=Path(tmp),target_clips=100,max_downloads=200,download_chunk=12)
            with patch('acquire_data.download_candidates',return_value=0) as download, \
                 patch('acquire_data.prepare'), patch('acquire_data.summary'):
                result=collect_to_target(args,{}, {},{})
            download.assert_called_once()
            self.assertEqual(result['stop_reason'],'no_candidates')

    def test_protects_known_videos_and_test_channels(self):
        args = SimpleNamespace(min_duration=8, max_duration=240)
        c = dict(id='new', channel_id='new_channel', duration=15)
        self.assertIsNone(rejection(c, args, {'old'}, {'old_channel'}, {'test_channel'}))
        self.assertEqual(rejection(dict(c, id='old'), args, {'old'}, set(), set()), 'already_known_video')
        self.assertEqual(rejection(dict(c, channel_id='test_channel'), args, set(), set(), {'test_channel'}), 'protected_test_channel')
        self.assertEqual(rejection(dict(c, channel_id=''), args, set(), set(), set()), 'unknown_channel')

    def test_duplicate_search_preserves_processing_state(self):
        candidates = {'x': dict(id='x', queries=['old'], tags=['swing'], status='processed', attempts=1)}
        merge_candidate(candidates, dict(id='x', title='new'), 'new query', 'partial')
        self.assertEqual(candidates['x']['status'], 'processed')
        self.assertEqual(candidates['x']['queries'], ['old', 'new query'])
        self.assertEqual(candidates['x']['tags'], ['swing', 'partial'])

    def test_unrelated_search_result_is_rejected(self):
        args=SimpleNamespace(min_duration=8,max_duration=240)
        candidate=dict(id='new',channel_id='new_channel',duration=20,title='Bolognese sauce recipe')
        self.assertEqual(rejection(candidate,args,set(),set(),set()),'unrelated_title')
        self.assertIsNone(rejection(dict(candidate,title='Dominadas con balanceo'),args,set(),set(),set()))

    def test_search_tags_do_not_override_title_intent(self):
        args=SimpleNamespace(seed=0,max_attempts=3,retry_failed=False)
        candidates={k:dict(id=k,title=title,tags=['swing'],status='discovered',duration=20,attempts=0)
                    for k,title in [('strict','Strict Pull Ups'),('kipping','Kipping Pull Ups'),('partial','Half Rep Pull Ups')]}
        self.assertEqual([r['id'] for r in ranked_candidates(candidates,args)],['kipping','partial','strict'])

    def test_group_assignment_is_stable(self):
        channels = [f'channel{i}' for i in range(200)]
        first = {c: source_split(c, 42, 0.2) for c in channels}
        second = {c: source_split(c, 42, 0.2) for c in reversed(channels)}
        self.assertEqual(first, second)
        self.assertEqual(set(first.values()), {'train', 'test'})

    def test_cropped_legs_do_not_qualify_for_swing(self):
        row = dict(usable='1', nan_frac='0.01', kp_conf='0.7', box_jump='0.01', knees_ok='1', ankles_ok='0.1')
        self.assertEqual(quality(row), (True, False))
        self.assertEqual(quality(dict(row, kp_conf='nan')), (False, False))
        self.assertEqual(quality(dict(row, ankles_ok='1', wr_move='1.8')), (False, False))
        self.assertEqual(quality(dict(row, ankles_ok='1', wr_move='0.3')), (True, True))

    def test_review_is_diverse_and_test_never_enters_priority_queue(self):
        args = SimpleNamespace(seed=42, review_limit=12, review_per_channel=3, review_per_video=2)
        rows = [dict(rep_id=str(i), video_id=str(i//3), channel_id=str(i//6), split='train',
                     quality_partial=1, quality_swing=1, partial_prob=i/30,
                     swing_prob=1-i/30, uncertainty=abs(i/30-0.5)) for i in range(30)]
        rows.append(dict(rows[0], rep_id='test', split='test', partial_prob=1, swing_prob=1))
        q = balanced_review(rows, args)
        self.assertEqual(len({r['rep_id'] for r in q}), len(q))
        self.assertNotIn('test', {r['rep_id'] for r in q})
        for channel in {r['channel_id'] for r in q}:
            self.assertLessEqual(sum(r['channel_id']==channel for r in q), 3)
        random_ids = [r['rep_id'] for r in q if r['selection']=='random']
        for r in rows: r['partial_prob'] = 1-r['partial_prob']
        self.assertEqual(random_ids, [r['rep_id'] for r in balanced_review(rows, args) if r['selection']=='random'])

    def test_curated_queue_hides_predictions_and_respects_split_pool(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)/'queue.csv'
            write_csv(p, [dict(rep_id='b', partial_prob=0.9), dict(rep_id='b', partial_prob=0.9), dict(rep_id='test', partial_prob=1), dict(rep_id='a', partial_prob=0)])
            result=build_queue([dict(rep_id='a'), dict(rep_id='b')], SimpleNamespace(seed=0,queue_file=p))
            self.assertEqual([r['rep_id'] for r,_ in result], ['b','a'])
            self.assertTrue(all('partial_prob' not in r for r,_ in result))

    def test_next_queue_respects_previous_reviews_and_banned_videos(self):
        args = SimpleNamespace(seed=42, review_limit=20, review_per_channel=3, review_per_video=2)
        rows = [dict(rep_id=str(i), video_id=str(i//3), channel_id=str(i//6), split='train',
                     quality_partial=1, quality_swing=1, partial_prob=0.8,
                     swing_prob=0.7, uncertainty=0.1) for i in range(18)]
        q = balanced_review(rows, args, reviewed={'0','1','3'}, banned={'2'})
        self.assertTrue(q)
        self.assertTrue(all(r['channel_id'] != '0' and r['video_id'] != '2' for r in q))
        self.assertTrue({'0','1','3'}.isdisjoint(r['rep_id'] for r in q))

    def test_merge_preserves_old_and_new_test(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); dataset=root/'dataset'; dataset.mkdir()
            old=root/'old'; new=root/'new'; old.mkdir(); new.mkdir()
            write_csv(dataset/'samples.csv', [dict(group='pool:old_test', split='test')])
            atomic_json(new/'source_assignments.json', {'new_test':'test','new_train':'train'})
            self.assertEqual(split_manifest(dataset,[old,new]), {'pool:old_test':'test','pool:new_test':'test','pool:new_train':'train'})
            for source,vid in [(old,'a'),(new,'b')]:
                (source/'videos').mkdir(); (source/'videos'/f'{vid}.mp4').write_bytes(b'dummy')
                write_csv(source/'reps.csv', [dict(rep_id=vid, video_id=vid)])
            atomic_jsonl(old/'labels.jsonl', [dict(rep_id='a',action='label',saved_at='2026-01-01')])
            out=root/'expanded'; merge([old,new],out,dataset)
            self.assertTrue((out/'videos/a.mp4').is_symlink())
            self.assertEqual(len(read_jsonl(out/'labels.jsonl')),1)
            merge([old,new],out,dataset)
            self.assertEqual(len(read_jsonl(out/'labels.jsonl')),1)

    def test_merge_retains_uncertain_journal_but_excludes_it_until_reviewed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); dataset=root/'dataset'; dataset.mkdir()
            source=root/'new'; source.mkdir()
            write_csv(source/'reps.csv',[dict(rep_id='a',video_id='v'),dict(rep_id='b',video_id='v')])
            atomic_json(source/'source_assignments.json',{'channel':'train'})
            uncertain=dict(rep_id='a',action='label',unsure=True,saved_at='1')
            certain=dict(rep_id='b',action='label',unsure=False,saved_at='1')
            atomic_jsonl(source/'labels.jsonl',[uncertain,certain])
            out=root/'expanded'
            self.assertEqual(merge([source],out,dataset)['excluded_unsure'],1)
            self.assertEqual(read_json(out/'sample_exclusions.json',{}),{'pool:a':'unsure'})
            self.assertEqual(len(read_jsonl(out/'labels.jsonl')),2)
            atomic_jsonl(source/'labels.jsonl',[uncertain,certain,dict(uncertain,unsure=False,saved_at='2')])
            self.assertEqual(merge([source],out,dataset)['excluded_unsure'],0)
            self.assertEqual(read_json(out/'sample_exclusions.json',{}),{})

    def test_small_batches_resume_after_labels_and_skips(self):
        with tempfile.TemporaryDirectory() as tmp:
            data=Path(tmp)
            rows=[dict(rep_id=str(i),video_id='v',segment_idx='0',rep_idx=str(i),
                       start=str(i),end=str(i+1),top=str(i+0.5),duration='1',
                       usable='1',split='train') for i in range(5)]
            write_csv(data/'reps.csv',rows)
            args=SimpleNamespace(data=data,split='train',include_unusable=False,max_pbad=1,
                                 seed=0,queue='time',queue_file=None,batch_size=2,show_hints=False)
            app=App(args)
            self.assertEqual([r['rep_id'] for r in app.queue_json()['items']],['0','1'])
            atomic_jsonl(data/'labels.jsonl',[dict(rep_id='0',action='label',labels={},clean=True,bad=False,unsure=False),dict(rep_id='1',action='skip')])
            self.assertEqual([r['rep_id'] for r in app.queue_json()['items']],['2','3'])

    def test_preparation_recovers_interrupted_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            out=Path(tmp)
            for name in ('videos','kps','meta'): (out/name).mkdir()
            path=out/'videos/x.avi'
            writer=cv2.VideoWriter(str(path),cv2.VideoWriter_fourcc(*'MJPG'),10,(32,32))
            for i in range(40): writer.write(np.full((32,32,3),i,np.uint8))
            writer.release(); self.assertTrue(valid_video(path))
            atomic_jsonl(out/'segments.jsonl',[dict(video_id='x',segment_idx=0,start=0,end=3)])
            candidates={'x':dict(id='x',status='downloaded',channel_id='c',tags=[],queries=[])}
            args=SimpleNamespace(out=out,threads=2,pose_model='unused',max_duration=4)
            segment=dict(start=0,end=3,n_reps=2)
            skeleton=dict(t=np.arange(20),kp=np.zeros((20,17,2)),conf=np.ones((20,17)),box=np.zeros((20,4)),wh=np.array([32,32]),fps=np.array(10))
            state=dict(searched=[])
            with patch('ultralytics.YOLO', return_value=object()), patch('filter_videos.process_video',return_value=(dict(video_id='x',n_segments=1),[segment])), patch('extract_keypoints.process_segment',return_value=skeleton), patch('acquire_data.subprocess.run') as run, patch('acquire_data.build_review_queue') as queue:
                prepare(args,candidates,state)
                self.assertEqual(len(read_jsonl(out/'segments.jsonl')),1)
                self.assertEqual(candidates['x']['status'],'processed')
                run.reset_mock(); queue.reset_mock()
                prepare(args,candidates,state)
                run.assert_called_once(); queue.assert_called_once()

    def test_open_viewer_reloads_new_repetitions_and_curated_queue(self):
        with tempfile.TemporaryDirectory() as tmp:
            data=Path(tmp); queue=data/'queue.csv'
            first=dict(rep_id='a',video_id='v',segment_idx='0',rep_idx='0',start='0',
                       end='1',top='0.5',duration='1',usable='1',split='train')
            write_csv(data/'reps.csv',[first]); write_csv(queue,[dict(rep_id='a')])
            args=SimpleNamespace(data=data,split='train',include_unusable=False,max_pbad=1,
                                 seed=0,queue='time',queue_file=queue,batch_size=2,show_hints=False)
            app=App(args)
            atomic_jsonl(data/'labels.jsonl',[dict(rep_id='a',action='skip')])
            second=dict(first,rep_id='b',start='2',end='3',top='2.5')
            write_csv(data/'reps.csv',[first,second]); write_csv(queue,[dict(rep_id='b')])
            self.assertEqual([r['rep_id'] for r in app.queue_json()['items']],['b'])
            self.assertIn('b',app.by_id)

    def test_combined_viewer_saves_source_split_without_model_hints(self):
        with tempfile.TemporaryDirectory() as tmp:
            data=Path(tmp); queue=data/'queue.csv'
            base=dict(video_id='v',segment_idx='0',rep_idx='0',start='0',end='1',
                      top='0.5',duration='1',usable='1')
            write_csv(data/'reps.csv',[dict(base,rep_id='a',split='train'),dict(base,rep_id='b',split='test')])
            write_csv(queue,[dict(rep_id='a'),dict(rep_id='b')])
            args=SimpleNamespace(data=data,split='all',include_unusable=False,max_pbad=1,
                                 seed=0,queue='time',queue_file=queue,batch_size=20,show_hints=False)
            app=App(args)
            items=app.queue_json()['items']
            self.assertEqual([r['rep_id'] for r in items],['a','b'])
            self.assertTrue(all('hint' not in r for r in items))
            for rid in ('a','b'):
                self.assertEqual(app.save_label(dict(rep_id=rid,action='label',clean=True))[0],200)
            self.assertEqual([r['split'] for r in read_jsonl(data/'labels.jsonl')],['train','test'])

    def test_abrupt_scene_change_is_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'cuts.avi'
            writer=cv2.VideoWriter(str(p),cv2.VideoWriter_fourcc(*'MJPG'),10,(96,54))
            for i in range(20):
                frame=np.full((54,96,3),10 if i<10 else 220,np.uint8)
                # Небольшое движущееся тело не должно давать смену сцены.
                frame[10:20,i:i+5]=100
                writer.write(frame)
            writer.release()
            self.assertEqual(scene_cuts(p),[1.0])


if __name__ == '__main__':
    unittest.main()
