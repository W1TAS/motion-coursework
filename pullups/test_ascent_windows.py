import unittest
from export_ascent_windows import frames_between, compact


class AscentWindowsTest(unittest.TestCase):
    def test_end_is_top_not_the_following_descent(self):
        frames = [dict(now=t, width=10, height=20, landmarks=None) for t in (800, 1000, 1500, 2000, 2500, 3000)]
        cropped = frames_between(frames, 1, 2)
        self.assertEqual([f['now'] for f in cropped], [1000, 1500, 2000])
        self.assertEqual([f['t'] for f in compact(cropped, 1)], [0, .5, 1])
        self.assertIsNone(compact(cropped, 1)[0]['p'])

    def test_raw_points_are_preserved_in_documented_channel_order(self):
        p = dict(x=.1, y=.2, z=.3, visibility=.4, presence=.5)
        f = dict(now=1000, width=10, height=20, landmarks=[p])
        out = compact([f], 1)
        self.assertEqual(out[0]['p'][0], [.1, .2, .3, .4, .5])
        self.assertEqual(f['landmarks'][0], p)


if __name__ == '__main__':
    unittest.main()
