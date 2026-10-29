#!/usr/bin/env python3
"""Оценивает, насколько повторение похоже на брак (метка X: не подтягивание, несколько
повторений в окне, сломанный скелет), и пишет <data>/p_bad.csv (rep_id, p_bad).

Запуск:
    python bad_filter.py --data data

Обучается на твоих метках из <data>/labels.jsonl (X против всех остальных) по признакам
из <data>/reps.csv и агрегатам по отрезку. Печатает качество на НОВЫХ видео
(кросс-валидация с разбиением по видео) и потери: сколько годных и ошибочных
повторений отсеялось бы при разных порогах.

Для размеченных повторений в p_bad кладётся оценка «вне обучения» (усреднённая по
кросс-валидации), для остальных оценка полной модели. Перезапускай после каждой новой порции
меток: модель улучшается по мере роста числа X и годных.

label_tool.py подхватывает p_bad.csv сам: исключает повторения с p_bad >= --max-pbad
и сортирует очередь по приоритету * (1 - p_bad).
"""
import argparse
import csv
import json
import warnings
from collections import defaultdict
from pathlib import Path

import numpy as np
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore")

BASE = ["duration", "rise", "nose_top", "elb_top", "elb_bot", "wr_move", "hang_frac", "n_peaks_fine",
        "speed_p95", "kp_conf", "box_jump", "dur_rel", "nan_frac", "knees_ok", "tilt_dev_abs",
        "elb_diff", "torso_rr"]
SEG_AGG = ["speed_p95", "wr_move", "n_peaks_fine", "duration", "rise", "nose_top", "hang_frac"]


def fnum(r, k):
    try:
        return float(r[k])
    except (KeyError, ValueError, TypeError):
        return float("nan")


def build_features(rows):
    seg = defaultdict(list)
    for r in rows.values():
        seg[(r["video_id"], r["segment_idx"])].append(r)

    def med(ss, k):
        v = [fnum(x, k) for x in ss]
        v = [x for x in v if np.isfinite(x)]
        return float(np.median(v)) if v else float("nan")

    seg_med = {key: [med(ss, k) for k in SEG_AGG] + [float(len(ss))] for key, ss in seg.items()}
    ids, X = [], []
    for k, r in rows.items():
        x = [fnum(r, c) for c in BASE]
        sp = fnum(r, "speed_p95")
        x.append(abs(np.log(max(sp, 0.05) / 2.4)) if np.isfinite(sp) else float("nan"))  # слишком медленно ИЛИ быстро
        x += seg_med[(r["video_id"], r["segment_idx"])]
        ids.append(k)
        X.append(x)
    return ids, np.array(X, float)


def make_model():
    return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(),
                         LogisticRegression(C=0.3, max_iter=500))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="data")
    ap.add_argument("--repeats", type=int, default=10, help="повторов кросс-валидации")
    args = ap.parse_args()
    data = Path(args.data)

    with open(data / "reps.csv", encoding="utf-8") as f:
        rows = {r["rep_id"]: r for r in csv.DictReader(f)}
    labels = {}
    for line in (data / "labels.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            if r.get("action") == "label" and r["rep_id"] in rows:
                labels[r["rep_id"]] = r

    ids, X = build_features(rows)
    idx = {k: i for i, k in enumerate(ids)}
    K = list(labels)
    y = np.array([labels[k]["bad"] for k in K])
    if y.sum() < 10 or (~y).sum() < 10:
        raise SystemExit(f"Мало меток для обучения: X={int(y.sum())}, не-X={int((~y).sum())}. Нужно хотя бы по 10.")
    g = np.array([rows[k]["video_id"] for k in K])
    XL = X[[idx[k] for k in K]]
    err = np.array([(not labels[k]["bad"]) and (not labels[k]["clean"]) for k in K])
    clean = np.array([labels[k]["clean"] for k in K])

    # Кросс-валидация по видео: качество на людях и роликах, которых модель не видела
    oof = np.zeros(len(y))
    uv = np.array(sorted(set(g)))
    n_folds = min(5, len(uv))
    for seed in range(args.repeats):
        rng = np.random.RandomState(seed)
        rng.shuffle(uv)
        m = {v: i % n_folds for i, v in enumerate(uv)}
        fold = np.array([m[v] for v in g])
        for t in range(n_folds):
            tr, te = fold != t, fold == t
            if y[tr].sum() == 0 or (~y[tr]).sum() == 0:
                continue
            mod = make_model().fit(XL[tr], y[tr])
            oof[te] += mod.predict_proba(XL[te])[:, 1] / args.repeats

    print(f"Размечено {len(K)} (X: {int(y.sum())}, ошибочных: {int(err.sum())}, чистых: {int(clean.sum())}), видео: {len(uv)}")
    print(f"AUC на новых видео: {roc_auc_score(y, oof):.2f}\n")
    print("порог | убрано X | убрано чистых | убрано ошибочных | X среди оставшихся")
    for thr in (0.5, 0.6, 0.7, 0.8):
        rem = oof >= thr
        print(f" {thr:.1f}  |  {rem[y].mean():5.0%}   |    {rem[clean].mean() if clean.any() else 0:5.0%}      |"
              f"  {int(rem[err].sum()):2d} из {int(err.sum()):2d}         |  {y[~rem].mean():.0%} (было {y.mean():.0%})")

    # Оценки для всех: внесмещённые для размеченных, полная модель для остальных
    model = make_model().fit(XL, y)
    p = model.predict_proba(X)[:, 1]
    for k, pv in zip(K, oof):
        p[idx[k]] = pv
    with open(data / "p_bad.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["rep_id", "p_bad"])
        for k in ids:
            w.writerow([k, round(float(p[idx[k]]), 4)])
    usable = np.array([rows[k]["usable"] == "1" for k in ids])
    print(f"\nЗаписано {data / 'p_bad.csv'}. p_bad >= 0.7 у {int(((p >= 0.7) & usable).sum())} из {int(usable.sum())} годных повторений.")


if __name__ == "__main__":
    main()
