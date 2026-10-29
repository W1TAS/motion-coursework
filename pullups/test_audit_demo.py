import json
from pathlib import Path
import tempfile
import unittest
from acquire_data import write_csv, atomic_jsonl
from build_dataset import load_source, assign_groups
from decision_rules import decide
from repost_check import source_key, variants
from acquire_data import similar_fingerprints


class AuditDemoTests(unittest.TestCase):
    def test_source_ids_are_namespaced_and_mirrored_repost_is_found(self):
        import cv2
        import numpy as np
        self.assertNotEqual(source_key('tiktok','123'),source_key('youtube','123'))
        with tempfile.TemporaryDirectory() as tmp:
            original=Path(tmp)/'a.avi'; mirrored=Path(tmp)/'b.avi'
            a=cv2.VideoWriter(str(original),cv2.VideoWriter_fourcc(*'MJPG'),12,(96,64))
            b=cv2.VideoWriter(str(mirrored),cv2.VideoWriter_fourcc(*'MJPG'),12,(96,64))
            rng=np.random.RandomState(17)
            for i in range(36):
                frame=rng.randint(0,256,(64,96,3),dtype=np.uint8)
                a.write(frame);b.write(cv2.flip(frame,1))
            a.release();b.release()
            left,right=variants(original),variants(mirrored)
            self.assertTrue(similar_fingerprints(left['normal'],right['mirrored']))

    def test_banning_video_removes_previously_clean_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)
            base=dict(segment_idx='0',start='0',end='1',duration='1',usable='1',channel_id='ch')
            write_csv(p/'reps.csv',[dict(base,rep_id='a',video_id='v1'),dict(base,rep_id='b',video_id='v2'),dict(base,rep_id='c',video_id='v3')])
            lab=dict(action='label',labels={},clean=True,bad=False,unsure=False)
            atomic_jsonl(p/'labels.jsonl',[dict(lab,rep_id='a'),dict(lab,rep_id='b'),dict(lab,rep_id='c',unsure=True),dict(action='ban_video',video_id='v1')])
            self.assertEqual([s['rep_id'] for s in load_source(p,'pool')],['b'])

    def test_frozen_folds_survive_adding_sources(self):
        rows=[dict(group=g,partial=i%2,swing=0,asym=0) for i,g in enumerate(['a','b','c','new'])]
        groups=assign_groups(rows,[.5,.5],[0,1],0,5,max_group_share=None,force_map={'a':0,'b':1,'c':0})
        self.assertEqual({g:groups[g] for g in ('a','b','c')},{'a':0,'b':1,'c':0})

    def test_rules_refuse_swing_when_legs_not_visible(self):
        kb=json.loads((Path(__file__).parent/'knowledge_rules.json').read_text())
        row=dict(usable='1',nan_frac=0,kp_conf=.9,box_jump=.01,wr_move=.1,knees_ok=1,ankles_ok=.1)
        result=decide(row,{'partial':.9,'swing':.9},{'partial':.4,'swing':.3},kb)
        self.assertEqual(result['targets']['partial']['state'],'flagged')
        self.assertEqual(result['targets']['swing']['state'],'unavailable')
        self.assertEqual(result['state'],'insufficient')

    def test_quality_refusal_is_not_clean_and_labels_do_not_affect_prediction(self):
        kb=json.loads((Path(__file__).parent/'knowledge_rules.json').read_text())
        row=dict(usable='1',nan_frac=0,kp_conf=.9,box_jump=.01,wr_move=2,knees_ok=1,ankles_ok=1)
        result=decide(row,{'partial':.1,'swing':.1},{'partial':.4,'swing':.3},kb)
        self.assertEqual(result['state'],'insufficient')
        self.assertEqual(result,decide(dict(row,clean=True,labels={'swing':2}),{'partial':.1,'swing':.1},{'partial':.4,'swing':.3},kb))


if __name__=='__main__': unittest.main()
