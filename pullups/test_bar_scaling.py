import unittest
from compare_bar_scaling import fit_coefficient,shifted_line


class BarScalingTest(unittest.TestCase):
    def test_body_scaling_preserves_the_coefficient_under_resolution_change(self):
        rows=[dict(offsetPixels=10,torso=100),dict(offsetPixels=20,torso=200)]
        k=fit_coefficient(rows,'torso')
        scaled=[dict(offsetPixels=r['offsetPixels']*2,torso=r['torso']*2) for r in rows]
        self.assertAlmostEqual(k,.1)
        self.assertAlmostEqual(fit_coefficient(scaled,'torso'),k)

    def test_reference_moves_upwards_for_both_anatomical_endpoint_orders(self):
        left,right=dict(x=100,y=100),dict(x=0,y=100)
        moved=shifted_line(left,right,20)
        self.assertEqual(moved,[dict(x=100,y=80),dict(x=0,y=80)])
        self.assertEqual(shifted_line(right,left,20),list(reversed(moved)))

    def test_invalid_scale_and_coincident_wrists_are_rejected(self):
        with self.assertRaises(ValueError):fit_coefficient([dict(offsetPixels=5,torso=0)],'torso')
        with self.assertRaises(ValueError):shifted_line(dict(x=1,y=1),dict(x=1,y=1),2)


if __name__=='__main__':unittest.main()
