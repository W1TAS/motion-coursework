#!/usr/bin/env python3
"""Обучает классификатор ошибок подтягиваний на последовательностях ключевых точек.

Запуск:
    python train.py --dataset dataset                                   # только скелет
    python train.py --dataset dataset --pool data --own mine            # + признаки из reps.csv
    python train.py --dataset dataset --targets partial,swing           # без asym (мало данных)

Архитектура: почему так.
  Данных мало (сотни положительных примеров на класс), поэтому модель должна быть маленькой и сильно
  регуляризованной, а не глубокой. Двунаправленный GRU читает последовательность точек и учит движение
  (нужно для раскачки, которую по одному кадру не увидеть), маскированные mean+max пулинги по времени
  сжимают её в вектор фиксированной длины (max ловит короткий момент вроде провала таза, mean — общий
  паттерн). Результат можно склеить (--pool/--own) с уже проверенными вручную признаками из
  rep_features.py (elb_bot, thigh_rr и т.д.) — они одни давали AUC 0.84-0.86 по каналам, так что учат
  сеть в правильную сторону, когда сырых данных не хватает. Это гибрид, а не readout поверх готовых
  признаков: обе ветви участвуют в общей голове классификатора.

Оценка: K-fold по каналам (колонка fold из build_dataset.py). Один фиксированный train/val/test на
~15-20 каналах с raскачкой был бы шумным (см. обсуждение); K-fold использует каждый канал ровно один раз
как валидацию и даёт среднее ± разброс по фолдам. Эпоха выбирается по этой же валидации,
поэтому окончательный результат оценивается на независимом test. Свои записи (fold=-1)
участвуют в обучении только при split=train; отложенные свои сессии исключены.

Метки -1 (неизвестно: обрезанные ноги для swing, слабая asym) исключаются из функции потерь и метрик
для этого класса, но не выбрасывают повторение целиком — оно участвует в остальных классах.

Результат:
    <out>/cv_report.json      метрики по фолдам и в среднем
    <out>/model_final.pt      модель на данных разработки или ансамбль (test исключён)
"""
import argparse
import csv
import json
import sys
import warnings
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.nn.utils.rnn import pack_padded_sequence, pad_packed_sequence
from torch.utils.data import DataLoader, Dataset

ALL_TARGETS = ["partial", "swing", "asym"]
AUX_FEATS = ["rise", "rise_rel", "nose_top", "elb_bot", "elb_top", "tilt_dev_abs", "elb_diff",
             "elb_diff_p90", "elb_diff_top", "hip_dx_dev", "thigh_rr", "shin_rr", "torso_rr",
             "hipw_rr", "knee_ang_min", "dur_rel"]


# ----------------------------------------------------------------------------
# Данные
# ----------------------------------------------------------------------------
def load_dataset(path: Path):
    with open(path / "samples.csv", encoding="utf-8") as f:
        samples = list(csv.DictReader(f))
    d = np.load(path / "skeletons.npz")
    uid_pos = {u: i for i, u in enumerate(d["uid"])}
    for s in samples:
        s["_seg"] = uid_pos[s["uid"]]
    return samples, d["kp"], d["conf"], d["offsets"]


