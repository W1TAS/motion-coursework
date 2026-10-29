#!/usr/bin/env python3
"""Собирает датасет из размеченных повторений: скелеты + метки с масками + разбиение.

Запуск:
    python build_dataset.py --pool data --dry-run            # только разбиение и статистика
    python build_dataset.py --pool data --own mine --out dataset

Читает в каждой папке reps.csv, labels.jsonl и kps/*.npz. Пишет в --out:
    samples.csv      одна строка на повторение: метки, маски, разбиение, метаданные
    skeletons.npz    kp (N,17,2), conf (N,17), t (N,) для всех кадров подряд + offsets (n+1,);
                     повторение i это кадры offsets[i]:offsets[i+1]
    README.txt       правила, по которым получены метки

Метки partial / swing / asym:  1 = есть,  0 = нет,  -1 = неизвестно (в лоссе игнорировать).
  * X (не повторение, сломанный скелет) и неразмеченные повторения в датасет не попадают.
  * неполная амплитуда бинарная: слабая и явная метки обе дают 1 (по скелету градации не различимы).
  * слабая асимметрия даёт -1 (флаг --ignore-weak); есть колонки partial_sev, swing_sev, asym_sev (0/1/2).
  * раскачка: если не отмечена, а колени или лодыжки не видны (knees_ok или ankles_ok < 0.8), то -1,
    потому что отсутствие раскачки по такому скелету не проверить.

Частота кадров: у видео 24/25/30 к/с; по умолчанию все повторения линейно интерполируются до 30 к/с
(--fps 0 оставляет как есть). В samples.csv поле fps это итоговая частота.

Координаты скелета: очищены (как в rep_features.py: короткие дырки интерполированы, лёгкое
сглаживание), сдвинуты на медианное положение середины плеч в отрезке и разделены на медианную
ширину плеч в отрезке (одна константа на отрезок, не покадровая нормировка: иначе пропадает
сигнал раскачки). Оси как в изображении (y вниз). Точки без данных: 0, conf = 0.

Свои записи называй S01__описание.mp4, S02__...: префикс до "__" это сессия, и вся сессия целиком
идёт в одну часть. Сессии для val и test задаются флагами --own-val S07,S08 --own-test S09,S10, остальные в train.

Вес w_group = 1/sqrt(число повторений группы), нормированный к среднему 1: им можно ограничить влияние
крупных каналов при обучении (без него один канал с 90 повторениями перевешивает десяток маленьких).

Колонка fold (0..K-1) даёт разбиение на K фолдов по каналам для кросс-валидации: при таком малом числе
каналов с раскачкой (около 18) одно разбиение train/val/test даёт очень шумную оценку, а прогон по всем
фолдам оценивает на всех каналах. Свои записи имеют fold = -1 и всегда остаются в обучении.

Разбиение: по каналам (свои записи по видео), с подбором так, чтобы положительных примеров каждой
ошибки хватало в каждой части. Свои записи по умолчанию целиком в train (--own-split spread
раскидывает их по видео так же, как каналы).
"""
import argparse
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path
from types import SimpleNamespace

import numpy as np

ERR = ["partial", "swing", "asym"]
SPLITS = ["train", "val", "test"]


# ----------------------------------------------------------------------------
# Чтение
# ----------------------------------------------------------------------------
def fnum(r, k):
    try:
        return float(r[k])
    except (KeyError, ValueError, TypeError):
        return float("nan")


def session_of(video_id):
    """Свои записи: имя файла вида S03__любое-окончание задаёт сессию S03. Одна сессия = одна группа
    разбиения, чтобы куски одной съёмки не попали в разные части. Без '__' сессией служит сам файл."""
    return video_id.split("__")[0] if "__" in video_id else video_id


