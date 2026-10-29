#!/usr/bin/env python3
"""Нарезает отрезки на повторения по скелетам, считает признаки и приоритет для разметки.

Запуск:
    python rep_features.py --data data
    python rep_features.py --data data --plot Nx9PE0sQ6vk,UOhwi1PgSOg   # графики сигналов
    python rep_features.py --data mine --own --sort time --ref-stats data/feature_stats.json

Результат в <data>:
    reps.csv             одно повторение = одна строка (времена, признаки, приоритеты, split)
    feature_stats.json   медианы и MAD признаков (можно передать другому набору через --ref-stats)
    plots/               (с --plot) графики сигналов по отрезкам

ВАЖНО про использование:
  * Приоритеты (priority_partial / _asym / _swing) только ранжируют очередь просмотра.
    Это НЕ метки: они посчитаны по тем же скелетам, что пойдут в классификатор.
  * split == "test" (около 30% каналов, по хэшу channel_id) размечай случайной выборкой,
    а не по приоритету, и не используй для ранжирования и обучения.
  * Все длины нормируются на одну константу на отрезок (медианная ширина плеч), а не покадрово:
    покадровая нормировка убила бы именно тот сигнал, по которому ищется раскачка.
"""
import argparse
import csv
import hashlib
import json
import warnings
from pathlib import Path

import numpy as np
from scipy.signal import find_peaks

warnings.simplefilter("ignore", RuntimeWarning)

NOSE = 0
L_SH, R_SH, L_EL, R_EL, L_WR, R_WR = 5, 6, 7, 8, 9, 10
L_HIP, R_HIP, L_KN, R_KN, L_AN, R_AN = 11, 12, 13, 14, 15, 16

# Признаки, по которым считаются робастные z-оценки
Z_FEATURES = ["rise", "nose_top", "elb_bot", "elb_top", "tilt_dev_abs", "wr_dy", "el_dy",
              "elb_diff", "elb_diff_p90", "elb_diff_top", "elb_lag", "sh_rise_asym", "hip_dx_dev",
              "thigh_rr", "shin_rr", "torso_rr", "hipw_rr", "knee_ang_min"]


# ----------------------------------------------------------------------------
# Очистка скелета
# ----------------------------------------------------------------------------
def fill(x, valid, t, max_gap):
    """Линейная интерполяция коротких дырок; там, где дырка длиннее max_gap, остаётся NaN."""
    if valid.sum() < 2:
        return np.full_like(x, np.nan)
    tv = t[valid]
    y = np.interp(t, tv, x[valid])
    i = np.searchsorted(tv, t)
    d = np.minimum(np.abs(t - tv[np.clip(i - 1, 0, len(tv) - 1)]),
                   np.abs(tv[np.clip(i, 0, len(tv) - 1)] - t))
    y[d > max_gap / 2] = np.nan
    return y


def smooth(x, k):
    """Скользящее среднее с учётом NaN; пропуски остаются пропусками."""
    if k <= 1:
        return x
    m = np.isfinite(x)
    v = np.where(m, x, 0.0)
    ker = np.ones(k)
    num, den = np.convolve(v, ker, "same"), np.convolve(m.astype(float), ker, "same")
    out = np.where(den > 0, num / np.maximum(den, 1e-9), np.nan)
    out[~m] = np.nan
    return out


def clean(kp, conf, t, args):
    dt = float(np.median(np.diff(t)))
    k = max(1, int(round(args.smooth_s / dt)))
    out = np.full_like(kp, np.nan, dtype=np.float64)
    for j in range(17):
        valid = (conf[:, j] >= args.kp_conf) & np.isfinite(kp[:, j, 0])
        for c in range(2):
            out[:, j, c] = smooth(fill(kp[:, j, c].astype(np.float64), valid, t, args.max_gap_s), k)
    return out


# ----------------------------------------------------------------------------
# Сигналы и повторения
# ----------------------------------------------------------------------------
def angle(P, a, b, c):
    v1, v2 = P[:, a] - P[:, b], P[:, c] - P[:, b]
    cos = (v1 * v2).sum(1) / (np.linalg.norm(v1, axis=1) * np.linalg.norm(v2, axis=1) + 1e-9)
    return np.degrees(np.arccos(np.clip(cos, -1, 1)))