def load_aux(pool_dir, own_dir, feature_names=None):
    """rep_id -> вектор AUX_FEATS, отдельно для pool и own (у них разные reps.csv)."""
    out = {}
    for tag, root in (("pool", pool_dir), ("own", own_dir)):
        if root is None:
            continue
        p = Path(root) / "reps.csv"
        if not p.exists():
            print(f"[!] {p} не найден, признаки из него не используются")
            continue
        with open(p, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                vec = []
                for k in (feature_names if feature_names is not None else AUX_FEATS):
                    try:
                        vec.append(float(r[k]))
                    except (KeyError, ValueError):
                        vec.append(np.nan)
                values = np.array(vec, dtype=np.float32)
                values[~np.isfinite(values)] = np.nan
                out[f"{tag}:{r['rep_id']}"] = values
    return out


class SkeletonDataset(Dataset):
    """Кадры (T,17,2) -> признаки (T, 34 позиция + 17 conf + 34 скорость) = 85 на кадр."""

    def __init__(self, samples, kp, conf, offsets, aux_map, targets):
        self.samples, self.kp, self.conf, self.offsets = samples, kp, conf, offsets
        self.aux_map, self.targets = aux_map, targets

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, i):
        s = self.samples[i]
        seg = s["_seg"]
        a, b = self.offsets[seg], self.offsets[seg + 1]
        pos = self.kp[a:b].reshape(b - a, 34)
        c = self.conf[a:b]
        vel = np.zeros_like(pos)
        vel[1:] = pos[1:] - pos[:-1]
        feat = np.concatenate([pos, c, vel], axis=1).astype(np.float32)
        aux = self.aux_map.get(s["uid"]) if self.aux_map is not None else None
        y = {t: float(s[t]) for t in self.targets}
        w = float(s.get("w_group", 1.0))
        return feat, aux, y, w, s["uid"]


def collate(batch, targets):
    feats, auxs, ys, ws, uids = zip(*batch)
    lengths = torch.tensor([len(f) for f in feats], dtype=torch.long)
    T = int(lengths.max())
    B, D = len(feats), feats[0].shape[1]
    x = torch.zeros(B, T, D, dtype=torch.float32)
    mask = torch.zeros(B, T, dtype=torch.bool)
    for i, f in enumerate(feats):
        x[i, :len(f)] = torch.from_numpy(f)
        mask[i, :len(f)] = True
    aux = None
    if auxs[0] is not None:
        aux = torch.from_numpy(np.stack(auxs).astype(np.float32))
    y = {t: torch.tensor([yy[t] for yy in ys], dtype=torch.float32) for t in targets}
    w = torch.tensor(ws, dtype=torch.float32)
    return x, mask, lengths, aux, y, w, list(uids)


# ----------------------------------------------------------------------------
# Модель
# ----------------------------------------------------------------------------
class SkeletonClassifier(nn.Module):
    def __init__(self, in_dim, hidden, targets, aux_dim=0, layers=1, dropout=0.4, aux_norm=None):
        super().__init__()
        self.input_proj = nn.Sequential(nn.Linear(in_dim, hidden), nn.ReLU(), nn.Dropout(dropout))
        self.gru = nn.GRU(hidden, hidden, num_layers=layers, batch_first=True, bidirectional=True,
                          dropout=dropout if layers > 1 else 0.0)
        self.pool_dropout = nn.Dropout(dropout)
        feat_dim = 4 * hidden + aux_dim  # mean+max, bidirectional (x2), плюс признаки
        self.shared = nn.Sequential(nn.Linear(feat_dim, hidden), nn.ReLU(), nn.Dropout(dropout))
        self.heads = nn.ModuleDict({t: nn.Linear(hidden, 1) for t in targets})
        if aux_norm is not None:
            self.register_buffer("aux_med", torch.as_tensor(aux_norm[0], dtype=torch.float32))
            self.register_buffer("aux_mad", torch.as_tensor(aux_norm[1], dtype=torch.float32))

    def forward(self, x, mask, lengths, aux=None):
        h = self.input_proj(x)
        packed = pack_padded_sequence(h, lengths.cpu(), batch_first=True, enforce_sorted=False)
        out, _ = self.gru(packed)
        out, _ = pad_packed_sequence(out, batch_first=True, total_length=x.size(1))
        mf = mask.unsqueeze(-1).float()
        mean_pool = (out * mf).sum(1) / mf.sum(1).clamp(min=1)
        max_pool = out.masked_fill(~mask.unsqueeze(-1), float("-inf")).max(1).values
        max_pool = torch.nan_to_num(max_pool, neginf=0.0)
        feat = self.pool_dropout(torch.cat([mean_pool, max_pool], dim=-1))
        if aux is not None:
            if hasattr(self, "aux_med"):
                aux = torch.nan_to_num((aux - self.aux_med) / self.aux_mad, nan=0.0, posinf=0.0, neginf=0.0)
            feat = torch.cat([feat, aux], dim=-1)
        z = self.shared(feat)
        return {t: self.heads[t](z).squeeze(-1) for t in self.heads}


