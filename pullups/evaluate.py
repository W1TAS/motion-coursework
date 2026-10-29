#!/usr/bin/env python3
"""Единственный раз проверяет сохранённую модель на split=="test" — том, что ни run_cv, ни sweep.py
не видели и не использовали для выбора гиперпараметров или порога. Запускать один раз, после того как
конфигурация и порог уже выбраны по CV/sweep: подбирать что-либо под этот результат больше нельзя,
иначе test перестаёт быть честным.

Запуск:
    python evaluate.py --dataset dataset --model dataset/model/model_final.pt --pool data --own mine

Печатает AUC/AP на test (для сравнения с CV — если сильно хуже, CV была оптимистична) и точность/
полноту при пороге, который сохранён в самой модели (посчитан по OOF в train.py, до просмотра test).
"""
import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train import SkeletonDataset, collate, load_aux, load_dataset, load_ensemble  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default="dataset")
    ap.add_argument("--model", default=None, help="по умолчанию <dataset>/model/model_final.pt")
    ap.add_argument("--pool", default=None)
    ap.add_argument("--own", default=None)
    ap.add_argument("--split", default="test", choices=["test", "val"],
                    help="test — независимая оценка; val — диагностика (часть CV)")
    ap.add_argument("--dump-predictions", action="store_true",
                    help="сохранить <dataset>/model/predictions_<split>.csv: по каждому повторению "
                         "истинная метка, вероятность, решение модели и путь к клипу — чтобы можно "
                         "было открыть и посмотреть, на чём модель ошибается")
    ap.add_argument("--by-facing", action="store_true", help="отдельно показать метрики для front/back")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = ap.parse_args()
    model_path = Path(args.model or Path(args.dataset) / "model" / "model_final.pt")
    device = torch.device(args.device)

    predict, targets, operating_point = load_ensemble(model_path, device)
    samples, kp, conf, offsets = load_dataset(Path(args.dataset))
    for s in samples:
        for t in targets:
            s[t] = -1 if s[t] == "-1" else int(s[t])
    test = [s for s in samples if s["split"] == args.split]
    if not test:
        raise SystemExit(f"Нет повторений с split=={args.split!r} в {args.dataset}/samples.csv")
    print(f"{args.split}: {len(test)} повторений, {len({s['group'] for s in test})} групп/каналов")

    ckpt = torch.load(model_path, map_location=device, weights_only=False)
    trained_uids = set(ckpt.get("train_uids", []))
    trained_groups = set(ckpt.get("train_groups", []))
    if any(s["uid"] in trained_uids or s["group"] in trained_groups for s in test):
        raise SystemExit("Выбранная часть пересекается с обучением модели; независимая оценка невозможна.")
    if ckpt.get("required_fps") and any(abs(float(s["fps"]) - ckpt["required_fps"]) > 1e-3 for s in test):
        raise SystemExit("Частота кадров датасета отличается от частоты обучения модели.")
    aux_map = None
    if ckpt.get("aux_dim"):
        aux_map = load_aux(args.pool, args.own, ckpt.get("aux_feats"))
        if not aux_map:
            raise SystemExit("Модель обучена с признаками из reps.csv (aux), но --pool/--own не заданы "
                             "или reps.csv не найден — без них модель не запустить.")
        if ckpt.get("aux_preprocessing") != "model":
            med, mad = np.array(ckpt["aux_norm"]["med"]), np.array(ckpt["aux_norm"]["mad"])
            aux_map = {k: np.nan_to_num((v - med) / mad, nan=0.0).astype(np.float32) for k, v in aux_map.items()}
        for s in test:
            if s["uid"] not in aux_map:
                fill = np.nan if ckpt.get("aux_preprocessing") == "model" else 0.0
                aux_map[s["uid"]] = np.full(ckpt["aux_dim"], fill, dtype=np.float32)

    ds = SkeletonDataset(test, kp, conf, offsets, aux_map, targets)
    dl = DataLoader(ds, batch_size=64, shuffle=False, collate_fn=lambda b: collate(b, targets))

    probs, ys = {t: [] for t in targets}, {t: [] for t in targets}
    uid_order = []
    for x, mask, lengths, aux, y, w, uid in dl:
        out = predict(x, mask, lengths, aux)
        for t in targets:
            probs[t].append(out[t].numpy())
            ys[t].append(y[t].numpy())
        uid_order.extend(uid)
    by_uid = {s["uid"]: s for s in test}

    purpose = "отложенная оценка с зафиксированным порогом" if args.split == "test" else "диагностическая оценка, часть CV"
    print(f"\n=== {args.split}: {purpose} ===")
    from sklearn.metrics import average_precision_score, precision_score, recall_score, roc_auc_score, f1_score, confusion_matrix
    results = {}
    for t in targets:
        p, y = np.concatenate(probs[t]), np.concatenate(ys[t])
        known = y >= 0
        p, y = p[known], y[known]
        n_pos, n_neg = int(y.sum()), int((1 - y).sum())
        thr = operating_point.get(t, {}).get("threshold", 0.5)
        pred = (p >= thr).astype(int)
        line = f"  {t}: n={len(y)}, положительных={n_pos}"
        result = {"n": len(y), "n_pos": n_pos, "threshold": thr, "auc": None, "ap": None}
        if n_pos >= 2 and n_neg >= 2:
            auc, ap = roc_auc_score(y, p), average_precision_score(y, p)
            line += f" | AUC {auc:.3f}, AP {ap:.3f}"
            result.update(auc=float(auc), ap=float(ap))
        else:
            line += " | AUC/AP: недостаточно примеров для оценки"
        if len(y):
            prec = precision_score(y, pred, zero_division=0)
            rec = recall_score(y, pred, zero_division=0)
            f1 = f1_score(y, pred, zero_division=0)
            line += f" | при сохранённом пороге {thr:.3f}: точность {prec:.0%}, полнота {rec:.0%}, F1 {f1:.3f}"
            tn, fp, fn, tp = confusion_matrix(y, pred, labels=[0, 1]).ravel()
            result.update(precision=float(prec), recall=float(rec), f1=float(f1),
                          tn=int(tn), fp=int(fp), fn=int(fn), tp=int(tp))
        results[t] = result
        print(line)
        if args.by_facing:
            uid_known = [u for u, k in zip(uid_order, known) if k]
            facing = np.array([by_uid[u]["facing"] for u in uid_known])
            for fv in ("front", "back"):
                m = facing == fv
                if m.sum() < 5 or y[m].sum() < 2:
                    print(f"      {fv}: маловато примеров ({int(m.sum())}) для отдельной оценки")
                    continue
                a = roc_auc_score(y[m], p[m]) if y[m].sum() >= 2 and (1 - y[m]).sum() >= 2 else None
                pr = (p[m] >= thr).astype(int)
                print(f"      {fv}: n={int(m.sum())}, положительных={int(y[m].sum())}"
                      + (f", AUC {a:.3f}" if a is not None else "")
                      + f", точность {precision_score(y[m], pr, zero_division=0):.0%}, "
                        f"полнота {recall_score(y[m], pr, zero_division=0):.0%}")
    print("\nЭту оценку менять/пересчитывать под лучший результат нельзя — иначе test станет ещё одним val.")
    report_path = model_path.parent / f"evaluation_{args.split}.json"
    report_path.write_text(json.dumps({"model": str(model_path), "split": args.split,
                                      "n_groups": len({s["group"] for s in test}),
                                      "training_overlap_checked": bool(trained_uids or trained_groups),
                                      "targets": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Сохранён отчёт: {report_path}")

    if args.dump_predictions:
        out_csv = model_path.parent / f"predictions_{args.split}.csv"
        rows = []
        for i, u in enumerate(uid_order):
            s = by_uid[u]
            row = {"rep_id": s["rep_id"], "video_id": s["video_id"], "facing": s["facing"],
                  "start": s.get("start", ""), "end": s.get("end", "")}
            rows.append(row)
        # плоские массивы вероятностей/меток в исходном порядке (без фильтра known — чтобы строки
        # совпадали 1:1 с uid_order; -1 останется -1 и в probs он тоже посчитан, просто неинформативен)
        flat_p = {t: np.concatenate(probs[t]) for t in targets}
        flat_y = {t: np.concatenate(ys[t]) for t in targets}
        for i, row in enumerate(rows):
            for t in targets:
                thr = operating_point.get(t, {}).get("threshold", 0.5)
                y_i, p_i = int(flat_y[t][i]), float(flat_p[t][i])
                row[f"{t}_true"] = y_i
                row[f"{t}_prob"] = round(p_i, 3)
                row[f"{t}_pred"] = int(p_i >= thr) if y_i != -1 else ""
                row[f"{t}_correct"] = int((p_i >= thr) == bool(y_i)) if y_i != -1 else ""
        with open(out_csv, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        n_wrong = sum(1 for r in rows for t in targets if r.get(f"{t}_correct") == 0)
        print(f"\nТаблица по повторениям: {out_csv} ({len(rows)} строк, {n_wrong} ошибок модели по всем классам).\n"
              f"Отфильтруй по *_correct==0, найди video_id в <pool>/videos/ или <own>/videos/ и вырежь "
              f"[start-0.5, end+0.5] секунд, например:\n"
              f"  ffmpeg -ss <start-0.5> -i <pool>/videos/<video_id>.mp4 -t <end-start+1> -c copy clip.mp4")


if __name__ == "__main__":
    main()