def dist(P, a, b):
    return np.linalg.norm(P[:, a] - P[:, b], axis=1)


def series(P, scale):
    """Временные ряды в единицах ширины плеч (длины, координаты y) и градусах (углы)."""
    S = {}
    sh_mid, hip_mid = (P[:, L_SH] + P[:, R_SH]) / 2, (P[:, L_HIP] + P[:, R_HIP]) / 2
    S["sh_y"] = sh_mid[:, 1] / scale
    S["nose_y"] = P[:, NOSE, 1] / scale
    S["wr_y"] = (P[:, L_WR, 1] + P[:, R_WR, 1]) / 2 / scale
    eL, eR = angle(P, L_SH, L_EL, L_WR), angle(P, R_SH, R_EL, R_WR)
    S["eL"], S["eR"] = eL, eR
    S["shL_y"], S["shR_y"] = P[:, L_SH, 1] / scale, P[:, R_SH, 1] / scale
    S["elb"] = np.nanmean(np.stack([eL, eR]), axis=0)
    S["elb_diff"] = np.abs(eL - eR)
    dx = np.abs(P[:, L_SH, 0] - P[:, R_SH, 0])
    S["tilt"] = np.degrees(np.arctan2(P[:, L_SH, 1] - P[:, R_SH, 1], dx + 1e-9))
    S["wr_dy"] = np.abs(P[:, L_WR, 1] - P[:, R_WR, 1]) / scale
    S["el_dy"] = np.abs(P[:, L_EL, 1] - P[:, R_EL, 1]) / scale
    S["thigh"] = np.nanmean(np.stack([dist(P, L_HIP, L_KN), dist(P, R_HIP, R_KN)]), axis=0) / scale
    S["shin"] = np.nanmean(np.stack([dist(P, L_KN, L_AN), dist(P, R_KN, R_AN)]), axis=0) / scale
    S["torso"] = np.linalg.norm(hip_mid - sh_mid, axis=1) / scale
    S["hipw"] = dist(P, L_HIP, R_HIP) / scale
    S["hip_dx"] = np.abs(hip_mid[:, 0] - sh_mid[:, 0]) / scale
    S["knee_ang"] = np.nanmean(np.stack([angle(P, L_HIP, L_KN, L_AN), angle(P, R_HIP, R_KN, R_AN)]), axis=0)
    return S


def find_reps(sh_y_px, t, torso_px, args):
    """[(низ_i, верх_i, низ_i+1)] в индексах кадров. Верх = плечи максимально высоко."""
    ok = np.isfinite(sh_y_px)
    if ok.sum() < 10:
        return []
    y = np.interp(t, t[ok], sh_y_px[ok])
    dt = float(np.median(np.diff(t)))
    peaks, _ = find_peaks(-y, prominence=args.rep_prominence * torso_px,
                          distance=max(1, int(args.min_rep_s / dt)))
    if len(peaks) == 0:
        return []
    period = int(np.median(np.diff(peaks))) if len(peaks) > 1 else int(2.0 / dt)
    w = max(3, int(1.5 * period))
    a0 = max(0, peaks[0] - w)
    bottoms = [a0 + int(np.argmax(y[a0:peaks[0] + 1]))]
    for a, b in zip(peaks[:-1], peaks[1:]):
        bottoms.append(a + int(np.argmax(y[a:b + 1])))
    e = min(len(y), peaks[-1] + w + 1)
    bottoms.append(peaks[-1] + int(np.argmax(y[peaks[-1]:e])))
    return [(bottoms[i], int(peaks[i]), bottoms[i + 1]) for i in range(len(peaks))]


def rel_range(x):
    x = x[np.isfinite(x)]
    if len(x) < 5:
        return np.nan
    p5, p95 = np.percentile(x, [5, 95])
    m = np.median(x)
    return float((p95 - p5) / m) if m > 1e-6 else np.nan