def masked_bce(logits, y, pos_weight, w):
    known = y >= 0
    if known.sum() == 0:
        return None
    loss = nn.functional.binary_cross_entropy_with_logits(
        logits[known], y[known], weight=w[known], pos_weight=pos_weight, reduction="none")
    return loss.mean()


# ----------------------------------------------------------------------------
# Метрики
# ----------------------------------------------------------------------------
def eval_metrics(model, loader, targets, device, return_raw=False):
    from sklearn.metrics import average_precision_score, roc_auc_score
    model.eval()
    logits_by_t, y_by_t, uid_by_t = defaultdict(list), defaultdict(list), defaultdict(list)
    with torch.no_grad():
        for x, mask, lengths, aux, y, w, uid in loader:
            out = model(x.to(device), mask.to(device), lengths, aux.to(device) if aux is not None else None)
            for t in targets:
                logits_by_t[t].append(out[t].cpu().numpy())
                y_by_t[t].append(y[t].numpy())
                uid_by_t[t].extend(uid)
    res, raw = {}, {}
    for t in targets:
        p, yy = np.concatenate(logits_by_t[t]), np.concatenate(y_by_t[t])
        known = yy >= 0
        prob = 1 / (1 + np.exp(-p))
        if return_raw:
            raw[t] = (prob[known], yy[known], [u for u, k in zip(uid_by_t[t], known) if k])
        p2, yy2 = prob[known], yy[known]
        n_pos, n_neg = int(yy2.sum()), int((1 - yy2).sum())
        if n_pos < 2 or n_neg < 2:
            res[t] = {"n": len(yy2), "n_pos": n_pos, "auc": None, "ap": None}
            continue
        res[t] = {"n": len(yy2), "n_pos": n_pos, "auc": round(float(roc_auc_score(yy2, p2)), 3),
                  "ap": round(float(average_precision_score(yy2, p2)), 3)}
    return (res, raw) if return_raw else res


def best_threshold(prob, y, min_precision=0.0):
    """Порог, максимизирующий F1 (среди порогов с точностью не ниже min_precision, если задано)."""
    from sklearn.metrics import precision_recall_curve
    if len(y) == 0 or not np.any(np.asarray(y) == 1):
        return {"threshold": 1.0, "precision": 0.0, "recall": 0.0, "f1": 0.0}
    prec, rec, thr = precision_recall_curve(y, prob)
    prec, rec = prec[:-1], rec[:-1]  # у sklearn последняя точка без порога
    f1 = 2 * prec * rec / np.maximum(prec + rec, 1e-9)
    ok = prec >= min_precision if min_precision else np.ones_like(prec, bool)
    if not ok.any():
        ok = np.ones_like(prec, bool)
    i = np.argmax(np.where(ok, f1, -1))
    return {"threshold": float(thr[i]), "precision": round(float(prec[i]), 3),
            "recall": round(float(rec[i]), 3), "f1": round(float(f1[i]), 3)}


def mean_known(vals):
    v = [x for x in vals if x is not None]
    return round(float(np.mean(v)), 3) if v else None


def training_samples(samples):
    """Данные разработки: тестовые каналы и отложенные свои сессии исключены."""
    return [s for s in samples if s["split"] != "test" and
            ((s["source"] == "pool" and int(s["fold"]) >= 0) or
             (s["source"] == "own" and s["split"] == "train"))]


