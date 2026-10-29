#!/usr/bin/env python3
"""Фильтр скачанных видео: оставляет отрезки, где один человек виден целиком,
висит на перекладине лицом (или спиной) к камере и реально делает повторения.

Два прохода:
  1. грубый (1 кадр/с по всему видео): по каждому кадру проверяем условия и склеиваем
     подряд идущие хорошие кадры в кандидатные отрезки;
  2. точный (10 кадров/с только внутри кандидатов): считаем повторения по траектории плеч.

Запуск:
    python filter_videos.py --data data
    python filter_videos.py --data data --model yolo11m-pose.pt --device 0 --cut

Результат в --data:
    video_report.jsonl   по каждому видео: почему кадры отсеивались, статистика ракурса
    segments.jsonl       отобранные отрезки: start/end, число повторений, время верхних точек
    clips/               (только с --cut) вырезанные отрезки через ffmpeg

Скрипт можно прерывать и запускать заново: уже обработанные видео пропускаются.
"""
import argparse
import json
import subprocess
from collections import Counter
from pathlib import Path

import cv2
import numpy as np
from scipy.signal import find_peaks
from tqdm import tqdm

# Индексы точек COCO-17
NOSE, L_EYE, R_EYE = 0, 1, 2
L_SH, R_SH, L_EL, R_EL, L_WR, R_WR = 5, 6, 7, 8, 9, 10
L_HIP, R_HIP, L_KN, R_KN = 11, 12, 13, 14

VIDEO_EXT = {".mp4", ".mkv", ".webm", ".mov", ".avi"}


def _np(x):
    return x.cpu().numpy() if hasattr(x, "cpu") else np.asarray(x)


# ----------------------------------------------------------------------------
# Проверка одного кадра
# ----------------------------------------------------------------------------
def analyze(res, args):
    """Возвращает (причина, признаки). Причина == 'ok', если кадр подходит.

    Признаки (ratio, facing, sh_y, torso) заполнены, если ключевые точки нашлись;
    ratio нужен, чтобы откалибровать порог ракурса по реальным данным.
    """
    if res.boxes is None or len(res.boxes) == 0 or res.keypoints is None:
        return "no_person", None
    xyxy, bconf = _np(res.boxes.xyxy), _np(res.boxes.conf)
    kxy, kcf = _np(res.keypoints.xy), _np(res.keypoints.conf)
    keep = bconf >= 0.4
    if not keep.any():
        return "no_person", None
    xyxy, kxy, kcf = xyxy[keep], kxy[keep], kcf[keep]

    areas = (xyxy[:, 2] - xyxy[:, 0]) * (xyxy[:, 3] - xyxy[:, 1])
    order = np.argsort(-areas)
    m = order[0]
    # Один человек: второй по размеру не должен быть сопоставим с главным.
    # Люди на заднем плане (маленькие) допустимы.
    if len(order) > 1 and areas[order[1]] > args.other_person_ratio * areas[m]:
        return "multi_person", None
    h_frac = float((xyxy[m, 3] - xyxy[m, 1]) / res.orig_shape[0])
    if h_frac < args.min_person_h:
        return "too_small", {"h_frac": h_frac}

    kp, cf = kxy[m], kcf[m]
    # Причина указывает, какая группа точек не найдена (первая по списку), чтобы можно было
    # понять, что именно ломает отбор: обрезанные ноги, руки у верхнего края кадра и т. д.
    knees_vis = bool((cf[[L_KN, R_KN]] >= args.kp_conf).all())
    groups = [("missing_shoulders", [L_SH, R_SH]), ("missing_wrists", [L_WR, R_WR]),
              ("missing_hips", [L_HIP, R_HIP])]
    if not args.no_knees:
        groups.append(("missing_knees", [L_KN, R_KN]))
    for name, idx in groups:
        if (cf[idx] < args.kp_conf).any():
            return name, None

    sh_mid = (kp[L_SH] + kp[R_SH]) / 2
    hip_mid = (kp[L_HIP] + kp[R_HIP]) / 2
    torso = float(np.linalg.norm(hip_mid - sh_mid))
    if torso < 5:
        return "missing_hips", None
    ratio = float(np.linalg.norm(kp[L_SH] - kp[R_SH]) / torso)  # ширина плеч / длина торса
    facing = "front" if cf[[NOSE, L_EYE, R_EYE]].mean() >= 0.5 else "back"
    feats = {"ratio": ratio, "facing": facing, "sh_y": float(sh_mid[1]), "torso": torso,
             "knees_vis": knees_vis, "h_frac": h_frac}

    # Виснет на перекладине: оба запястья выше середины плеч (ось y направлена вниз).
    if not (kp[[L_WR, R_WR], 1] < sh_mid[1] - args.wrist_margin * torso).all():
        return "not_hanging", feats
    # Ракурс: у фронта и спины плечи широкие относительно торса, у профиля узкие.
    if ratio < args.min_ratio:
        return "not_frontal", feats
    if args.views == "front" and facing != "front":
        return "back_view", feats
    return "ok", feats