def elbow_lag(a, b, dt, max_lag_s=0.5, min_range=15.0):
    """(|лаг| в секундах, корреляция) между углами левого и правого локтя.
    Лаг > 0: одна рука сгибается раньше другой. NaN, если движение локтей слишком мало или данных мало."""
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 15 or ok.mean() < 0.7:
        return np.nan, np.nan
    idx = np.arange(len(a))
    a, b = np.interp(idx, idx[ok], a[ok]), np.interp(idx, idx[ok], b[ok])
    if np.ptp(a) < min_range or np.ptp(b) < min_range:
        return np.nan, np.nan
    a, b = (a - a.mean()) / (a.std() + 1e-9), (b - b.mean()) / (b.std() + 1e-9)
    K, best, bk = int(round(max_lag_s / dt)), -np.inf, 0
    for k in range(-K, K + 1):
        x, y = (a[:len(a) - k], b[k:]) if k >= 0 else (a[-k:], b[:len(b) + k])
        if len(x) < 10:
            continue
        c = float(np.mean(x * y))
        if c > best:
            best, bk = c, k
    return abs(bk) * dt, best


def rep_feats(S, b0, top, b1, dt):
    sl = slice(b0, b1 + 1)
    w = slice(max(b0, top - 2), min(b1, top + 2) + 1)
    f = {
        # неполная амплитуда
        "rise": np.nanmax(S["sh_y"][sl]) - np.nanmin(S["sh_y"][sl]),   # размах плеч (в ширинах плеч)
        "nose_top": np.nanmedian(S["wr_y"][w] - S["nose_y"][w]),       # >0: нос выше запястий вверху
        "elb_bot": np.nanmax(S["elb"][sl]),                            # разгибание внизу, град.
        "elb_top": np.nanmin(S["elb"][sl]),                            # сгибание вверху, град.
        # асимметрия
        "tilt_mean": np.nanmean(S["tilt"][sl]),
        "wr_dy": np.nanmean(S["wr_dy"][sl]),
        "el_dy": np.nanmean(S["el_dy"][sl]),
        "elb_diff": np.nanmean(S["elb_diff"][sl]),
        "hip_dx": np.nanmean(S["hip_dx"][sl]),
        # асимметрия: «одна рука тянет сильнее» (разный угол локтей, одна сторона сгибается раньше)
        "elb_diff_p90": np.nanpercentile(S["elb_diff"][sl], 90) if np.isfinite(S["elb_diff"][sl]).any() else np.nan,
        "elb_diff_top": np.nanmedian(S["elb_diff"][w]),
        "sh_rise_asym": _rise_asym(S, sl),
        # раскачка: относительный размах проекций ног, торса и таза внутри повторения
        "thigh_rr": rel_range(S["thigh"][sl]),
        "shin_rr": rel_range(S["shin"][sl]),
        "torso_rr": rel_range(S["torso"][sl]),
        "hipw_rr": rel_range(S["hipw"][sl]),
        "knee_ang_min": np.nanmin(S["knee_ang"][sl]),
        # качество
        "nan_frac": float(np.mean(~np.isfinite(S["sh_y"][sl]) | ~np.isfinite(S["wr_y"][sl])
                                  | ~np.isfinite(S["torso"][sl]))),
        "knees_ok": float(np.mean(np.isfinite(S["thigh"][sl]))),
        "ankles_ok": float(np.mean(np.isfinite(S["shin"][sl]))),
    }
    f["elb_lag"], f["elb_corr"] = elbow_lag(S["eL"][sl], S["eR"][sl], dt)
    return {k: float(v) for k, v in f.items()}


def _rise_asym(S, sl):
    """Насколько по-разному поднимаются левое и правое плечо (доля от среднего подъёма)."""
    rL = np.nanmax(S["shL_y"][sl]) - np.nanmin(S["shL_y"][sl])
    rR = np.nanmax(S["shR_y"][sl]) - np.nanmin(S["shR_y"][sl])
    return abs(rL - rR) / (0.5 * (rL + rR) + 1e-6)


CORE = [L_SH, R_SH, L_EL, R_EL, L_WR, R_WR, L_HIP, R_HIP]