def validate_splits(samples):
    """Не допускаем попадания повторений одного канала/сессии в разные части."""
    groups = defaultdict(set)
    for s in samples:
        groups[s["group"]].add((s["split"], s["source"], int(s["fold"])))
        if s["split"] == "test" and int(s["fold"]) >= 0:
            raise ValueError(f"Тестовое повторение {s['uid']} попало в CV")
    for group, parts in groups.items():
        if len(parts) != 1:
            raise ValueError(f"Группа {group} пересекает test/CV или разные фолды: {parts}")


def fit_aux_norm(samples, aux_map):
    """Нормировка обучается только на повторениях текущей обучающей части."""
    values = np.stack([aux_map.get(s["uid"], np.full(len(AUX_FEATS), np.nan)) for s in samples])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nanmedian(values, axis=0)
        mad = np.nanmedian(np.abs(values - med), axis=0)
    return np.nan_to_num(med, nan=0.0), np.maximum(np.nan_to_num(1.4826 * mad, nan=1.0), 1e-3)


# ----------------------------------------------------------------------------
def train_one(train_samples, val_samples, kp, conf, offsets, aux_map, targets, aux_dim, args, device):
    tr_ds = SkeletonDataset(train_samples, kp, conf, offsets, aux_map, targets)
    va_ds = SkeletonDataset(val_samples, kp, conf, offsets, aux_map, targets) if val_samples else None
    coll = lambda b: collate(b, targets)  # noqa: E731
    tr_dl = DataLoader(tr_ds, batch_size=args.batch_size, shuffle=True, collate_fn=coll)
    va_dl = DataLoader(va_ds, batch_size=64, shuffle=False, collate_fn=coll) if va_ds else None

    pos_weight = {}
    for t in targets:
        y = np.array([float(s[t]) for s in train_samples])
        known = y >= 0
        n_pos, n_neg = y[known].sum(), (1 - y[known]).sum()
        pos_weight[t] = torch.tensor(min(10.0, n_neg / max(n_pos, 1)), device=device)

    in_dim = 34 + 17 + 34
    norm = fit_aux_norm(train_samples, aux_map) if aux_dim else None
    model = SkeletonClassifier(in_dim, args.hidden, targets, aux_dim, args.layers, args.dropout, norm).to(device)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr, weight_decay=args.wd)

    best_state, best_score, best_epoch, bad = None, -1.0, 0, 0
    for epoch in range(1, args.epochs + 1):
        model.train()
        for x, mask, lengths, aux, y, w, _uid in tr_dl:
            x, mask, w = x.to(device), mask.to(device), w.to(device)
            aux = aux.to(device) if aux is not None else None
            out = model(x, mask, lengths, aux)
            losses = [masked_bce(out[t], y[t].to(device), pos_weight[t], w) for t in targets]
            losses = [l for l in losses if l is not None]
            if not losses:
                continue
            loss = sum(losses) / len(losses)
            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 2.0)
            opt.step()

        if va_dl is None:  # финальная модель: нет вала, обучаем фиксированное число эпох
            continue
        m = eval_metrics(model, va_dl, targets, device)
        score = mean_known([m[t][getattr(args, "selection_metric", "ap")] for t in targets])
        if score is not None and score > best_score:
            best_score, best_epoch, bad = score, epoch, 0
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
        else:
            bad += 1
            if bad >= args.patience:
                break

    if best_state is not None:
        model.load_state_dict(best_state)
    elif va_dl is not None:
        # ни разу не было валидной оценки (слишком мало примеров в этом фолде) — берём последнюю эпоху
        best_epoch = epoch
    final_metrics = eval_metrics(model, va_dl, targets, device) if va_dl else None
    return model, final_metrics, best_epoch