def analyze_span(model, cap, fps, t0, t1, step_s, args):
    """Прогоняет позу по кадрам [t0, t1] с шагом step_s секунд. -> [(t, причина, признаки)]"""
    start, end = int(t0 * fps), int(t1 * fps)
    step = max(1, round(step_s * fps))
    cap.set(cv2.CAP_PROP_POS_FRAMES, start)
    out, buf, buf_t = [], [], []

    def flush():
        if not buf:
            return
        results = model(buf, imgsz=args.imgsz, device=args.device, verbose=False)
        for t, r in zip(buf_t, results):
            reason, feats = analyze(r, args)
            out.append((t, reason, feats))
        buf.clear()
        buf_t.clear()

    i = start
    while i < end:
        if not cap.grab():
            break
        if (i - start) % step == 0:
            ok, frame = cap.retrieve()
            if ok:
                buf.append(frame)
                buf_t.append(i / fps)
                if len(buf) >= args.batch:
                    flush()
        i += 1
    flush()
    return out


# ----------------------------------------------------------------------------
# Отрезки и повторения
# ----------------------------------------------------------------------------
def find_segments(samples, args):
    """Склеивает хорошие кадры в отрезки; дырки до max_gap секунд прощаются."""
    segs, start, last_ok = [], None, None
    for t, reason, _ in samples:
        if reason != "ok":
            continue
        if start is None:
            start = t
        elif t - last_ok > args.max_gap:
            segs.append((start, last_ok))
            start = t
        last_ok = t
    if start is not None:
        segs.append((start, last_ok))
    return [(a, b) for a, b in segs if b - a >= args.min_seg]


def count_reps(ts, y, torso_med, args):
    """Время верхних точек повторений (плечи максимально высоко = минимальный y)."""
    dt = float(np.median(np.diff(ts)))
    grid = np.arange(ts[0], ts[-1] + 1e-9, dt)
    sig = np.interp(grid, ts, y) / torso_med          # в единицах длины торса
    k = max(1, int(round(0.3 / dt)))                  # сглаживание ~0.3 с
    padded = np.pad(sig, (k // 2, k - 1 - k // 2), mode="edge")
    sig = np.convolve(padded, np.ones(k) / k, mode="valid")
    peaks, _ = find_peaks(-sig, prominence=args.rep_prominence,
                          distance=max(1, int(args.min_rep_s / dt)))
    return grid[peaks]


def evaluate_segment(fine, a, b, args):
    good = [(t, f) for t, r, f in fine if r == "ok"]
    if len(fine) < 5 or len(good) / len(fine) < args.min_coverage:
        return None
    ts = np.array([t for t, _ in good])
    y = np.array([f["sh_y"] for _, f in good])
    torso_med = float(np.median([f["torso"] for _, f in good]))
    reps = count_reps(ts, y, torso_med, args)
    if len(reps) < args.min_reps:
        return None
    facing = Counter(f["facing"] for _, f in good).most_common(1)[0][0]
    return {
        "start": round(a, 2), "end": round(b, 2),
        "n_reps": int(len(reps)),
        "rep_top_times": [round(float(t), 2) for t in reps],
        "ratio_median": round(float(np.median([f["ratio"] for _, f in good])), 3),
        "facing": facing,
        # доля кадров, где колени видны: нужна позже, чтобы выбирать отрезки для признаков по ногам
        "knees_frac": round(float(np.mean([f["knees_vis"] for _, f in good])), 2),
    }


def process_video(model, path, args):
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS)
    if not fps or fps != fps or fps > 240:
        fps = 30.0
    n = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    dur = min(n / fps if n and n > 0 else args.max_analyze_s, args.max_analyze_s)

    if args.whole_video:  # запасной режим для своих записей: без проверок весь ролик = один отрезок
        cap.release()
        seg = {"start": 0.0, "end": round(dur, 2), "n_reps": None, "rep_top_times": [],
               "ratio_median": None, "facing": None, "knees_frac": None}
        return {"video_id": path.stem, "analyzed_s": round(dur, 1), "n_samples": 0, "reasons": {},
                "ratio_p10_p50_p90": None, "person_h_p10_p50_p90": None, "n_segments": 1}, [seg]

    samples = analyze_span(model, cap, fps, 0.0, dur, args.coarse_step, args)
    reasons = Counter(r for _, r, _ in samples)
    ratios = [f["ratio"] for _, _, f in samples if f and "ratio" in f]
    hs = [f["h_frac"] for _, _, f in samples if f and "h_frac" in f]

    kept = []
    for a, b in find_segments(samples, args):
        fine = analyze_span(model, cap, fps, a, b, args.fine_step, args)
        seg = evaluate_segment(fine, a, b, args)
        if seg:
            kept.append(seg)
    cap.release()

    report = {
        "video_id": path.stem,
        "analyzed_s": round(dur, 1),
        "n_samples": len(samples),
        "reasons": dict(reasons),
        "ratio_p10_p50_p90": [round(float(np.percentile(ratios, p)), 3) for p in (10, 50, 90)]
        if ratios else None,
        "person_h_p10_p50_p90": [round(float(np.percentile(hs, p)), 3) for p in (10, 50, 90)]
        if hs else None,  # доля высоты кадра, которую занимает человек (для подбора --min-person-h)
        "n_segments": len(kept),
    }
    return report, kept


def cut_segment(src, seg, dst, pad=0.5):
    a = max(0.0, seg["start"] - pad)
    dur = seg["end"] - seg["start"] + 2 * pad
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{a:.2f}", "-i", str(src),
         "-t", f"{dur:.2f}", "-an", "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", str(dst)],
        check=True)


