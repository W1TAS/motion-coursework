#!/usr/bin/env python3
"""Перебирает гиперпараметры и показывает, какая конфигурация даёт лучшую рабочую точку
(precision/recall/F1), а не только AUC. Датасет и признаки грузятся один раз, дальше только обучение.

Запуск:
    python sweep.py --dataset dataset --pool data --own mine --targets partial,swing
    python sweep.py --dataset dataset --pool data --own mine --targets partial,swing --grid small   # быстрее, для проверки

По умолчанию перебирает hidden×dropout×epochs/patience×wd — 12 конфигураций. На CPU каждая занимает
примерно столько же времени, сколько один обычный запуск train.py (несколько минут на реальных
1400 повторениях), так что весь перебор — это кофе-брейк, не ночь. --grid small — 4 конфигурации,
для быстрой проверки, что всё работает, перед полным перебором.

Результат:
    <dataset>/sweep_report.json   все конфигурации с метриками, отсортированные по среднему F1
Печатает топ-5 конфигураций и команду train.py, которой ту же конфигурацию можно воспроизвести
для сохранения финальной модели (sweep не сохраняет модели — только меряет).
"""
import argparse
import json
import sys
from itertools import product
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train import ALL_TARGETS, prepare_data, run_cv  # noqa: E402

GRIDS = {
    "full": {"hidden": [24, 48, 64], "dropout": [0.3, 0.5], "epochs_patience": [(60, 12), (100, 20)],
             "wd": [1e-3]},
    "small": {"hidden": [24, 48], "dropout": [0.4], "epochs_patience": [(60, 12)], "wd": [1e-3, 3e-3]},
}


def f1_score_of(op, targets):
    vals = [op[t]["f1"] for t in targets if t in op]
    return round(float(np.mean(vals)), 3) if vals else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default="dataset")
    ap.add_argument("--pool", default=None)
    ap.add_argument("--own", default=None)
    ap.add_argument("--no-aux", action="store_true")
    ap.add_argument("--targets", default="partial,swing")
    ap.add_argument("--drop-unsure", action="store_true")
    ap.add_argument("--grid", choices=list(GRIDS), default="full")
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--layers", type=int, default=1)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--selection-metric", choices=["ap", "auc"], default="ap")
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = ap.parse_args()
    targets = [t.strip() for t in args.targets.split(",") if t.strip()]
    for t in targets:
        if t not in ALL_TARGETS:
            raise SystemExit(f"неизвестная цель: {t} (доступны {ALL_TARGETS})")

    torch.manual_seed(args.seed)
    torch.set_num_threads(args.threads)
    np.random.seed(args.seed)
    device = torch.device(args.device)

    print("Загружаю датасет...")
    samples, kp, conf, offsets, aux_map, aux_dim, n_folds, _, _ = prepare_data(args, targets)
    print(f"Повторений: {len(samples)} | фолдов: {n_folds} | признаки reps.csv: {'да' if aux_map else 'нет'}\n")

    g = GRIDS[args.grid]
    combos = list(product(g["hidden"], g["dropout"], g["epochs_patience"], g["wd"]))
    print(f"Конфигураций: {len(combos)}\n")

    results = []
    for i, (hidden, dropout, (epochs, patience), wd) in enumerate(combos, 1):
        run_args = argparse.Namespace(hidden=hidden, layers=args.layers, dropout=dropout, lr=args.lr, wd=wd,
                                      epochs=epochs, patience=patience, batch_size=args.batch_size,
                                      seed=args.seed, dataset=args.dataset, pool=args.pool, own=args.own,
                                      no_aux=args.no_aux, drop_unsure=args.drop_unsure,
                                      selection_metric=args.selection_metric)
        fold_reports, summary, operating_point, best_epochs = run_cv(
            run_args, targets, samples, kp, conf, offsets, aux_map, aux_dim, n_folds, device, verbose=False)
        f1 = f1_score_of(operating_point, targets)
        auc = round(float(np.mean([summary[t]["auc_mean"] for t in targets if summary[t]["auc_mean"] is not None])), 3)
        cfg = {"hidden": hidden, "dropout": dropout, "epochs": epochs, "patience": patience, "wd": wd}
        results.append({"config": cfg, "auc_mean": auc, "f1_mean": f1, "summary": summary,
                        "operating_point": operating_point})
        op_str = " | ".join(f"{t}: P {operating_point[t]['precision']:.0%} R {operating_point[t]['recall']:.0%}"
                            for t in targets if t in operating_point)
        print(f"[{i}/{len(combos)}] hidden={hidden} dropout={dropout} epochs/patience={epochs}/{patience} wd={wd}"
              f"  ->  AUC {auc}, F1 {f1}  ({op_str})")

    results.sort(key=lambda r: (r["f1_mean"] is None, -(r["f1_mean"] or 0)))
    out = Path(args.dataset) / "sweep_report.json"
    out.write_text(json.dumps(results, ensure_ascii=False, indent=1, default=str), encoding="utf-8")

    print(f"\n=== Топ-5 конфигураций по среднему F1 рабочей точки (сохранено в {out}) ===")
    for r in results[:5]:
        c = r["config"]
        print(f"  F1={r['f1_mean']}, AUC={r['auc_mean']} | hidden={c['hidden']} dropout={c['dropout']} "
              f"epochs={c['epochs']} patience={c['patience']} wd={c['wd']}")
    if results:
        c = results[0]["config"]
        aux_flag = ""
        if not args.no_aux:
            if args.pool:
                aux_flag += f" --pool {args.pool}"
            if args.own:
                aux_flag += f" --own {args.own}"
        print(f"\nЧтобы сохранить финальную модель с лучшей конфигурацией:\n"
              f"  python train.py --dataset {args.dataset}{aux_flag} --targets {args.targets} "
              f"--hidden {c['hidden']} --dropout {c['dropout']} --epochs {c['epochs']} "
              f"--patience {c['patience']} --wd {c['wd']} --seed {args.seed} "
              f"--selection-metric {args.selection_metric}"
              f" --lr {args.lr} --layers {args.layers} --batch-size {args.batch_size} --threads {args.threads}"
              + (" --no-aux" if args.no_aux else "")
              + (" --drop-unsure" if args.drop_unsure else ""))


if __name__ == "__main__":
    main()
