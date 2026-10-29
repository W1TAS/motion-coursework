#!/usr/bin/env python3
"""Локальный инструмент разметки повторений (открывается в браузере).

Запуск:
    python label_tool.py --data mine --queue time            # свои записи, по порядку времени
    python label_tool.py --data data                         # пул: смесь очереди по приоритету и случайных
    python label_tool.py --data data --split test --queue random   # тест: только случайная выборка
    python label_tool.py --data data --report                # только отчёт, без сервера
    python label_tool.py --data data --make-proxies          # H.264-копии (если видео не играет в браузере)

Читает <data>/reps.csv (из rep_features.py), видео из <data>/videos (или <data>/proxies),
скелеты из <data>/kps. Пишет:
    <data>/labels.jsonl       журнал: одна строка на действие (последняя запись по rep_id побеждает)
    <data>/label_report.json  сводка о ходе разметки (пришли её мне вместе с labels.jsonl)

Клавиши (работают в любой раскладке):
    1 / 2 / 3   неполная амплитуда / раскачка / асимметрия. Нажатие по кругу: нет > слабо > явно > нет
    0           правильное повторение (снимает ошибки)
    X           это не повторение или скелет явно сломан (не участвует в обучении)
    U           не уверен (флаг, можно сочетать с любой меткой)
    Enter       сохранить и перейти дальше     P  взять метки предыдущего сохранённого повторения
    N или →     пропустить (записывается как skip)   Backspace или ←   назад
    R           повтор с начала     Пробел  пауза     [ ]  медленнее / быстрее
    S           скелет вкл/выкл     Z  приближение к человеку     I  статистика     /  заметка (Esc выйти)
    V V         (дважды) весь ролик не годится (таймлапс, не подтягивания): остальные его повторения пропускаются

Приоритеты и теги по умолчанию НЕ показываются, чтобы не подталкивать оценку.
Флаг --show-hints их показывает. В журнал они пишутся всегда.
"""
import argparse
import csv
import json
import os
import random
import re
import signal
import subprocess
import threading
import uuid
from collections import Counter
from datetime import datetime
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
from scipy.stats import rankdata

ERR = ["partial", "swing", "asym"]
PAD = 0.5  # запас вокруг повторения при показе, с
MIME = {".mp4": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska",
        ".mov": "video/quicktime", ".avi": "video/x-msvideo"}