def load_source(root: Path, tag: str):
    """Список повторений с последней меткой (без X)."""
    with open(root / "reps.csv", encoding="utf-8") as f:
        reps = {r["rep_id"]: r for r in csv.DictReader(f)}
    last, banned = {}, set()
    for line in (root / "labels.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            if r.get('action') == 'ban_video' and r.get('video_id'):
                banned.add(r['video_id'])
            if r.get("action") == "label" and r["rep_id"] in reps:
                last[r["rep_id"]] = r
    out = []
    for rid, lab in last.items():
        row = reps[rid]
        if lab["bad"] or lab.get('unsure') or row['video_id'] in banned or row.get("usable") != "1":
            continue
        group = (row.get("channel_id") or "").strip()
        group = f"{tag}:{group}" if group and tag == "pool" else f"{tag}:{session_of(row['video_id'])}"
        out.append({"uid": f"{tag}:{rid}", "source": tag, "root": str(root), "rep_id": rid,
                    "video_id": row["video_id"], "segment_idx": int(row["segment_idx"]),
                    "group": group, "facing": row.get("facing", ""), "start": fnum(row, "start"),
                    "end": fnum(row, "end"), "duration": fnum(row, "duration"),
                    "knees_ok": fnum(row, "knees_ok"), "ankles_ok": fnum(row, "ankles_ok"),
                    "lab": lab["labels"], "clean": bool(lab["clean"]), "unsure": bool(lab["unsure"])})
    return out


def targets(s, args):
    ign = set(args.ignore_weak.split(",")) if args.ignore_weak else set()
    legs_ok = s["knees_ok"] >= 0.8 and s["ankles_ok"] >= 0.8
    t = {}
    for e in ERR:
        sev = int(s["lab"].get(e, 0))
        if sev > 0:
            y = -1 if (sev == 1 and e in ign) else 1
        else:
            y = 0
        if e == "swing" and y == 0 and args.leg_mask and not legs_ok:
            y = -1
        t[e], t[e + "_sev"] = y, sev
    return t


# ----------------------------------------------------------------------------
# Разбиение по группам со стратификацией
# ----------------------------------------------------------------------------
def group_vectors(samples):
    """На группу: [n, 1, pos x3, known x3, has_pos x3] (has_pos: есть ли у группы положительный пример класса)."""
    g = defaultdict(lambda: np.zeros(2 + 3 * len(ERR)))
    k = len(ERR)
    for s in samples:
        v = g[s["group"]]
        v[0] += 1
        v[1] = 1
        for i, e in enumerate(ERR):
            v[2 + i] += s[e] == 1
            v[2 + k + i] += s[e] != -1
            v[2 + 2 * k + i] = max(v[2 + 2 * k + i], float(s[e] == 1))
    return g


def assign_groups(samples, fracs, names, seed, restarts, force_train_prefix=None, max_group_share=0.2,
                  force_map=None, max_pos_share=None, min_pos_for_cap=20):
    """Жадный подбор с перезапусками: группы целиком по частям names с долями fracs. Минимизирует отклонение
    от целевых долей по числу повторений, групп, положительных примеров, известных меток и числу групп с
    положительными примерами. max_group_share: группы крупнее этой доли от самой маленькой части идут в
    первую часть (для train/val/test), None отключает. max_pos_share: то же для положительных примеров класса."""
    k = len(ERR)
    groups = group_vectors(samples)
    gnames = list(groups)
    V = np.array([groups[n] for n in gnames])
    tot = V.sum(0)
    w = np.array([0.5, 0.7] + [1.0] * k + [0.3] * k + [1.0] * k)
    target = np.outer(fracs, tot)
    scale = np.maximum(target, 1.0)
    small = min(fracs) * tot[0]
    force_map = force_map or {}
    big = np.zeros(len(gnames), bool)
    if max_group_share is not None:
        big |= V[:, 0] > max_group_share * small
    if max_pos_share is not None:
        for c in range(k):
            if tot[2 + c] >= min_pos_for_cap:
                big |= V[:, 2 + c] > max_pos_share * min(fracs) * tot[2 + c]
    forced_idx = np.array([names.index(force_map[n]) if n in force_map else
                           (0 if ((bool(force_train_prefix) and n.startswith(force_train_prefix)) or big[i]) else -1)
                           for i, n in enumerate(gnames)])
    forced = forced_idx >= 0
    rng = np.random.RandomState(seed)
    best, best_cost = None, np.inf
    for _ in range(restarts):
        share = (V[:, 2:2 + k] / np.maximum(tot[2:2 + k], 1)).max(1)
        order = np.argsort(-(share + rng.rand(len(gnames)) * 0.15 + 10.0 * forced))
        S = np.zeros_like(target)
        asg = np.zeros(len(gnames), int)
        for i in order:
            if forced[i]:
                S[forced_idx[i]] += V[i]
                asg[i] = forced_idx[i]
                continue
            cands = []
            for sp in range(len(fracs)):
                S2 = S.copy()
                S2[sp] += V[i]
                cands.append((((S2 - target) / scale) ** 2 * w).sum())
            sp = int(np.argmin(cands))
            S[sp] += V[i]
            asg[i] = sp
        cost = (((S - target) / scale) ** 2 * w).sum()
        if cost < best_cost:
            best, best_cost = asg.copy(), cost
    return {n: names[a] for n, a in zip(gnames, best)}


def assign_splits(samples, fracs, seed, restarts, force_train_prefix=None, max_group_share=0.2, force_map=None,
                  max_pos_share=None):
    return assign_groups(samples, fracs, SPLITS, seed, restarts, force_train_prefix, max_group_share, force_map,
                         max_pos_share)


def print_fold_report(samples, n_folds):
    print(f"\nФолды для кросс-валидации по каналам (K={n_folds}); свои записи всегда в обучении (fold=-1):")
    print(f"{'фолд':>6}{'повторений':>11}{'групп':>7}{'неп.ампл.':>11}{'раскачка':>10}")
    for f in range(n_folds):
        ss = [s for s in samples if s.get("fold") == f]
        print(f"{f:>6}{len(ss):>11}{len({s['group'] for s in ss}):>7}"
              f"{sum(s['partial'] == 1 for s in ss):>11}{sum(s['swing'] == 1 for s in ss):>10}")


def print_split_report(samples):
    print(f"\n{'':>7}{'повторений':>11}{'каналов':>9}{'неп.ампл.':>11}{'раскачка':>10}{'асимметрия':>11}{'раск. отриц.':>13}")
    for sp in SPLITS:
        ss = [s for s in samples if s["split"] == sp]
        row = [len(ss), len({s['group'] for s in ss})]
        row += [sum(s[e] == 1 for s in ss) for e in ERR]
        row += [sum(s["swing"] == 0 for s in ss)]
        print(f"{sp:>7}{row[0]:>11}{row[1]:>9}{row[2]:>11}{row[3]:>10}{row[4]:>11}{row[5]:>13}")
    print("\nканалов с положительными примерами (train / val / test):")
    for e in ERR:
        c = [len({s['group'] for s in samples if s['split'] == sp and s[e] == 1}) for sp in SPLITS]
        flag = "  <- мало для честной оценки" if min(c[1:]) < 3 else ""
        print(f"  {e:>8}: {c[0]} / {c[1]} / {c[2]}{flag}")


# ----------------------------------------------------------------------------
# Скелеты
# ----------------------------------------------------------------------------
def resample(seq, conf, t, fps):
    """Линейная интерполяция до частоты fps. Там, где ближайший исходный кадр был пустым, остаётся NaN."""
    tt = np.arange(t[0], t[-1] + 1e-6, 1.0 / fps)
    out = np.full((len(tt), seq.shape[1], 2), np.nan)
    c_out = np.zeros((len(tt), seq.shape[1]))
    near = np.abs(tt[:, None] - t[None, :]).argmin(1)
    for j in range(seq.shape[1]):
        v = np.isfinite(seq[:, j]).all(axis=1)
        if v.sum() < 2:
            continue
        for c in range(2):
            out[:, j, c] = np.interp(tt, t[v], seq[v, j, c])
        c_out[:, j] = np.interp(tt, t, conf[:, j])
        out[~v[near], j] = np.nan
        c_out[~v[near], j] = 0
    return tt, out, c_out


_seg_cache = {}


def load_segment(root, vid, idx, cfg, rf):
    key = (root, vid, idx)
    if key not in _seg_cache:
        if len(_seg_cache) > 8:
            _seg_cache.clear()
        d = np.load(Path(root) / "kps" / f"{vid}_{idx}.npz")
        t, kp, conf = d["t"], d["kp"], d["conf"]
        P = rf.clean(kp, conf, t, cfg)
        scale = float(np.nanmedian(np.linalg.norm(P[:, rf.L_SH] - P[:, rf.R_SH], axis=1)))
        center = np.nanmedian((P[:, rf.L_SH] + P[:, rf.R_SH]) / 2, axis=0)
        fps = float(1.0 / np.median(np.diff(t)))
        _seg_cache[key] = (t, P, conf, scale, center, fps, d["wh"])
    return _seg_cache[key]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pool", default="data")
    ap.add_argument("--own", default=None, help="папка со своими записями (например mine)")
    ap.add_argument("--out", default="dataset")
    ap.add_argument("--split-manifest", type=Path, help="JSON: group -> train/val/test; сохраняет отложенные источники")
    ap.add_argument("--pad", type=float, default=0.2, help="запас вокруг повторения, с")
    ap.add_argument("--ignore-weak", default="asym", help="классы, где слабая метка = неизвестно (через запятую, '' = нет)")
    ap.add_argument("--no-leg-mask", dest="leg_mask", action="store_false")
    ap.add_argument("--val", type=float, default=0.15)
    ap.add_argument("--test", type=float, default=0.15)
    ap.add_argument("--own-split", choices=["train", "spread"], default="train")
    ap.add_argument("--own-val", default="", help="сессии своих записей для val, например S07,S08 (при --own-split train)")
    ap.add_argument("--own-test", default="", help="сессии своих записей для test, например S09,S10")
    ap.add_argument("--fps", type=float, default=30.0, help="привести все повторения к этой частоте кадров (0 = как есть)")
    ap.add_argument("--folds", type=int, default=6, help="число фолдов кросс-валидации по каналам (колонка fold; 0 или 1 = нет)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--restarts", type=int, default=400)
    ap.add_argument("--dry-run", action="store_true", help="только разбиение и статистика")
    args = ap.parse_args()
    if args.split_manifest is None and (Path(args.pool) / "split_manifest.json").exists():
        args.split_manifest = Path(args.pool) / "split_manifest.json"

    samples = load_source(Path(args.pool), "pool")
    if args.own:
        samples += load_source(Path(args.own), "own")
    exclusions_path = Path(args.pool) / 'sample_exclusions.json'
    if exclusions_path.exists():
        exclusions = json.loads(exclusions_path.read_text(encoding='utf-8'))
        if not isinstance(exclusions, dict):
            raise SystemExit('Некорректный sample_exclusions: ожидается uid -> причина')
        before = len(samples)
        samples = [s for s in samples if s['uid'] not in exclusions]
        print(f'Исключено до пересмотра: {before - len(samples)}')
    for s in samples:
        s.update(targets(s, args))
    print(f"Годных размеченных повторений: {len(samples)} "
          f"(pool {sum(s['source'] == 'pool' for s in samples)}, own {sum(s['source'] == 'own' for s in samples)})")
    print("Метки (1 / 0 / -1 неизвестно):")
    for e in ERR:
        print(f"  {e:>8}: {sum(s[e] == 1 for s in samples)} / {sum(s[e] == 0 for s in samples)} / {sum(s[e] == -1 for s in samples)}")

    fracs = np.array([1 - args.val - args.test, args.val, args.test])
    force = "own:" if args.own_split == "train" else None
    force_map = {}
    if args.split_manifest is None and (Path(args.pool) / "source_assignments.json").exists():
        assignments = json.loads((Path(args.pool) / "source_assignments.json").read_text(encoding="utf-8"))
        force_map = {f"pool:{channel}": split for channel, split in assignments.items()}
    if args.split_manifest:
        force_map = json.loads(args.split_manifest.read_text(encoding="utf-8"))
        if not isinstance(force_map, dict) or any(v not in SPLITS for v in force_map.values()):
            raise SystemExit("Некорректный split-manifest: ожидается group -> train/val/test")
    if args.own_split == "train":
        for name, sp in ((args.own_val, "val"), (args.own_test, "test")):
            for ses in [x.strip() for x in name.split(",") if x.strip()]:
                force_map[f"own:{ses}"] = sp
    mapping = assign_splits(samples, fracs, args.seed, args.restarts, force_train_prefix=force, force_map=force_map)
    for s in samples:
        s["split"] = mapping[s["group"]]
    pool_s = [s for s in samples if s["source"] == "pool"]
    # test полностью исключается из CV: иначе тестовые каналы попадали бы в train других фолдов
    # (условие "fold != f" пропускало бы их) и test перестал бы быть честно отложенным.
    cv_eligible = [s for s in pool_s if s["split"] != "test"]
    if args.folds > 1 and cv_eligible:
        fold_path = Path(args.pool) / 'fold_manifest.json'
        frozen_folds = json.loads(fold_path.read_text(encoding='utf-8')) if fold_path.exists() else {}
        if not isinstance(frozen_folds, dict) or any(not isinstance(v, int) or not 0 <= v < args.folds for v in frozen_folds.values()):
            raise SystemExit('Некорректный fold_manifest: ожидается group -> номер фолда')
        fm = assign_groups(cv_eligible, [1.0 / args.folds] * args.folds, list(range(args.folds)), args.seed,
                           args.restarts, max_group_share=None, force_map=frozen_folds)
        for s in samples:
            s["fold"] = fm[s["group"]] if (s["source"] == "pool" and s["group"] in fm) else -1
    else:
        for s in samples:
            s["fold"] = -1
    sizes = defaultdict(int)
    for s in samples:
        sizes[s["group"]] += 1
    raw = np.array([1.0 / np.sqrt(sizes[s["group"]]) for s in samples])
    for s, w in zip(samples, raw / raw.mean()):
        s["w_group"] = round(float(w), 4)
    print_split_report(samples)
    if args.folds > 1:
        print_fold_report(samples, args.folds)
    if args.dry_run:
        return

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import rep_features as rf
    cfg = SimpleNamespace(kp_conf=0.3, smooth_s=0.1, max_gap_s=0.4)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    kp_all, conf_all, t_all, offsets, kept = [], [], [], [0], []
    for s in sorted(samples, key=lambda s: (s["root"], s["video_id"], s["segment_idx"], s["start"])):
        f = Path(s["root"]) / "kps" / f'{s["video_id"]}_{s["segment_idx"]}.npz'
        if not f.exists():
            continue
        t, P, conf, scale, center, fps, wh = load_segment(s["root"], s["video_id"], s["segment_idx"], cfg, rf)
        if not np.isfinite(scale) or scale < 5:
            continue
        m = (t >= s["start"] - args.pad) & (t <= s["end"] + args.pad)
        if m.sum() < 8:
            continue
        seq, tt, c = (P[m] - center) / scale, t[m], conf[m]
        if args.fps > 0:
            tt, seq, c = resample(seq, c, tt, args.fps)
            fps = args.fps
        valid = np.isfinite(seq).all(axis=2)
        c = np.where(valid, c, 0.0)
        kp_all.append(np.nan_to_num(seq).astype(np.float32))
        conf_all.append(c.astype(np.float32))
        t_all.append((tt - s["start"]).astype(np.float32))
        offsets.append(offsets[-1] + len(tt))
        s.update({"scale_px": round(scale, 2), "fps": round(fps, 2), "frame_w": int(wh[0]), "frame_h": int(wh[1]),
                  "n_frames": len(tt), "valid_frac": round(float(valid.mean()), 3)})
        kept.append(s)
    if not kept:
        raise SystemExit("Ни одного повторения со скелетом: проверь папки kps/.")
    np.savez_compressed(out / "skeletons.npz", kp=np.concatenate(kp_all), conf=np.concatenate(conf_all),
                        t=np.concatenate(t_all), offsets=np.array(offsets, np.int64),
                        uid=np.array([s["uid"] for s in kept]))
    cols = ["uid", "source", "rep_id", "video_id", "segment_idx", "group", "split", "facing", "start", "end",
            "duration", "n_frames", "fps", "scale_px", "frame_w", "frame_h", "valid_frac", "knees_ok", "ankles_ok",
            "clean", "unsure", "partial", "swing", "asym", "partial_sev", "swing_sev", "asym_sev", "w_group", "fold"]
    with open(out / "samples.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for s in kept:
            w.writerow({**s, "clean": int(s["clean"]), "unsure": int(s["unsure"])})
    (out / "README.txt").write_text(__doc__, encoding="utf-8")
    print(f"\nСохранено {len(kept)} повторений в {out} (пропущено без скелета: {len(samples) - len(kept)}).")
    if len(kept) < len(samples):
        print_split_report(kept)


if __name__ == "__main__":
    main()