# ----------------------------------------------------------------------------
def parse():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="data")
    ap.add_argument("--model", default="yolo11s-pose.pt", help="yolo11n/s/m/l/x-pose.pt")
    ap.add_argument("--device", default=None, help="0 для GPU, cpu для процессора")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--cut", action="store_true", help="вырезать отобранные отрезки в clips/")
    ap.add_argument("--whole-video", action="store_true",
                    help="без проверок: весь ролик как один отрезок (для своих записей, если фильтр отсекает всё)")
    ap.add_argument("--views", choices=["any", "front", ], default="any",
                    help="any = фронт и спина, front = только лицом к камере")
    # Пороги кадра
    ap.add_argument("--min-ratio", type=float, default=0.55,
                    help="мин. отношение ширины плеч к длине торса (фронт ~0.7-1.0, профиль <0.3)")
    ap.add_argument("--kp-conf", type=float, default=0.4)
    ap.add_argument("--min-person-h", type=float, default=0.35, help="мин. высота человека в долях кадра")
    ap.add_argument("--other-person-ratio", type=float, default=0.25)
    ap.add_argument("--wrist-margin", type=float, default=0.1, help="запястья выше плеч минимум на эту долю торса")
    ap.add_argument("--no-knees", action="store_true", help="не требовать видимые колени")
    # Отрезки и повторения
    ap.add_argument("--coarse-step", type=float, default=1.0, help="шаг грубого прохода, с")
    ap.add_argument("--fine-step", type=float, default=0.1, help="шаг точного прохода, с")
    ap.add_argument("--max-gap", type=float, default=2.5, help="прощаемая дырка внутри отрезка, с")
    ap.add_argument("--min-seg", type=float, default=6.0, help="мин. длина отрезка, с")
    ap.add_argument("--min-coverage", type=float, default=0.6, help="доля хороших кадров в отрезке")
    ap.add_argument("--min-reps", type=int, default=2)
    ap.add_argument("--rep-prominence", type=float, default=0.12,
                    help="мин. размах плеч для повторения в длинах торса (низкий, чтобы ловить неполные)")
    ap.add_argument("--min-rep-s", type=float, default=1.0, help="мин. интервал между повторениями, с")
    ap.add_argument("--max-analyze-s", type=float, default=900, help="не смотреть дальше этой секунды")
    return ap.parse_args()


def main():
    args = parse()
    from ultralytics import YOLO  # импорт здесь, чтобы остальной код проверялся без torch

    data = Path(args.data)
    vids = sorted(p for p in (data / "videos").iterdir() if p.suffix.lower() in VIDEO_EXT)
    rep_file, seg_file = data / "video_report.jsonl", data / "segments.jsonl"
    done = set()
    if rep_file.exists():
        done = {json.loads(l)["video_id"] for l in rep_file.read_text(encoding="utf-8").splitlines() if l.strip()}
    if args.cut:
        (data / "clips").mkdir(exist_ok=True)

    model = YOLO(args.model)
    total_seg = total_reps = 0
    with open(rep_file, "a", encoding="utf-8") as frep, open(seg_file, "a", encoding="utf-8") as fseg:
        for vp in tqdm(vids, desc="фильтрация"):
            if vp.stem in done:
                continue
            try:
                report, segs = process_video(model, vp, args)
            except Exception as e:  # noqa: BLE001
                tqdm.write(f"[!] {vp.name}: {e}")
                continue
            mp = data / "meta" / f"{vp.stem}.json"
            meta = json.loads(mp.read_text(encoding="utf-8")) if mp.exists() else {}
            for i, s in enumerate(segs):
                s.update({"video_id": vp.stem, "segment_idx": i, "title": meta.get("title"),
                          "channel_id": meta.get("channel_id"), "channel": meta.get("channel"),
                          "tags": meta.get("tags"), "queries": meta.get("queries")})
                if args.cut and not args.whole_video:
                    dst = data / "clips" / f"{vp.stem}_{i}.mp4"
                    cut_segment(vp, s, dst)
                    s["clip"] = str(dst)
                fseg.write(json.dumps(s, ensure_ascii=False) + "\n")
                total_seg += 1
                total_reps += s["n_reps"] or 0
            frep.write(json.dumps(report, ensure_ascii=False) + "\n")
            frep.flush()
            fseg.flush()
    print(f"За этот запуск: {total_seg} отрезков, {total_reps} повторений. Детали: {seg_file}")


if __name__ == "__main__":
    main()