# ----------------------------------------------------------------------------
# Данные
# ----------------------------------------------------------------------------
def load_reps(data: Path):
    rows = []
    with open(data / "reps.csv", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            for k in ("start", "end", "top", "duration", "priority", "priority_partial",
                      "priority_asym", "priority_swing"):
                v = r.get(k)
                r[k] = None if v in (None, "", "nan") else float(v)
            r["usable"] = r.get("usable") == "1"
            r["segment_idx"], r["rep_idx"] = int(r["segment_idx"]), int(r["rep_idx"])
            rows.append(r)
    pb, d = data / "p_bad.csv", {}
    if pb.exists():
        with open(pb, encoding="utf-8") as f:
            d = {r["rep_id"]: float(r["p_bad"]) for r in csv.DictReader(f)}
    for r in rows:
        r["p_bad"] = d.get(r["rep_id"])
    return rows


def select_pool(rows, args):
    split = args.split
    if split == "auto":
        split = "own" if any(r["split"] == "own" for r in rows) else "train"
    pool = [r for r in rows if split == "all" or r["split"] == split]
    if not args.include_unusable:
        pool = [r for r in pool if r["usable"]]
    if args.max_pbad < 1:  # p_bad.csv делает bad_filter.py; без него фильтра нет
        pool = [r for r in pool if r["p_bad"] is None or r["p_bad"] < args.max_pbad]
    return pool, split


def score(r):
    return r["priority"] * (1 - (r["p_bad"] or 0.0))


def build_queue(pool, args):
    """[(rep, source)]. source: time / rand / prio. Случайная часть выбирается заранее и
    независимо от приоритета, поэтому по ней можно честно оценить базовую частоту ошибок."""
    rng = random.Random(args.seed)
    if getattr(args, "queue_file", None):
        by_id = {r["rep_id"]: r for r in pool}
        selected, used = [], set()
        with Path(args.queue_file).open(encoding="utf-8", newline="") as f:
            for entry in csv.DictReader(f):
                rid = entry["rep_id"]
                if rid in by_id and rid not in used:
                    selected.append((by_id[rid], "curated"))
                    used.add(rid)
        return selected
    if args.queue == "time":
        return [(r, "time") for r in sorted(pool, key=lambda r: (r["video_id"], r["segment_idx"], r["rep_idx"]))]
    rand = pool[:]
    rng.shuffle(rand)
    if args.queue == "random":
        return [(r, "rand") for r in rand]
    with_p = sorted([r for r in pool if r["priority"] is not None], key=lambda r: -score(r))
    if args.queue == "priority":
        return [(r, "prio") for r in with_p]
    n_r = max(1, len(pool) // args.mix)
    rand_part = rand[:n_r]
    ids = {r["rep_id"] for r in rand_part}
    rest = [r for r in pool if r["rep_id"] not in ids]
    prio = sorted([r for r in rest if r["priority"] is not None], key=lambda r: -score(r)) \
        + [r for r in rest if r["priority"] is None]
    out, pi, ri = [], 0, 0
    while pi < len(prio) or ri < len(rand_part):
        if (len(out) + 1) % args.mix == 0 and ri < len(rand_part):
            out.append((rand_part[ri], "rand")); ri += 1
        elif pi < len(prio):
            out.append((prio[pi], "prio")); pi += 1
        else:
            out.append((rand_part[ri], "rand")); ri += 1
    return out


def read_records(path: Path):
    recs = []
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    recs.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return recs


def banned_videos(records):
    """Видео, помеченные клавишей V («весь ролик не годится»). Остальные повторения из них в очередь не попадают."""
    return {r["video_id"] for r in records if r.get("action") == "ban_video" and r.get("video_id")}


def last_labels(records):
    d = {}
    for r in records:
        if r.get("action") == "label":
            d[r["rep_id"]] = r
    return d


# ----------------------------------------------------------------------------
# Отчёт
# ----------------------------------------------------------------------------
def auc(scores, pos):
    scores, pos = np.asarray(scores, float), np.asarray(pos, bool)
    n1, n0 = int(pos.sum()), int((~pos).sum())
    if n1 < 3 or n0 < 3:
        return None
    ranks = rankdata(scores)
    return round(float((ranks[pos].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)), 3)


def compute_report(rows, records):
    by_id = {r["rep_id"]: r for r in rows}
    last = last_labels(records)
    labeled = [r for r in last.values() if r["rep_id"] in by_id]
    n_skip = len({r["rep_id"] for r in records if r.get("action") == "skip"} - set(last))
    rep = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "reps_in_csv": len(rows), "n_labeled": len(labeled), "n_skipped_unlabeled": n_skip,
        "n_clean": sum(bool(r["clean"]) for r in labeled),
        "n_bad": sum(bool(r["bad"]) for r in labeled),
        "n_unsure": sum(bool(r["unsure"]) for r in labeled),
    }
    rep["banned_videos"] = sorted(banned_videos(records))
    bins = [(0.0, 0.3), (0.3, 0.5), (0.5, 0.7), (0.7, 1.01)]
    xb = {}
    for lo, hi in bins:
        g = [r for r in labeled if r.get("p_bad") is not None and lo <= r["p_bad"] < hi]
        if g:
            xb[f"{lo:.1f}-{min(hi, 1.0):.1f}"] = {"n": len(g), "x_rate": round(float(np.mean([bool(r["bad"]) for r in g])), 3)}
    rep["x_rate_by_p_bad"] = xb
    rep["labels"] = {e: {"any": sum(e in r["labels"] for r in labeled),
                         "weak": sum(r["labels"].get(e) == 1 for r in labeled),
                         "strong": sum(r["labels"].get(e) == 2 for r in labeled)} for e in ERR}
    rep["combinations"] = dict(Counter("+".join(sorted(r["labels"])) or ("clean" if r["clean"] else "bad")
                                       for r in labeled))
    rep["by_split"] = dict(Counter(by_id[r["rep_id"]]["split"] for r in labeled))

    # Частоты по источнику очереди: rand даёт несмещённую оценку базовой частоты ошибок
    by_src = {}
    for src in sorted({r.get("source") for r in labeled}):
        g = [r for r in labeled if r.get("source") == src]
        by_src[str(src)] = {"n": len(g), "clean": round(np.mean([bool(r["clean"]) for r in g]), 3),
                            "bad": round(np.mean([bool(r["bad"]) for r in g]), 3),
                            "unsure": round(np.mean([bool(r["unsure"]) for r in g]), 3),
                            **{e: round(np.mean([e in r["labels"] for r in g]), 3) for e in ERR}}
    rep["rate_by_source"] = by_src

    # Насколько приоритеты согласуются с метками (AUC ~0.5 = ранжирование бесполезно)
    good = [r for r in labeled if not r["bad"] and by_id[r["rep_id"]]["usable"]]
    a_all, a_rand = {}, {}
    for e in ERR:
        for name, subset, out in (("all", good, a_all), ("rand_only", [r for r in good if r.get("source") == "rand"], a_rand)):
            sc = [by_id[r["rep_id"]].get(f"priority_{e}") for r in subset]
            keep = [i for i, s in enumerate(sc) if s is not None]
            out[e] = auc([sc[i] for i in keep], [e in subset[i]["labels"] for i in keep]) if keep else None
    rep["priority_auc_all_labeled"] = a_all
    rep["priority_auc_random_only"] = a_rand

    # Время и сессии
    acts = [r for r in records if r.get("action") == "label" and r.get("t_spent") is not None]
    if acts:
        ts = np.array([r["t_spent"] for r in acts], float)
        rep["seconds_per_rep"] = {"median": round(float(np.median(ts)), 1), "p90": round(float(np.percentile(ts, 90)), 1),
                                  "mean_loops": round(float(np.mean([r.get("loops", 0) for r in acts])), 1)}
    sess = {}
    for r in records:
        s = sess.setdefault(r.get("session", "?"), {"n": 0, "first": r.get("saved_at"), "last": r.get("saved_at")})
        s["n"] += 1
        s["last"] = r.get("saved_at")
    rep["sessions"] = sess
    fc = {}
    for f in ("front", "back"):
        g = [r for r in good if by_id[r["rep_id"]].get("facing") == f]
        if g:
            fc[f] = {"n": len(g), **{e: round(np.mean([e in r["labels"] for r in g]), 3) for e in ERR}}
    rep["rate_by_facing"] = fc
    return rep


# ----------------------------------------------------------------------------
# Сервер
# ----------------------------------------------------------------------------
def collection_worker_running(job):
    try:
        argv = (Path('/proc') / str(int(job['pid'])) / 'cmdline').read_bytes().split(b'\0')
        return [x.decode() for x in argv if x] == job['argv']
    except (OSError, ValueError, KeyError, UnicodeError):
        return False


def collection_status(data):
    try:
        job = json.loads((data / 'bulk_collection_job.json').read_text())
        state = json.loads((data / 'run_state.json').read_text())
    except (OSError, ValueError):
        return None
    collection = state.get('collection') or {}
    active = collection_worker_running(job)
    return {'active': active, 'target_clips': job.get('target_clips'),
            'pending_clips': collection.get('pending_clips', 0),
            'status': 'running' if active else collection.get('status', 'stopped'),
            'stop_reason': collection.get('stop_reason')}


def stop_collection(data):
    try:
        job = json.loads((data / 'bulk_collection_job.json').read_text())
        pid = int(job['pid'])
    except (OSError, ValueError, KeyError, TypeError):
        return 409, 'Активный сбор не найден'
    if pid <= 1 or not collection_worker_running(job):
        return 200, 'Сбор уже остановлен'
    try:
        # Прерываем только проверенный сборщик. Его обработчик сохраняет
        # состояние; дочерней записи CSV даём завершиться без повреждения.
        os.kill(pid, signal.SIGINT)
    except ProcessLookupError:
        return 200, 'Сбор уже остановлен'
    except PermissionError:
        return 403, 'Не удалось остановить сбор'
    return 200, 'Сбор останавливается. Сохранённые видео и метки останутся.'


class App:
    def __init__(self, args):
        self.args = args
        self.data = Path(args.data)
        self.rows = load_reps(self.data)
        self.by_id = {r["rep_id"]: r for r in self.rows}
        self.label_path = self.data / "labels.jsonl"
        self.lock = threading.Lock()
        self.session = uuid.uuid4().hex[:8]
        pool, self.split = select_pool(self.rows, args)
        self.queue = build_queue(pool, args)

    def find_video(self, vid):
        if not re.fullmatch(r"[\w\-. ]+", vid):
            return None
        p = self.data / "proxies" / f"{vid}.mp4"
        if p.exists():
            return p
        for q in (self.data / "videos").glob(f"{vid}.*"):
            if q.suffix not in (".part", ".ytdl"):
                return q
        return None

    def queue_json(self):
        # Сборщик может добавить источники, пока просмотрщик остаётся открытым.
        if getattr(self.args, 'queue_file', None):
            with self.lock:
                self.rows = load_reps(self.data)
                self.by_id = {r['rep_id']: r for r in self.rows}
                pool, self.split = select_pool(self.rows, self.args)
                self.queue = build_queue(pool, self.args)
        recs = read_records(self.label_path)
        labels = {k: {"labels": v["labels"], "clean": v["clean"], "bad": v["bad"],
                      "unsure": v["unsure"], "note": v.get("note", "")} for k, v in last_labels(recs).items()}
        items, banned = [], banned_videos(recs)
        batch_size = getattr(self.args, "batch_size", 0)
        seen = {r.get("rep_id") for r in recs if r.get("action") in ("label", "skip")}
        for r, src in self.queue:
            if batch_size and r["rep_id"] in seen:
                continue
            if r["video_id"] in banned and r["rep_id"] not in labels:
                continue
            it = {"rep_id": r["rep_id"], "video_id": r["video_id"], "start": r["start"], "end": r["end"],
                  "top": r["top"], "source": src}
            if self.args.show_hints:
                it["hint"] = {"tags": r.get("tags"), "facing": r.get("facing"), "split": r.get("split"),
                              "priority": r["priority"], "partial": r["priority_partial"],
                              "asym": r["priority_asym"], "swing": r["priority_swing"]}
            items.append(it)
            if batch_size and len(items) >= batch_size:
                break
        return {"items": items, "labels": labels, "session": self.session,
                "hints": self.args.show_hints, "split": self.split, "pad": PAD, "batch_size": batch_size,
                "collection": collection_status(self.data)}

    def save_label(self, body):
        row = self.by_id.get(body.get("rep_id"))
        if row is None:
            return 400, "неизвестный rep_id"
        action = body.get("action", "label")
        if action == "ban_video":
            rec = {"action": "ban_video", "video_id": row["video_id"], "rep_id": row["rep_id"],
                   "session": self.session, "saved_at": datetime.now().isoformat(timespec="seconds")}
            with self.lock:
                with open(self.label_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            return 200, "ok"
        labels = {k: int(v) for k, v in (body.get("labels") or {}).items() if k in ERR and int(v) in (1, 2)}
        clean, bad = bool(body.get("clean")), bool(body.get("bad"))
        if action == "label":
            if clean and (labels or bad):
                return 400, "clean несовместим с ошибками и bad"
            if not (clean or bad or labels):
                return 400, "нет метки"
        rec = {
            "rep_id": row["rep_id"], "action": action, "labels": labels, "clean": clean, "bad": bad,
            "unsure": bool(body.get("unsure")), "note": str(body.get("note", ""))[:300],
            "source": body.get("source"), "queue_pos": body.get("queue_pos"),
            "t_spent": body.get("t_spent"), "loops": body.get("loops"), "speed": body.get("speed"),
            "skeleton": body.get("skeleton"), "zoom": body.get("zoom"),
            "session": self.session, "saved_at": datetime.now().isoformat(timespec="seconds"),
            "video_id": row["video_id"], "start": row["start"], "end": row["end"], "split": row.get("split"),
            "tags": row.get("tags"), "facing": row.get("facing"), "p_bad": row.get("p_bad"),
            "priority": {"all": row["priority"], "partial": row["priority_partial"],
                         "asym": row["priority_asym"], "swing": row["priority_swing"]},
        }
        with self.lock:
            with open(self.label_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return 200, "ok"

    def kps_json(self, rep_id):
        row = self.by_id.get(rep_id)
        if row is None:
            return None
        f = self.data / "kps" / f'{row["video_id"]}_{row["segment_idx"]}.npz'
        if not f.exists():
            return None
        d = load_npz(str(f))
        t = d["t"]
        m = (t >= row["start"] - PAD - 0.1) & (t <= row["end"] + PAD + 0.1)
        kp, cf = d["kp"][m], d["conf"][m]
        bad = ~np.isfinite(kp).all(axis=2)
        kp = np.where(np.isfinite(kp), kp, -1.0)
        cf = np.where(bad, 0.0, cf)
        return {"t": np.round(t[m], 3).tolist(), "kp": np.round(kp, 1).tolist(),
                "conf": np.round(cf, 2).tolist(), "wh": [float(d["wh"][0]), float(d["wh"][1])]}


@lru_cache(maxsize=6)
def load_npz(path):
    d = np.load(path)
    return {k: d[k] for k in ("t", "kp", "conf", "wh")}


def make_handler(app: App):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body, ctype="application/json; charset=utf-8"):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, ensure_ascii=False)
            if isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _file(self, path: Path):
            size = path.stat().st_size
            start, end, code = 0, size - 1, 200
            m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range") or "")
            if m:
                s, e = m.groups()
                if s == "" and e != "":
                    start = max(0, size - int(e))
                else:
                    start = int(s) if s else 0
                    end = min(int(e), size - 1) if e else size - 1
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.end_headers()
                    return
                code = 206
            self.send_response(code)
            self.send_header("Content-Type", MIME.get(path.suffix.lower(), "application/octet-stream"))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(end - start + 1))
            if code == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            try:
                with open(path, "rb") as f:
                    f.seek(start)
                    left = end - start + 1
                    while left > 0:
                        chunk = f.read(min(1 << 16, left))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass  # браузер часто обрывает range-запросы, это нормально

        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            if u.path == "/":
                self._send(200, HTML, "text/html; charset=utf-8")
            elif u.path == "/api/queue":
                self._send(200, app.queue_json())
            elif u.path == "/api/kps":
                k = app.kps_json((q.get("rep_id") or [""])[0])
                self._send(200 if k else 404, k or {"error": "нет скелета"})
            elif u.path == "/api/stats":
                self._send(200, compute_report(app.rows, read_records(app.label_path)))
            elif u.path == "/api/collection":
                self._send(200, collection_status(app.data) or {'active': False})
            elif u.path.startswith("/video/"):
                from urllib.parse import unquote
                p = app.find_video(unquote(u.path[len("/video/"):]))
                if p is None:
                    self._send(404, {"error": "видео не найдено"})
                else:
                    self._file(p)
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            if urlparse(self.path).path == '/api/collection/stop':
                code, msg = stop_collection(app.data)
                self._send(code, {'message': msg})
                return
            if urlparse(self.path).path != "/api/label":
                self._send(404, {"error": "not found"})
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                code, msg = app.save_label(body)
            except (ValueError, TypeError) as e:
                code, msg = 400, f"плохой запрос: {e}"
            self._send(code, {"message": msg} if code == 200 else msg, "application/json; charset=utf-8" if code == 200 else "text/plain; charset=utf-8")
    return H


