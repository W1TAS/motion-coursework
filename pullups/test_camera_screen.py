"""Synthetic checks for background camera evidence; no private dataset required."""
import unittest

import cv2
import numpy as np

from prepare_static_front_screen import estimate_background_motion, summarize_camera


class CameraScreenTests(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(6)
        self.image = rng.integers(0, 256, (480, 640), dtype=np.uint8)
        self.image = cv2.GaussianBlur(self.image, (5, 5), 0)
        self.mask = np.full_like(self.image, 255)
        self.mask[100:420, 200:440] = 0

    def test_static_background_with_moving_subject_is_accepted(self):
        moved = self.image.copy()
        moved[150:380, 230:400] = 0
        result = estimate_background_motion(self.image, moved, self.mask, self.mask)
        self.assertEqual(result['state'], 'measured')
        self.assertLess(result['displacementAt640'], 1)
        self.assertEqual(summarize_camera([result])['state'], 'near_static')

    def test_translation_and_zoom_are_camera_motion(self):
        for matrix in (np.array([[1., 0., 12.], [0., 1., -8.]]),
                       cv2.getRotationMatrix2D((320, 240), 0, 1.035)):
            with self.subTest(matrix=matrix):
                moved = cv2.warpAffine(self.image, matrix, (640, 480))
                result = estimate_background_motion(self.image, moved, self.mask, self.mask)
                self.assertEqual(result['state'], 'measured')
                self.assertEqual(summarize_camera([result])['state'], 'moving')

    def test_featureless_background_is_unknown(self):
        blank = np.zeros_like(self.image)
        result = estimate_background_motion(blank, blank, self.mask, self.mask)
        self.assertEqual(result['state'], 'unknown')
        self.assertEqual(summarize_camera([result])['state'], 'unknown')

    def test_missing_observations_cannot_certify_a_static_camera(self):
        good = dict(state='measured', displacementAt640=.2)
        missing = dict(state='unknown', reason='few_background_tracks')
        self.assertEqual(summarize_camera([good, missing])['state'], 'unknown')
        self.assertEqual(summarize_camera([missing, dict(state='measured', displacementAt640=12)])['state'], 'moving')


if __name__ == '__main__':
    unittest.main()
