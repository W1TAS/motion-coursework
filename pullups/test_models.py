"""Проверки изоляции данных и совпадения обучения и инференса."""
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader

from feature_model import classifier, feature_matrix, load_feature_predictor, motion_features
from train import (AUX_FEATS, SkeletonClassifier, SkeletonDataset, collate,
                   fit_aux_norm, load_ensemble, training_samples, validate_splits)


class ModelTests(unittest.TestCase):
    def test_training_excludes_test_and_own_validation(self):
        rows = [dict(uid='train', source='pool', split='train', fold='0'),
                dict(uid='val', source='pool', split='val', fold='1'),
                dict(uid='test', source='pool', split='test', fold='-1'),
                dict(uid='own_train', source='own', split='train', fold='-1'),
                dict(uid='own_val', source='own', split='val', fold='-1'),
                dict(uid='own_test', source='own', split='test', fold='-1')]
        self.assertEqual([s['uid'] for s in training_samples(rows)], ['train', 'val', 'own_train'])

    def test_group_cannot_cross_folds_or_splits(self):
        a = dict(uid='a', group='channel', source='pool', split='train', fold='0')
        for b in [dict(a, uid='b', fold='1'), dict(a, uid='b', split='test', fold='-1')]:
            with self.assertRaises(ValueError):
                validate_splits([a, b])

    def test_aux_norm_ignores_held_out_extreme_values(self):
        aux = {'a': np.ones(16), 'b': np.ones(16) * 3, 'test': np.ones(16) * 1e8}
        med, mad = fit_aux_norm([{'uid': 'a'}, {'uid': 'b'}], aux)
        np.testing.assert_allclose(med, 2)
        np.testing.assert_allclose(mad, 1.4826)
        aux['test'] *= 100
        np.testing.assert_array_equal(fit_aux_norm([{'uid': 'a'}, {'uid': 'b'}], aux)[0], med)

    def test_norm_checkpoint_roundtrip_and_legacy_loading(self):
        torch.manual_seed(0)
        x = torch.randn(2, 6, 85)
        mask, lengths = torch.ones(2, 6, dtype=torch.bool), torch.tensor([6, 6])
        aux = torch.randn(2, 16)
        aux[0, 0] = float('nan')
        with tempfile.TemporaryDirectory() as tmp:
            for norm in [None, (np.ones(16), np.ones(16) * 2)]:
                model = SkeletonClassifier(85, 4, ['swing'], 16, dropout=0, aux_norm=norm).eval()
                values = torch.nan_to_num(aux) if norm is None else aux
                expected = torch.sigmoid(model(x, mask, lengths, values)['swing'])
                path = Path(tmp) / 'model.pt'
                torch.save(dict(state_dict=model.state_dict(), targets=['swing'], aux_dim=16,
                                hidden=4, layers=1, dropout=0), path)
                predict, _, _ = load_ensemble(path)
                torch.testing.assert_close(predict(x, mask, lengths, values)['swing'], expected)
                self.assertTrue(torch.isfinite(expected).all())

    def test_missing_joint_does_not_create_speed(self):
        pos = np.zeros((10, 17, 2), dtype=np.float32)
        pos[:, 11:13, 0] = 1
        pos[:, 5:7, 1] = -1
        conf = np.ones((10, 17), dtype=np.float32)
        conf[4, 11:13] = 0
        pos[4, 11:13, 0] = 1000
        values = motion_features(pos, conf)
        self.assertEqual(values[2], 0.0)
        self.assertEqual(values[5], 0.0)
        self.assertTrue(np.isnan(motion_features(pos, np.zeros_like(conf))).all())

    def test_ensemble_preserves_separate_fold_norms(self):
        torch.manual_seed(1)
        x = torch.randn(1, 5, 85)
        mask, lengths = torch.ones(1, 5, dtype=torch.bool), torch.tensor([5])
        aux = torch.ones(1, 16)
        models = [SkeletonClassifier(85, 4, ['swing'], 16, dropout=0,
                  aux_norm=(np.full(16, med), np.ones(16))).eval() for med in (0, 100)]
        expected = torch.stack([torch.sigmoid(m(x, mask, lengths, aux)['swing']) for m in models]).mean(0)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'ensemble.pt'
            torch.save(dict(ensemble=[m.state_dict() for m in models], targets=['swing'],
                            aux_dim=16, hidden=4, layers=1, dropout=0), path)
            predict, _, _ = load_ensemble(path)
            torch.testing.assert_close(predict(x, mask, lengths, aux)['swing'], expected)

    def test_tabular_training_and_inference_match(self):
        rng = np.random.default_rng(0)
        kp = rng.normal(size=(48, 17, 2)).astype(np.float32)
        conf = np.ones((48, 17), dtype=np.float32)
        offsets = np.array([0, 12, 26, 36, 48])
        rows = [dict(uid=str(i), _seg=i, fps='30', swing=str(i % 2), w_group='1') for i in range(4)]
        aux = {str(i): rng.normal(size=len(AUX_FEATS)).astype(np.float32) for i in range(4)}
        ds = SkeletonDataset(rows, kp, conf, offsets, aux, ['swing'])
        batch = next(iter(DataLoader(ds, batch_size=4, collate_fn=lambda b: collate(b, ['swing']))))
        x, mask, lengths, a, _, _, _ = batch
        for fs in ['base', 'motion']:
            features = feature_matrix(rows, kp, conf, offsets, aux, fs)
            model = classifier(dict(max_iter=2, min_samples_leaf=1), 0).fit(features, [0, 1, 0, 1])
            ckpt = dict(models={'swing': dict(model=model, feature_set=fs)}, targets=['swing'], operating_point={})
            predict, _, _ = load_feature_predictor(ckpt)
            np.testing.assert_allclose(predict(x, mask, lengths, a)['swing'], model.predict_proba(features)[:, 1], rtol=1e-6)
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / 'features.pt'
                torch.save(dict(ckpt, model_type='features'), path)
                restored, _, _ = load_ensemble(path)
                np.testing.assert_allclose(restored(x, mask, lengths, a)['swing'], predict(x, mask, lengths, a)['swing'])


if __name__ == '__main__':
    torch.set_num_threads(2)
    unittest.main()