def make_proxies(data: Path, rows):
    out = data / "proxies"
    out.mkdir(exist_ok=True)
    ids = sorted({r["video_id"] for r in rows})
    for vid in ids:
        dst = out / f"{vid}.mp4"
        srcs = [p for p in (data / "videos").glob(f"{vid}.*") if p.suffix not in (".part", ".ytdl")]
        if dst.exists() or not srcs:
            continue
        print("кодирую", vid)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(srcs[0]), "-an",
                        "-vf", "scale=-2:'min(720,ih)'", "-c:v", "libx264", "-preset", "veryfast",
                        "-crf", "23", "-movflags", "+faststart", str(dst)], check=True)
    print("Готово:", out)


HTML = r"""<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Разметка повторений</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#141414;color:#ddd;font:14px system-ui,sans-serif;display:flex;height:100vh;overflow:hidden}
#left{flex:1;display:flex;flex-direction:column;min-width:0}
#viewport{flex:1;position:relative;overflow:hidden;background:#000;display:flex;align-items:center;justify-content:center}
#wrap{position:relative;flex:none}
#wrap video,#wrap canvas{position:absolute;left:0;top:0;width:100%;height:100%}
#tl{height:26px;position:relative;background:#222;margin:6px 10px}
#tl .rep{position:absolute;top:0;bottom:0;background:#2b5;opacity:.35}
#tl .top{position:absolute;top:0;bottom:0;width:2px;background:#5f8}
#tl .cur{position:absolute;top:0;bottom:0;width:2px;background:#fff}
#side{width:330px;padding:12px;background:#1c1c1c;overflow:auto;display:flex;flex-direction:column;gap:10px}
.chip{display:flex;justify-content:space-between;padding:9px 10px;border:1px solid #444;border-radius:6px;cursor:pointer;background:#222}
.chip.s1{background:#5b4a12;border-color:#c9a227}.chip.s2{background:#7a2b1f;border-color:#e8553a}
.chip.on{background:#1d5a33;border-color:#3c6}.chip.badon{background:#444;border-color:#999}
.small{font-size:12px;color:#999}.k{color:#fff;font-weight:600}
#flash{position:absolute;top:8px;left:50%;transform:translateX(-50%);background:#a33;color:#fff;padding:6px 12px;border-radius:6px;display:none;z-index:5}
#stats{position:absolute;inset:20px;background:#000d;padding:16px;overflow:auto;display:none;z-index:6;white-space:pre-wrap;font:12px monospace}
#emptymsg{display:none;position:absolute;max-width:520px;padding:24px;text-align:center;color:#ccc;line-height:1.6;font-size:18px}
input{width:100%;background:#111;color:#ddd;border:1px solid #444;padding:6px;border-radius:4px}
button{background:#2a6;color:#fff;border:0;padding:10px;border-radius:6px;font-size:14px;cursor:pointer}
#stopcollection{background:#85342f}button:disabled{opacity:.6;cursor:default}
</style></head><body>
<div id="left"><div id="viewport"><div id="wrap"><video id="v" muted playsinline preload="auto"></video><canvas id="c"></canvas></div>
<div id="emptymsg"></div><div id="flash"></div><div id="stats"></div></div><div id="tl"></div></div>
<div id="side">
 <div><b id="title">-</b><div class="small" id="info"></div><div class="small" id="hint"></div></div>
 <div class="small" id="prog"></div>
 <div class="chip" id="chip_partial" onclick="cycle('partial')"><span><span class="k">1</span> Неполная амплитуда</span><b></b></div>
 <div class="chip" id="chip_swing" onclick="cycle('swing')"><span><span class="k">2</span> Раскачка</span><b></b></div>
 <div class="chip" id="chip_asym" onclick="cycle('asym')"><span><span class="k">3</span> Асимметрия</span><b></b></div>
 <div class="chip" id="chip_clean" onclick="toggle('clean')"><span><span class="k">0</span> Правильно</span><b></b></div>
 <div class="chip" id="chip_bad" onclick="toggle('bad')"><span><span class="k">X</span> Не повторение / скелет сломан</span><b></b></div>
 <div class="chip" id="chip_unsure" onclick="toggle('unsure')"><span><span class="k">U</span> Не уверен</span><b></b></div>
 <input id="note" placeholder="заметка ( / )" maxlength="300">
 <button onclick="saveNext()">Сохранить и дальше (Enter)</button>
 <button id="nextbatch" style="display:none" onclick="init()">Следующая небольшая партия</button>
 <div class="small">N пропустить · Backspace назад · P метки как у предыдущего · R повтор · Пробел пауза<br>
 [ ] скорость · S скелет · Z приближение · V,V пропустить весь ролик · I статистика · Слабо = 1 нажатие, явно = 2 нажатия</div>
 <div class="small" id="speedinfo"></div>
 <div class="small" id="collectioninfo"></div>
 <button id="stopcollection" style="display:none" onclick="stopCollection()">Остановить сбор</button>
</div>
<script>
const $=id=>document.getElementById(id), vid=$('v'), cv=$('c'), ctx=cv.getContext?cv.getContext('2d'):null;
const ERR=['partial','swing','asym'];
const EDGES=[[5,6],[5,7],[7,9],[6,8],[8,10],[5,11],[6,12],[11,12],[11,13],[13,15],[12,14],[14,16],[0,1],[0,2],[1,3],[2,4]];
const LEFT=new Set([1,3,5,7,9,11,13,15]), RIGHT=new Set([2,4,6,8,10,12,14,16]);
let runX={}, banArm=0;
let batchSize=0, drawStarted=false, queueRefreshTimer=null;
let Q=[], L={}, pos=0, cur=null, K=null, st=empty(), t0=0, loops=0, speed=1, showSk=true, zoomOn=false, sess='', PAD=0.5, hints=false, lastSaved=null;
function empty(){return {labels:{},clean:false,bad:false,unsure:false};}
function flash(m){const f=$('flash');f.textContent=m;f.style.display='block';clearTimeout(f._t);f._t=setTimeout(()=>f.style.display='none',2500);}
function inRange(i){return i>=0&&i<Q.length;}
function firstUnlabeled(){for(let i=0;i<Q.length;i++)if(!L[Q[i].rep_id])return i;return -1;}
async function init(){
  clearTimeout(queueRefreshTimer); queueRefreshTimer=null;
  const r=await fetch('/api/queue'); const d=await r.json();
  Q=d.items; L=d.labels; sess=d.session; PAD=d.pad; hints=d.hints;
  $('stopcollection').style.display=d.collection&&d.collection.active?'block':'none';
  if(!$('stopcollection').disabled)$('collectioninfo').textContent=d.collection&&d.collection.active?'Сбор видео идёт в фоне':'';
  batchSize=d.batch_size||0; $('nextbatch').style.display='none';$('nextbatch').textContent='Следующая небольшая партия';
  if(!Q.length){
    cur=null; K=null;vid.pause();$('wrap').style.visibility='hidden';$('tl').innerHTML='';
    $('info').textContent='';$('hint').textContent='';$('emptymsg').style.display='block';
    const running=d.collection&&d.collection.active;
    $('title').textContent=running?'Новые клипы готовятся':'Новых клипов пока нет';
    $('prog').textContent=running?'Сбор и обработка продолжаются':'Подготовленная очередь закончилась';
    $('emptymsg').textContent=running?'Просмотренные клипы сохранены. Новые видео ещё проходят загрузку и фильтрацию. Следующая партия появится здесь автоматически.':'Все подготовленные клипы просмотрены. Можно проверить появление новой партии.';
    $('nextbatch').style.display='block';$('nextbatch').textContent='Проверить новые клипы';
    if(running)queueRefreshTimer=setTimeout(()=>init().catch(()=>{queueRefreshTimer=setTimeout(init,15000);}),15000);
    return;
  }
  $('wrap').style.visibility='visible';$('emptymsg').style.display='none';
  let i=firstUnlabeled(); if(i<0){i=0;flash('Всё размечено. Можно пересматривать назад.');}
  show(i); if(!drawStarted){drawStarted=true;draw();}
}
async function stopCollection(){
  const button=$('stopcollection');button.disabled=true;button.textContent='Останавливается…';
  try{
    const r=await fetch('/api/collection/stop',{method:'POST'});const d=await r.json();
    if(!r.ok)throw new Error(d.message||'Не удалось остановить сбор');
    $('collectioninfo').textContent=d.message;
    const check=async()=>{
      try{const response=await fetch('/api/collection');const status=await response.json();
        if(status.active){setTimeout(check,2000);return;}
        button.style.display='none';button.disabled=false;button.textContent='Остановить сбор';
        $('collectioninfo').textContent='Сбор остановлен. Сохранённые клипы доступны для разметки.';
        if(!cur)init();
      }catch(e){setTimeout(check,5000);}
    };check();
  }catch(e){button.disabled=false;button.textContent='Остановить сбор';flash(e.message);}
}
function show(i){
  pos=i; cur=Q[i]; K=null; loops=0; t0=Date.now();
  const prev=L[cur.rep_id];
  st=prev?{labels:{...prev.labels},clean:!!prev.clean,bad:!!prev.bad,unsure:!!prev.unsure}:empty();
  $('note').value=prev?(prev.note||''):'';
  if(vid.dataset.id!==cur.video_id){vid.src='/video/'+encodeURIComponent(cur.video_id);vid.dataset.id=cur.video_id;}
  seekStart(); vid.playbackRate=speed; const p=vid.play(); if(p&&p.catch)p.catch(()=>{});
  $('title').textContent=cur.rep_id;
  $('info').textContent=cur.video_id+'  '+cur.start.toFixed(1)+'–'+cur.end.toFixed(1)+' с';
  $('hint').textContent=hints&&cur.hint?('подсказки: '+JSON.stringify(cur.hint)):'';
  const nl=Object.keys(L).length;
  $('prog').textContent=(i+1)+' / '+Q.length+'  ·  размечено '+nl+'  ·  очередь: '+cur.source;
  renderChips(); renderTimeline();
  fetch('/api/kps?rep_id='+encodeURIComponent(cur.rep_id)).then(r=>r.ok?r.json():null).then(k=>{
    if(cur&&Q[pos]===cur){K=k; layout();}
  }).catch(()=>{});
}
function seekStart(){
  const go=()=>{vid.currentTime=Math.max(0,cur.start-PAD);};
  if(vid.readyState>=1)go(); else vid.addEventListener('loadedmetadata',()=>{go();layout();},{once:true});
}
function renderTimeline(){
  const tl=$('tl'), a=cur.start-PAD, b=cur.end+PAD, w=b-a;
  tl.innerHTML='<div class="rep" style="left:'+(PAD/w*100)+'%;width:'+((cur.end-cur.start)/w*100)+'%"></div>'
   +'<div class="top" style="left:'+((cur.top-a)/w*100)+'%"></div><div class="cur" id="curmark"></div>';
}
function renderChips(){
  for(const e of ERR){const c=$('chip_'+e), s=st.labels[e]||0; c.className='chip'+(s?' s'+s:''); c.lastChild.textContent=s==1?'слабо':s==2?'явно':'';}
  $('chip_clean').className='chip'+(st.clean?' on':''); $('chip_clean').lastChild.textContent=st.clean?'да':'';
  $('chip_bad').className='chip'+(st.bad?' badon':''); $('chip_bad').lastChild.textContent=st.bad?'да':'';
  $('chip_unsure').className='chip'+(st.unsure?' badon':''); $('chip_unsure').lastChild.textContent=st.unsure?'да':'';
  $('speedinfo').textContent='скорость ×'+speed+' · скелет '+(showSk?'вкл':'выкл')+' · приближение '+(zoomOn?'вкл':'выкл');
}
function cycle(e){st.labels[e]=((st.labels[e]||0)+1)%3; if(!st.labels[e])delete st.labels[e]; else{st.clean=false;st.bad=false;} renderChips();}
function toggle(k){
  st[k]=!st[k];
  if(k==='clean'&&st.clean){st.labels={};st.bad=false;}
  if(k==='bad'&&st.bad){st.labels={};st.clean=false;}
  renderChips();
}
function layout(){
  const vp=$('viewport'), W=vp.clientWidth, H=vp.clientHeight;
  let a=(K&&K.wh)?K.wh[0]/K.wh[1]:(vid.videoWidth?vid.videoWidth/vid.videoHeight:16/9);
  let w=W, h=W/a; if(h>H){h=H;w=H*a;}
  const wr=$('wrap'); wr.style.width=w+'px'; wr.style.height=h+'px';
  if(K&&K.wh){cv.width=K.wh[0]; cv.height=K.wh[1];}
  let tr='none', org='50% 50%';
  if(zoomOn&&K&&K.kp.length){
    const xs=[],ys=[];
    for(let i=0;i<K.kp.length;i+=3)for(let j=0;j<17;j++)if(K.conf[i][j]>0.3){xs.push(K.kp[i][j][0]);ys.push(K.kp[i][j][1]);}
    if(xs.length>10){
      xs.sort((p,q)=>p-q);ys.sort((p,q)=>p-q);
      const q=(arr,f)=>arr[Math.floor(f*(arr.length-1))];
      const cx=(q(xs,.05)+q(xs,.95))/2/K.wh[0], cy=(q(ys,.05)+q(ys,.95))/2/K.wh[1];
      const hf=Math.max(0.08,(q(ys,.95)-q(ys,.05))/K.wh[1]);
      const z=Math.min(4,Math.max(1,0.8/hf));
      if(z>1.1){org=(cx*100)+'% '+(cy*100)+'%'; tr='translate('+((0.5-cx)*w)+'px,'+((0.5-cy)*h)+'px) scale('+z+')';}
    }
  }
  wr.style.transformOrigin=org; wr.style.transform=tr;
}
function frameAt(t){
  if(!K||!K.t.length)return -1;
  let lo=0,hi=K.t.length-1;
  while(lo<hi){const m=(lo+hi)>>1; if(K.t[m]<t)lo=m+1; else hi=m;}
  if(lo>0&&Math.abs(K.t[lo-1]-t)<Math.abs(K.t[lo]-t))lo--;
  return Math.abs(K.t[lo]-t)<0.12?lo:-1;
}
function draw(){
  requestAnimationFrame(draw);
  if(!cur)return;
  const t=vid.currentTime;
  if(t>cur.end+PAD){loops++; vid.currentTime=Math.max(0,cur.start-PAD);}
  const cm=$('curmark'); if(cm){const a=cur.start-PAD,w=cur.end-cur.start+2*PAD; cm.style.left=Math.min(100,Math.max(0,(t-a)/w*100))+'%';}
  if(!ctx||!K)return;
  ctx.clearRect(0,0,cv.width,cv.height);
  if(!showSk)return;
  const i=frameAt(t); if(i<0)return;
  const kp=K.kp[i], cf=K.conf[i]; ctx.lineWidth=Math.max(2,cv.width/320);
  for(const [a,b] of EDGES){
    if(cf[a]<0.3||cf[b]<0.3)continue;
    ctx.strokeStyle=(LEFT.has(a)&&LEFT.has(b))?'#4cf':(RIGHT.has(a)&&RIGHT.has(b))?'#fa3':'#ddd';
    ctx.beginPath(); ctx.moveTo(kp[a][0],kp[a][1]); ctx.lineTo(kp[b][0],kp[b][1]); ctx.stroke();
  }
  for(let j=0;j<17;j++){if(cf[j]<0.3)continue; ctx.fillStyle=LEFT.has(j)?'#4cf':RIGHT.has(j)?'#fa3':'#fff';
    ctx.beginPath(); ctx.arc(kp[j][0],kp[j][1],ctx.lineWidth*1.3,0,7); ctx.fill();}
}
async function save(action){
  if(!cur)return false;
  if(action==='label'&&!(st.clean||st.bad||Object.keys(st.labels).length)){flash('Выбери метку: 0 = правильно, 1/2/3 = ошибка, X = не повторение');return false;}
  const body={rep_id:cur.rep_id,action,labels:st.labels,clean:st.clean,bad:st.bad,unsure:st.unsure,note:$('note').value,
    source:cur.source,queue_pos:pos,t_spent:Math.min(120,(Date.now()-t0)/1000),loops,speed,skeleton:showSk,zoom:zoomOn};
  const r=await fetch('/api/label',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok){flash('Ошибка сохранения: '+await r.text());return false;}
  if(action==='label'){
    runX[cur.video_id]=st.bad?(runX[cur.video_id]||0)+1:0;
    if(runX[cur.video_id]===3)flash('3 брака подряд в этом ролике. V — пропустить весь ролик');
    L[cur.rep_id]={labels:{...st.labels},clean:st.clean,bad:st.bad,unsure:st.unsure,note:body.note};
    lastSaved={labels:{...st.labels},clean:st.clean,bad:st.bad};}
  return true;
}
async function saveNext(){
  if(!await save('label'))return;
  let i=-1; for(let j=pos+1;j<Q.length;j++)if(!L[Q[j].rep_id]){i=j;break;}
  if(i<0&&pos+1<Q.length)i=pos+1;
  if(i<0){flash(batchSize?'Партия готова. Можно остановиться или открыть следующую.':'Конец очереди. Отчёт: клавиша I');if(batchSize)$('nextbatch').style.display='block';show(pos);return;}
  show(i);
}
async function banVideo(){
  const now=Date.now();
  if(now-banArm>2500){banArm=now;flash('Пропустить весь ролик? Нажми V ещё раз');return;}
  banArm=0;
  const v=cur.video_id, idx=pos;
  const r=await fetch('/api/label',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rep_id:cur.rep_id,action:'ban_video'})});
  if(!r.ok){flash('Ошибка: '+await r.text());return;}
  Q=Q.filter(it=>it.video_id!==v||L[it.rep_id]);
  let i=-1; for(let j=Math.min(idx,Q.length-1);j>=0&&j<Q.length;j++)if(!L[Q[j].rep_id]){i=j;break;}
  if(i<0){for(let j=0;j<Q.length;j++)if(!L[Q[j].rep_id]){i=j;break;}}
  if(i<0){flash('Очередь закончилась');if(batchSize)$('nextbatch').style.display='block';return;}
  flash('Ролик пропущен'); show(i);
}
async function skip(){if(!await save('skip'))return; if(pos+1<Q.length)show(pos+1); else {flash('Партия закончилась');if(batchSize)$('nextbatch').style.display='block';}}
async function showStats(){
  const s=$('stats'); if(s.style.display==='block'){s.style.display='none';return;}
  s.textContent='загрузка…'; s.style.display='block';
  try{const r=await fetch('/api/stats'); s.textContent=JSON.stringify(await r.json(),null,2);}
  catch(e){s.textContent='не удалось получить статистику: '+e;}
}
document.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT'){if(e.code==='Escape'||e.code==='Enter')e.target.blur();return;}
  if(e.ctrlKey||e.metaKey||e.altKey||!cur)return;
  const c=e.code; let h=true;
  if(c==='Digit1'||c==='Numpad1')cycle('partial');
  else if(c==='Digit2'||c==='Numpad2')cycle('swing');
  else if(c==='Digit3'||c==='Numpad3')cycle('asym');
  else if(c==='Digit0'||c==='Numpad0')toggle('clean');
  else if(c==='KeyX')toggle('bad');
  else if(c==='KeyU')toggle('unsure');
  else if(c==='Enter'||c==='NumpadEnter')saveNext();
  else if(c==='KeyN'||c==='ArrowRight')skip();
  else if(c==='Backspace'||c==='ArrowLeft'){if(inRange(pos-1))show(pos-1);}
  else if(c==='KeyP'){if(lastSaved){st={labels:{...lastSaved.labels},clean:lastSaved.clean,bad:lastSaved.bad,unsure:st.unsure};renderChips();}}
  else if(c==='KeyR'){seekStart();vid.play();}
  else if(c==='Space'){vid.paused?vid.play():vid.pause();}
  else if(c==='BracketLeft'){speed=Math.max(0.25,+(speed-0.25).toFixed(2));vid.playbackRate=speed;renderChips();}
  else if(c==='BracketRight'){speed=Math.min(2,+(speed+0.25).toFixed(2));vid.playbackRate=speed;renderChips();}
  else if(c==='KeyS'){showSk=!showSk;renderChips();}
  else if(c==='KeyZ'){zoomOn=!zoomOn;layout();renderChips();}
  else if(c==='KeyV')banVideo();
  else if(c==='KeyI')showStats();
  else if(c==='Slash'){$('note').focus();}
  else h=false;
  if(h)e.preventDefault();
});
window.addEventListener('resize',layout);
vid.addEventListener('loadedmetadata',layout);
vid.addEventListener('error',()=>flash('Видео не воспроизводится в браузере. Запусти: label_tool.py --make-proxies'));
init();
</script></body></html>
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="data")
    ap.add_argument("--queue", choices=["mixed", "priority", "random", "time"], default="mixed")
    ap.add_argument("--queue-file", type=Path, help="готовая очередь из acquire_data.py; вероятности не показываются")
    ap.add_argument("--batch-size", type=int, default=0, help="небольшие партии новых клипов; 0 — полная очередь")
    ap.add_argument("--split", default="auto", help="train / test / own / all / auto (own, если есть, иначе train)")
    ap.add_argument("--mix", type=int, default=3, help="в очереди mixed каждое N-е повторение случайное")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--include-unusable", action="store_true")
    ap.add_argument("--max-pbad", type=float, default=0.7,
                    help="исключить повторения с p_bad >= порога (нужен p_bad.csv от bad_filter.py; 1 = не фильтровать)")
    ap.add_argument("--show-hints", action="store_true", help="показывать теги и приоритеты (смещает оценку!)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--report", action="store_true", help="только отчёт")
    ap.add_argument("--make-proxies", action="store_true")
    args = ap.parse_args()
    if args.batch_size < 0:
        ap.error("Размер партии не может быть отрицательным")

    data = Path(args.data)
    if args.make_proxies:
        make_proxies(data, load_reps(data))
        return
    app = App(args)
    if args.report:
        rep = compute_report(app.rows, read_records(app.label_path))
        (data / "label_report.json").write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
        print(json.dumps(rep, ensure_ascii=False, indent=1))
        return
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(app))
    print(f"Повторений в очереди: {len(app.queue)} (split={app.split}, queue={args.queue}).")
    print(f"Открой в браузере: http://127.0.0.1:{args.port}   (остановить: Ctrl+C)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        rep = compute_report(app.rows, read_records(app.label_path))
        (data / "label_report.json").write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\nОтчёт сохранён: {data / 'label_report.json'}")


if __name__ == "__main__":
    main()