def diag_feats(S, conf, box, b0, b1, dt):
    """Признаки для отсева окон, которые не являются одним подтягиванием:
    wr_move / hang_frac   запястья должны быть неподвижны на перекладине и выше плеч;
    n_peaks_fine / speed_p95   несколько циклов в окне (таймлапс, склеенные повторения);
    kp_conf / box_jump    качество позы и подмена человека в кадре."""
    sl = slice(b0, b1 + 1)
    f = {}
    wr = S["wr_y"][sl]
    f["wr_move"] = float(np.nanpercentile(wr, 95) - np.nanpercentile(wr, 5)) if np.isfinite(wr).sum() > 3 else np.nan
    up = S["wr_y"][sl] < S["sh_y"][sl] - 0.1 * S["torso"][sl]
    ok = np.isfinite(S["wr_y"][sl]) & np.isfinite(S["sh_y"][sl]) & np.isfinite(S["torso"][sl])
    f["hang_frac"] = float(np.mean(up[ok])) if ok.any() else np.nan
    y = S["sh_y"][sl]
    good = np.isfinite(y)
    torso_med = np.nanmedian(S["torso"])
    if good.sum() > 10 and np.isfinite(torso_med) and torso_med > 0:
        y = np.interp(np.arange(len(y)), np.where(good)[0], y[good])
        peaks, _ = find_peaks(-y, prominence=0.08 * torso_med, distance=max(1, int(0.3 / dt)))
        f["n_peaks_fine"] = float(len(peaks))
        f["speed_p95"] = float(np.percentile(np.abs(np.gradient(y, dt)) / torso_med, 95))
    else:
        f["n_peaks_fine"] = f["speed_p95"] = np.nan
    f["kp_conf"] = float(np.mean(conf[sl][:, CORE]))
    bx = box[sl]
    if np.isfinite(bx).all() and len(bx) > 2:
        cen = (bx[:, :2] + bx[:, 2:]) / 2
        h = np.median(bx[:, 3] - bx[:, 1])
        f["box_jump"] = float(np.max(np.linalg.norm(np.diff(cen, axis=0), axis=1)) / h) if h > 1 else np.nan
    else:
        f["box_jump"] = np.nan
    return f


def analyze_segment(seg, d, args):
    t, kp, conf = d["t"], d["kp"], d["conf"]
    if len(t) < 20:
        return None
    P = clean(kp, conf, t, args)
    scale = np.nanmedian(dist(P, L_SH, R_SH))
    torso_px = np.nanmedian(np.linalg.norm((P[:, L_HIP] + P[:, R_HIP]) / 2 - (P[:, L_SH] + P[:, R_SH]) / 2, axis=1))
    if not np.isfinite(scale) or scale < 5 or not np.isfinite(torso_px):
        return None
    S = series(P, scale)
    reps = find_reps(S["sh_y"] * scale, t, torso_px, args)
    if not reps:
        return None
    rows = []
    dt = float(np.median(np.diff(t)))
    for i, (b0, top, b1) in enumerate(reps):
        f = rep_feats(S, b0, top, b1, dt)
        f.update(diag_feats(S, d["conf"], d["box"], b0, b1, dt))
        dur = float(t[b1] - t[b0])
        rows.append({"rep_idx": i, "start": float(t[b0]), "top": float(t[top]), "end": float(t[b1]),
                     "duration": dur, **f,
                     "usable": int(f["nan_frac"] <= args.max_nan and args.min_dur <= dur <= args.max_dur)})
    # признаки относительно остальных повторений этого же отрезка
    tilt_med = float(np.nanmedian(S["tilt"]))
    hipdx_med = float(np.nanmedian(S["hip_dx"]))
    rises = [r["rise"] for r in rows if r["usable"]]
    rise_med = float(np.median(rises)) if len(rises) >= 3 else np.nan
    dur_med = float(np.median([r["duration"] for r in rows]))
    for r in rows:
        r["dur_rel"] = r["duration"] / dur_med if dur_med > 0 else np.nan
        r["tilt_dev_abs"] = abs(r["tilt_mean"] - tilt_med)
        r["hip_dx_dev"] = abs(r["hip_dx"] - hipdx_med)
        r["rise_rel"] = r["rise"] / rise_med if np.isfinite(rise_med) and rise_med > 0 else np.nan
    return rows, P, S, t, reps


# ----------------------------------------------------------------------------
# Приоритеты
# ----------------------------------------------------------------------------
def compute_stats(rows):
    stats = {}
    for name in Z_FEATURES:
        v = np.array([r[name] for r in rows if r["usable"]], dtype=float)
        v = v[np.isfinite(v)]
        if len(v) < 5:
            continue
        med = float(np.median(v))
        # Пол по std: у признаков вроде лага (почти везде 0) MAD равен нулю, и любое отклонение
        # давало бы астрономическую z-оценку.
        mad = max(1.4826 * float(np.median(np.abs(v - med))), 0.1 * float(np.std(v)), 1e-6)
        stats[name] = {"median": med, "mad": mad}
    return stats