def run_cv(args, targets, samples, kp, conf, offsets, aux_map, aux_dim, n_folds, device, verbose=True,
          return_models=False):
    """K-fold кросс-валидация по каналам пула (свои записи всегда в обучении) + рабочая точка по
    всем OOF-предсказаниям сразу. Вынесено из main(), чтобы sweep.py мог гонять её много раз подряд
    для разных гиперпараметров, не перезагружая датасет каждый раз."""
    validate_splits(samples)
    eligible = training_samples(samples)
    own = [s for s in eligible if s["source"] == "own"]
    fold_reports, best_epochs, fold_models = [], [], []
    oof_prob = {t: [] for t in targets}
    oof_y = {t: [] for t in targets}
    # fold == -1 у pool-повторений — это split=="test" (build_dataset.py исключил их из CV,
    # чтобы test оставался честно отложенным); в train для CV они не попадают ни при каком f.
    for f in range(n_folds):
        torch.manual_seed(args.seed + f)
        np.random.seed(args.seed + f)
        val = [s for s in samples if s["source"] == "pool" and int(s["fold"]) == f]
        train = [s for s in eligible if s["source"] == "pool" and int(s["fold"]) != f] + own
        if not val:
            continue
        model_f, metrics, best_ep = train_one(train, val, kp, conf, offsets, aux_map, targets, aux_dim, args, device)
        va_dl = DataLoader(SkeletonDataset(val, kp, conf, offsets, aux_map, targets), batch_size=64,
                           shuffle=False, collate_fn=lambda b: collate(b, targets))
        _, raw = eval_metrics(model_f, va_dl, targets, device, return_raw=True)
        for t in targets:
            if t in raw:
                oof_prob[t].append(raw[t][0])
                oof_y[t].append(raw[t][1])
        if return_models:
            fold_models.append({k: v.detach().cpu().clone() for k, v in model_f.state_dict().items()})
        best_epochs.append(best_ep)
        fold_reports.append({"fold": f, "n_train": len(train), "n_val": len(val), **metrics})
        if verbose:
            print(f"фолд {f}: train {len(train)}, val {len(val)}, лучшая эпоха {best_ep} | "
                  + " | ".join(f"{t}: AUC {metrics[t]['auc']}, AP {metrics[t]['ap']} (n_pos={metrics[t]['n_pos']})"
                              for t in targets))

    # Рабочая точка (порог), подобранная по всем OOF-предсказаниям сразу (каждое повторение
    # предсказано моделью, которая его не видела) — то же самое, что порог "по умолчанию" для
    # использования модели в реальной системе, а не просто метрика ранжирования.
    operating_point = {}
    for t in targets:
        if oof_prob[t]:
            p, y = np.concatenate(oof_prob[t]), np.concatenate(oof_y[t])
            operating_point[t] = best_threshold(p, y)
            operating_point[t]["n"] = len(y)
            operating_point[t]["n_pos"] = int(y.sum())

    summary = {t: {"auc_mean": mean_known([r[t]["auc"] for r in fold_reports]),
                   "auc_std": round(float(np.std([r[t]["auc"] for r in fold_reports if r[t]["auc"] is not None])), 3)
                   if any(r[t]["auc"] is not None for r in fold_reports) else None,
                   "ap_mean": mean_known([r[t]["ap"] for r in fold_reports])} for t in targets}
    if return_models:
        return fold_reports, summary, operating_point, best_epochs, fold_models
    return fold_reports, summary, operating_point, best_epochs


