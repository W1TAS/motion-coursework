import copy
import unittest

from measure_bar_offsets import signed_distance
from refine_bar_offsets import anchored_candidate


def edge(y):
    return dict(a=[0,y],b=[100,y],offsetPixels=100-y,angleDegrees=0.,coverage=1.)


class BarOffsetTest(unittest.TestCase):
    def test_units_translation_and_endpoint_order(self):
        a,b=dict(x=0,y=100),dict(x=100,y=100)
        self.assertEqual(signed_distance((50,80),a,b),20)
        self.assertEqual(signed_distance((50,80),b,a),20)
        self.assertEqual(signed_distance((110,180),dict(x=10,y=220),dict(x=210,y=220)),40)

    def test_hand_anchor_selects_near_bar_over_background(self):
        candidates=[edge(50),edge(54),edge(80),edge(84)]
        before=copy.deepcopy(candidates)
        hand=dict(points=[[10,82],[90,82]])
        result=anchored_candidate(candidates,hand,100)
        self.assertEqual(result['status'],'paired_edge_candidate')
        self.assertEqual(result['offsetPixels'],20)
        self.assertEqual(candidates,before)
        reversed_result=anchored_candidate(list(reversed(candidates)),hand,100)
        self.assertEqual(reversed_result['offsetPixels'],20)

    def test_missing_hands_and_unsupported_edges_abstain(self):
        self.assertEqual(anchored_candidate([edge(80),edge(84)],None,100)['reason'],'hand_points_unavailable')
        r=anchored_candidate([edge(50),edge(54)],dict(points=[[10,82],[90,82]]),100)
        self.assertEqual(r['reason'],'no_supported_edge_pair')

    def test_near_equal_competing_pairs_are_ambiguous(self):
        r=anchored_candidate([edge(80),edge(84),edge(86),edge(90)],dict(points=[[10,85],[90,85]]),100)
        self.assertEqual(r['status'],'unavailable')
        self.assertEqual(r['reason'],'ambiguous_edge_pairs')


if __name__=='__main__':unittest.main()
