#!/usr/bin/env python3
"""Прогоняет позу по отобранным отрезкам (segments.jsonl) на полной частоте кадров
и сохраняет скелеты в <data>/kps/<video_id>_<segment_idx>.npz.

Это и есть основа будущего датасета: дальше видео не нужны.

Запуск:
    python extract_keypoints.py --data data --device 0
    python extract_keypoints.py --data mine --device 0        # твои записи (см. инструкцию)

В npz лежат:
    kp    (T, 17, 2)  пиксельные координаты, NaN там, где человек не найден
    conf  (T, 17)     уверенность модели по каждой точке
    box   (T, 4)      рамка человека
    t     (T,)        время кадра в секундах от начала исходного видео
    wh    (2,)        ширина и высота кадра
    fps   ()          эффективная частота после прореживания (--target-fps)

Главный человек выбирается как самый крупный; если в кадре несколько сопоставимых
по размеру, берётся тот, кто ближе к позиции человека в предыдущем кадре.
Скрипт возобновляемый: готовые npz пропускаются.
"""
import argparse
import json
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np
from tqdm import tqdm


def _np(x):
    return x.cpu().numpy() if hasattr(x, "cpu") else np.asarray(x)


def pick_main(res, prev_c):
    """(kp, conf, box) главного человека или None."""
    if res.boxes is None or len(res.boxes) == 0 or res.keypoints is None:
        return None
    xyxy, bconf = _np(res.boxes.xyxy), _np(res.boxes.conf)
    kxy, kcf = _np(res.keypoints.xy), _np(res.keypoints.conf)
    idx = np.where(bconf >= 0.3)[0]
    if len(idx) == 0:
        return None
    areas = (xyxy[idx, 2] - xyxy[idx, 0]) * (xyxy[idx, 3] - xyxy[idx, 1])
    cand = idx[areas >= 0.4 * areas.max()]
    if prev_c is not None and len(cand) > 1:
        cen = (xyxy[cand, :2] + xyxy[cand, 2:]) / 2
        j = cand[np.argmin(np.linalg.norm(cen - prev_c, axis=1))]
    else:
        j = idx[np.argmax(areas)]
    return kxy[j], kcf[j], xyxy[j]


def process_segment(model, cap, fps, seg, args):
    t0 = max(0.0, seg["start"] - args.pad)
    t1 = seg["end"] + args.pad
    start, end = int(t0 * fps), int(t1 * fps)
    step = max(1, round(fps / args.target_fps))
    cap.set(cv2.CAP_PROP_POS_FRAMES, start)

    ts, kps, cfs, boxes, buf, buf_t = [], [], [], [], [], []
    prev_c = None

    def flush():
        nonlocal prev_c
        if not buf:
            return
        results = model(buf, imgsz=args.imgsz, device=args.device, verbose=False)
        for t, r in zip(buf_t, results):
            m = pick_main(r, prev_c)
            ts.append(t)
            if m is None:
                kps.append(np.full((17, 2), np.nan, np.float32))
                cfs.append(np.zeros(17, np.float32))
                boxes.append(np.full(4, np.nan, np.float32))
            else:
                kp, cf, box = m
                prev_c = (box[:2] + box[2:]) / 2
                kps.append(kp.astype(np.float32))
                cfs.append(cf.astype(np.float32))
                boxes.append(box.astype(np.float32))
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
    if len(ts) < 10:
        return None
    return {
        "kp": np.stack(kps), "conf": np.stack(cfs), "box": np.stack(boxes),
        "t": np.array(ts, np.float64),
        "wh": np.array([cap.get(cv2.CAP_PROP_FRAME_WIDTH), cap.get(cv2.CAP_PROP_FRAME_HEIGHT)]),
        "fps": np.array(fps / step),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="data")
    ap.add_argument("--model", default="yolo11m-pose.pt", help="здесь можно взять модель потяжелее, чем в фильтре")
    ap.add_argument("--device", default=None)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--pad", type=float, default=0.5, help="запас вокруг отрезка, с (как при --cut)")
    ap.add_argument("--target-fps", type=float, default=30.0, help="60-fps видео прореживаются до ~30")
    args = ap.parse_args()

    from ultralytics import YOLO

    data = Path(args.data)
    segs = [json.loads(l) for l in (data / "segments.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    out = data / "kps"
    out.mkdir(exist_ok=True)
    by_video = defaultdict(list)
    for s in segs:
        by_video[s["video_id"]].append(s)

    model = YOLO(args.model)
    n_done = n_fail = 0
    for vid, ss in tqdm(by_video.items(), desc="видео"):
        todo = [s for s in ss if not (out / f'{vid}_{s["segment_idx"]}.npz').exists()]
        if not todo:
            continue
        files = [p for p in (data / "videos").glob(f"{vid}.*") if p.suffix not in (".part", ".ytdl")]
        if not files:
            tqdm.write(f"[!] нет файла для {vid}")
            continue
        cap = cv2.VideoCapture(str(files[0]))
        fps = cap.get(cv2.CAP_PROP_FPS)
        if not fps or fps != fps or fps > 240:
            fps = 30.0
        for s in todo:
            res = process_segment(model, cap, fps, s, args)
            if res is None:
                n_fail += 1
                continue
            np.savez_compressed(out / f'{vid}_{s["segment_idx"]}.npz', **res)
            n_done += 1
        cap.release()
    print(f"Сохранено {n_done} отрезков, не удалось {n_fail}. Папка: {out}")


if __name__ == "__main__":
    main()