def prepare_data(args, targets):
    """Загружает датасет + aux один раз. Возвращает всё, что нужно run_cv, плюс n_folds."""
    samples, kp, conf, offsets = load_dataset(Path(args.dataset))
    if args.drop_unsure:
        samples = [s for s in samples if s.get("unsure") != "1"]
    aux_map = None if args.no_aux else load_aux(args.pool, args.own)
    if aux_map is not None and not aux_map:
        print("[!] признаки из reps.csv не найдены (--pool/--own не заданы?) — обучаем только на скелете")
        aux_map = None
    for s in samples:
        for t in ALL_TARGETS:
            s[t] = -1 if s[t] == "-1" else int(s[t])
    n_folds = max(int(s["fold"]) for s in samples if s["source"] == "pool") + 1
    if n_folds < 2:
        raise ValueError("Для CV нужно минимум два фолда; пересоберите датасет с --folds >= 2")

    validate_splits(samples)
    aux_dim = 0
    if aux_map:
        aux_dim = len(AUX_FEATS)
        for s in samples:
            if s["uid"] not in aux_map:
                aux_map[s["uid"]] = np.full(aux_dim, np.nan, dtype=np.float32)
    return samples, kp, conf, offsets, aux_map, aux_dim, n_folds, None, None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default="dataset", help="папка от build_dataset.py")
    ap.add_argument("--pool", default=None, help="папка пула (для признаков из reps.csv); опционально")
    ap.add_argument("--own", default=None, help="папка своих записей (для признаков из reps.csv); опционально")
    ap.add_argument("--no-aux", action="store_true", help="не использовать признаки из reps.csv, только скелет")
    ap.add_argument("--targets", default="partial,swing", help="через запятую; asym по умолчанию исключён (мало данных)")
    ap.add_argument("--drop-unsure", action="store_true")
    ap.add_argument("--hidden", type=int, default=48)
    ap.add_argument("--layers", type=int, default=1)
    ap.add_argument("--dropout", type=float, default=0.4)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--wd", type=float, default=1e-3)
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--patience", type=int, default=12)
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--selection-metric", choices=["ap", "auc"], default="ap",
                    help="метрика выбора эпохи; AP учитывает редкость ошибок")
    ap.add_argument("--threads", type=int, default=2, help="число потоков CPU")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    ap.add_argument("--out", default=None, help="по умолчанию <dataset>/model")
    ap.add_argument("--ensemble", action="store_true",
                    help="сохранить K моделей фолдов (уже обученных и провалидированных в CV) вместо "
                         "одной финальной модели без валидации; на инференсе усредняются их предсказания")
    args = ap.parse_args()
    targets = [t.strip() for t in args.targets.split(",") if t.strip()]
    for t in targets:
        if t not in ALL_TARGETS:
            raise SystemExit(f"неизвестная цель: {t} (доступны {ALL_TARGETS})")

    torch.manual_seed(args.seed)
    torch.set_num_threads(args.threads)
    np.random.seed(args.seed)
    device = torch.device(args.device)
    out = Path(args.out or Path(args.dataset) / "model")
    out.mkdir(parents=True, exist_ok=True)

    samples, kp, conf, offsets, aux_map, aux_dim, n_folds, med, mad = prepare_data(args, targets)
    print(f"Повторений: {len(samples)} | фолдов: {n_folds} | цели: {targets} | признаки reps.csv: "
          f"{'да' if aux_map else 'нет'}")
    for t in targets:
        print(f"  {t}: положительных {sum(s[t] == 1 for s in samples)}, "
              f"отрицательных {sum(s[t] == 0 for s in samples)}, неизвестных {sum(s[t] == -1 for s in samples)}")

    cv_out = run_cv(args, targets, samples, kp, conf, offsets, aux_map, aux_dim, n_folds, device,
                    verbose=True, return_models=args.ensemble)
    if args.ensemble:
        fold_reports, summary, operating_point, best_epochs, fold_models = cv_out
    else:
        fold_reports, summary, operating_point, best_epochs = cv_out

    print("\n=== Итог CV по каналам (для выбора модели; окончательная оценка — test) ===")
    for t in targets:
        print(f"  {t}: AUC {summary[t]['auc_mean']} ± {summary[t]['auc_std']}, AP {summary[t]['ap_mean']}"
              f"  (0.5 AUC / ~доля положительных AP = не лучше случайного)")

    print("\n=== Рабочая точка по всем OOF-предсказаниям (порог для реального использования) ===")
    for t in targets:
        if t in operating_point:
            o = operating_point[t]
            print(f"  {t}: порог {o['threshold']} -> точность {o['precision']:.0%}, полнота {o['recall']:.0%}, "
                  f"F1 {o['f1']:.2f} (на {o['n']} повторениях, {o['n_pos']} положительных)")

    (out / "cv_report.json").write_text(json.dumps({"folds": fold_reports, "summary": summary,
                                                     "operating_point": operating_point,
                                                     "targets": targets, "args": vars(args)},
                                                    ensure_ascii=False, indent=1, default=str), encoding="utf-8")

    # --- финальная модель ---
    if args.ensemble:
        # Модели фолдов уже обучены и провалидированы во время CV — дополнительное обучение не нужно.
        # Каждая не видела свой фолд, поэтому усреднение их предсказаний на НОВЫХ данных даёт меньше
        # шума, чем одна модель, обученная вслепую на фиксированное число эпох без валидации.
        torch.save({"ensemble": fold_models, "targets": targets, "hidden": args.hidden,
                   "layers": args.layers, "dropout": args.dropout, "aux_dim": aux_dim,
                   "aux_feats": AUX_FEATS if aux_dim else None,
                   "aux_preprocessing": "model", "aux_norm": None,
                   "train_uids": [s["uid"] for s in training_samples(samples)],
                   "train_groups": sorted({s["group"] for s in training_samples(samples)}),
                   "operating_point": operating_point},
                  out / "model_final.pt")
        print(f"Сохранён ансамбль из {len(fold_models)} моделей фолдов (без доп. обучения).")
    else:
        all_samples = training_samples(samples)
        final_epochs = int(np.median(best_epochs)) if best_epochs else args.epochs
        print(f"\nОбучаю финальную модель на всех {len(all_samples)} повторениях, {final_epochs} эпох...")
        model, _, _ = train_one(all_samples, None, kp, conf, offsets, aux_map, targets, aux_dim,
                                argparse.Namespace(**{**vars(args), "epochs": final_epochs}), device)
        torch.save({"state_dict": model.state_dict(), "targets": targets, "hidden": args.hidden,
                   "layers": args.layers, "dropout": args.dropout, "aux_dim": aux_dim,
                   "aux_feats": AUX_FEATS if aux_dim else None,
                   "aux_preprocessing": "model", "aux_norm": None,
                   "train_uids": [s["uid"] for s in all_samples],
                   "train_groups": sorted({s["group"] for s in all_samples}),
                   "operating_point": operating_point},
                  out / "model_final.pt")
    print(f"Сохранено: {out / 'cv_report.json'}, {out / 'model_final.pt'}")