def zscore(r, name, stats):
    if name not in stats or not np.isfinite(r[name]):
        return np.nan
    z = (r[name] - stats[name]["median"]) / stats[name]["mad"]
    return float(np.arcsinh(z))  # сжимает хвост, но сохраняет порядок; для малых |z| почти равно z


def add_priorities(rows, stats):
    """Односторонняя робастная z-оценка «насколько хуже типичного»; максимум по признакам группы."""
    def top(vals):
        vals = [v for v in vals if np.isfinite(v)]
        return max(0.0, max(vals)) if vals else np.nan

    for r in rows:
        z = lambda n: zscore(r, n, stats)  # noqa: E731
        if not r["usable"]:
            r["priority_partial"] = r["priority_asym"] = r["priority_swing"] = r["priority"] = np.nan
            continue
        r["priority_partial"] = top([-z("rise"), -z("nose_top"), -z("elb_bot"), z("elb_top")])
        # elb_lag и sh_rise_asym остаются в CSV, но в приоритет не входят: на своих записях они не дали сигнала
        r["priority_asym"] = top([z("tilt_dev_abs"), z("el_dy"), z("elb_diff"), z("elb_diff_p90"),
                                  z("elb_diff_top"), z("hip_dx_dev")])
        r["priority_swing"] = top([z("thigh_rr"), z("shin_rr"), z("torso_rr"), z("hipw_rr"), -z("knee_ang_min")])
        ps = [p for p in (r["priority_partial"], r["priority_asym"], r["priority_swing"]) if np.isfinite(p)]
        r["priority"] = max(ps) if ps else np.nan


def dedupe(rows, tol=0.4):
    """Убирает повторения, найденные дважды в перекрывающихся отрезках одного видео
    (верхние точки ближе tol секунд). Остаётся годное и более длинное: у обрезанного краем повторение короче."""
    rows = sorted(rows, key=lambda r: (r["video_id"], r["top"]))
    kept = []
    for r in rows:
        if kept and kept[-1]["video_id"] == r["video_id"] and abs(kept[-1]["top"] - r["top"]) < tol:
            if (r["usable"], r["duration"]) > (kept[-1]["usable"], kept[-1]["duration"]):
                kept[-1] = r
            continue
        kept.append(r)
    return kept


def split_of(group_key):
    return "test" if int(hashlib.md5(str(group_key).encode()).hexdigest(), 16) % 10 < 3 else "train"


# ----------------------------------------------------------------------------
def plot_segment(seg, P, S, t, reps, path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(4, 1, figsize=(12, 9), sharex=True)
    panels = [("сдвиг плеч и подбородок (y вниз, в ширинах плеч)", ["sh_y", "nose_y", "wr_y"]),
              ("длины ног (бедро, голень), ширины плеч", ["thigh", "shin"]),
              ("торс и ширина таза, ширины плеч", ["torso", "hipw"]),
              ("наклон плеч, град. / разность высоты запястий", ["tilt", "wr_dy"])]
    for a, (title, keys) in zip(ax, panels):
        for k in keys:
            a.plot(t, S[k], label=k, lw=1)
        for b0, top, b1 in reps:
            a.axvline(t[top], color="g", alpha=0.3)
            a.axvline(t[b0], color="gray", alpha=0.2, ls=":")
        a.set_title(title, fontsize=9, loc="left")
        a.legend(loc="upper right", fontsize=7)
    ax[0].invert_yaxis()
    fig.suptitle(f'{seg["video_id"]}_{seg["segment_idx"]}  {seg.get("title") or ""}'[:110], fontsize=10)
    fig.tight_layout()
    fig.savefig(path, dpi=90)
    plt.close(fig)


def parse():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="data")
    ap.add_argument("--own", action="store_true", help="свои записи: split = own")
    ap.add_argument("--sort", choices=["priority", "time"], default="priority")
    ap.add_argument("--ref-stats", default=None, help="feature_stats.json другого набора для z-оценок")
    ap.add_argument("--plot", default="", help="video_id через запятую: сохранить графики сигналов")
    ap.add_argument("--kp-conf", type=float, default=0.3)
    ap.add_argument("--smooth-s", type=float, default=0.1, help="окно сглаживания, с")
    ap.add_argument("--max-gap-s", type=float, default=0.4, help="дырки короче этого интерполируются")
    ap.add_argument("--rep-prominence", type=float, default=0.12, help="в длинах торса, как в filter_videos.py")
    ap.add_argument("--min-rep-s", type=float, default=1.0)
    ap.add_argument("--max-nan", type=float, default=0.3, help="доля кадров без ключевых точек в повторении")
    ap.add_argument("--min-dur", type=float, default=0.8)
    ap.add_argument("--max-dur", type=float, default=10.0)
    return ap.parse_args()