def load_ensemble(path, device="cpu"):
    """Грузит model_final.pt (ансамбль или одна модель) и возвращает функцию predict(x, mask, lengths,
    aux) -> dict[target] -> вероятность (усреднённая по моделям ансамбля, если он есть)."""
    ckpt = torch.load(path, map_location=device, weights_only=False)
    if ckpt.get("model_type") == "features":
        from feature_model import load_feature_predictor
        return load_feature_predictor(ckpt)
    targets, aux_dim = ckpt["targets"], ckpt["aux_dim"]
    in_dim = 34 + 17 + 34
    state_dicts = ckpt["ensemble"] if "ensemble" in ckpt else [ckpt["state_dict"]]
    models = []
    for sd in state_dicts:
        norm = (sd["aux_med"], sd["aux_mad"]) if "aux_med" in sd else None
        m = SkeletonClassifier(in_dim, ckpt["hidden"], targets, aux_dim, ckpt["layers"], ckpt["dropout"], norm).to(device)
        m.load_state_dict(sd)
        m.eval()
        models.append(m)

    def predict(x, mask, lengths, aux=None):
        with torch.no_grad():
            probs = {t: [] for t in targets}
            for m in models:
                out = m(x.to(device), mask.to(device), lengths, aux.to(device) if aux is not None else None)
                for t in targets:
                    probs[t].append(torch.sigmoid(out[t]).cpu())
            return {t: torch.stack(probs[t]).mean(0) for t in targets}

    return predict, targets, ckpt.get("operating_point", {})


if __name__ == "__main__":
    main()