def main():
    args = parse()
    data = Path(args.data)
    segs = [json.loads(l) for l in (data / "segments.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    plot_ids = {v for v in args.plot.split(",") if v}
    if plot_ids:
        (data / "plots").mkdir(exist_ok=True)

    rows, missing = [], 0
    for seg in segs:
        f = data / "kps" / f'{seg["video_id"]}_{seg["segment_idx"]}.npz'
        if not f.exists():
            missing += 1
            continue
        res = analyze_segment(seg, np.load(f), args)
        if res is None:
            continue
        seg_rows, P, S, t, reps = res
        clip_t0 = max(0.0, seg["start"] - 0.5)  # так режет filter_videos.py --cut
        for r in seg_rows:
            r.update({
                "rep_id": f'{seg["video_id"]}_{seg["segment_idx"]}_{r["rep_idx"]}',
                "video_id": seg["video_id"], "segment_idx": seg["segment_idx"],
                "channel_id": seg.get("channel_id"), "tags": "|".join(seg.get("tags") or []),
                "facing": seg.get("facing"), "clip": seg.get("clip", ""),
                "clip_start": r["start"] - clip_t0, "clip_end": r["end"] - clip_t0,
                "split": "own" if args.own else split_of(seg.get("channel_id") or seg["video_id"]),
            })
        rows += seg_rows
        if seg["video_id"] in plot_ids:
            plot_segment(seg, P, S, t, reps, data / "plots" / f'{seg["video_id"]}_{seg["segment_idx"]}.png')

    if not rows:
        raise SystemExit("Нет повторений. Проверь, что extract_keypoints.py отработал (папка kps/).")
    n_before = len(rows)
    rows = dedupe(rows)
    if len(rows) < n_before:
        print(f"Убрано дублей из перекрывающихся отрезков: {n_before - len(rows)}")
    if missing:
        print(f"[!] нет скелетов для {missing} отрезков (запусти extract_keypoints.py)")

    if args.ref_stats:
        stats = json.loads(Path(args.ref_stats).read_text())
    else:
        stats = compute_stats(rows)
        (data / "feature_stats.json").write_text(json.dumps(stats, indent=1))
    add_priorities(rows, stats)

    if args.sort == "priority":
        rows.sort(key=lambda r: -(r["priority"] if np.isfinite(r["priority"]) else -1))
    else:
        rows.sort(key=lambda r: (r["video_id"], r["segment_idx"], r["rep_idx"]))

    cols = (["rep_id", "video_id", "segment_idx", "rep_idx", "start", "top", "end", "duration",
             "clip", "clip_start", "clip_end", "split", "channel_id", "tags", "facing", "usable",
             "priority", "priority_partial", "priority_asym", "priority_swing", "rise_rel"]
            + [k for k in rows[0] if k not in ("rep_id", "video_id", "segment_idx", "rep_idx", "start", "top",
                                                "end", "duration", "clip", "clip_start", "clip_end", "split",
                                                "channel_id", "tags", "facing", "usable", "priority",
                                                "priority_partial", "priority_asym", "priority_swing", "rise_rel")])
    with open(data / "reps.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for r in rows:
            w.writerow({k: (round(v, 4) if isinstance(v, float) else v) for k, v in r.items()})
    n_use = sum(r["usable"] for r in rows)
    print(f"Повторений: {len(rows)} (годных {n_use}). Файл: {data / 'reps.csv'}")


if __name__ == "__main__":
    main()
