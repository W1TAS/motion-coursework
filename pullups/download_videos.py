#!/usr/bin/env python3
"""Поиск и скачивание видео подтягиваний через yt-dlp.

Примеры:
    python download_videos.py --out data --per-query 40
    python download_videos.py --out data --urls-file my_urls.txt     # свои ссылки/плейлисты
    python download_videos.py --out data --skip-search               # только докачать candidates.jsonl

Результат в папке --out:
    candidates.jsonl   все найденные кандидаты (после фильтра по длительности и лимита на канал)
    videos/<id>.mp4    видео без звука, не выше --height
    meta/<id>.json     название, канал, запросы, по которым видео нашлось (слабые метки)

Если YouTube отдаёт "Sign in to confirm you're not a bot":
    --cookies-from-browser chrome
Если что-то внезапно сломалось: pip install -U yt-dlp (YouTube часто меняется).
"""
import argparse
import json
import random
from pathlib import Path

import yt_dlp
from tqdm import tqdm

# (запрос, слабая метка). Метка ничего не гарантирует: это подсказка, что искать при разметке.
DEFAULT_QUERIES = [
    ("pull ups max reps", "general"),
    ("pull ups to failure", "general"),
    ("подтягивания максимум за подход", "general"),
    ("beginner pull ups", "beginner"),
    ("pull ups with resistance band", "beginner"),
    ("pull ups form check", "form"),
    ("pull up form check front view", "form"),
    ("ошибки в подтягиваниях", "mistakes"),
    ("half rep pull ups", "partial"),
    ("partial range pull ups mistake", "partial"),
    ("неполные подтягивания", "partial"),
    ("kipping pull ups", "swing"),
    ("butterfly pull ups", "swing"),
    ("подтягивания с раскачкой", "swing"),
    ("читинг подтягивания", "swing"),
    ("pull up no rep", "norep"),
    ("pull up test standards", "norep"),
    ("подтягивания норматив сдача", "norep"),
    ("pull ups uneven shoulders", "asym"),
    ("pull ups one side stronger", "asym"),
]


def collect(queries, urls, args):
    """Ищет кандидатов, не скачивая видео."""
    opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
        "ignoreerrors": True,
    }
    if args.cookies_from_browser:
        opts["cookiesfrombrowser"] = (args.cookies_from_browser,)

    jobs = [(f"ytsearch{args.per_query}:{q}", tag, q) for q, tag in queries]
    jobs += [(u, "url", u) for u in urls]

    cands = {}
    with yt_dlp.YoutubeDL(opts) as ydl:
        for target, tag, label in tqdm(jobs, desc="поиск"):
            try:
                info = ydl.extract_info(target, download=False)
            except Exception as e:  # noqa: BLE001
                tqdm.write(f"[!] {label}: {e}")
                continue
            if not info:
                continue
            for e in info.get("entries") or [info]:
                if not e or not e.get("id"):
                    continue
                dur = e.get("duration")
                if dur is None:
                    if tag != "url":  # для результатов поиска без длительности не рискуем
                        continue
                elif not (args.min_dur <= dur <= args.max_dur):
                    continue
                vid = e["id"]
                c = cands.setdefault(vid, {
                    "id": vid,
                    "url": e.get("webpage_url") or e.get("url")
                           or f"https://www.youtube.com/watch?v={vid}",
                    "title": e.get("title"),
                    "channel": e.get("channel") or e.get("uploader"),
                    "channel_id": e.get("channel_id") or e.get("uploader_id"),
                    "duration": dur,
                    "queries": [],
                    "tags": [],
                })
                if label not in c["queries"]:
                    c["queries"].append(label)
                if tag not in c["tags"]:
                    c["tags"].append(tag)

    # Лимит на канал: чтобы один человек не занял весь датасет.
    per_channel, result = {}, []
    for c in cands.values():
        key = c["channel_id"] or c["channel"] or c["id"]
        per_channel[key] = per_channel.get(key, 0) + 1
        if per_channel[key] <= args.max_per_channel:
            result.append(c)
    if args.max_videos:
        # Перемешиваем, иначе обрезка берёт только видео первых запросов из списка.
        random.Random(0).shuffle(result)
        result = result[: args.max_videos]
    return result


def video_files(vdir: Path, vid: str):
    return [p for p in vdir.glob(f"{vid}.*") if p.suffix not in (".part", ".ytdl")]


def download(cands, out: Path, args):
    vdir, mdir = out / "videos", out / "meta"
    vdir.mkdir(parents=True, exist_ok=True)
    mdir.mkdir(parents=True, exist_ok=True)

    h = args.height
    # H.264 в приоритете: OpenCV не всегда умеет декодировать AV1.
    fmt = (f"bv*[height<={h}][vcodec^=avc1]/bv*[height<={h}][ext=mp4]"
           f"/bv*[height<={h}]/b[height<={h}]")
    opts = {
        "format": fmt,
        "outtmpl": str(vdir / "%(id)s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "retries": 3,
        "sleep_interval": args.sleep,
        "max_sleep_interval": args.sleep * 2,
    }
    if args.cookies_from_browser:
        opts["cookiesfrombrowser"] = (args.cookies_from_browser,)

    ok = fail = 0
    with yt_dlp.YoutubeDL(opts) as ydl:
        for c in tqdm(cands, desc="скачивание"):
            if not video_files(vdir, c["id"]):
                try:
                    ydl.download([c["url"]])
                except Exception as e:  # noqa: BLE001
                    tqdm.write(f"[!] {c['id']}: {e}")
            if video_files(vdir, c["id"]):
                (mdir / f"{c['id']}.json").write_text(
                    json.dumps(c, ensure_ascii=False, indent=1), encoding="utf-8")
                ok += 1
            else:
                fail += 1
    print(f"Готово: {ok} видео на диске, {fail} не скачалось.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="data")
    ap.add_argument("--queries-file", help="txt: одна строка = 'запрос' или 'запрос|метка'")
    ap.add_argument("--urls-file", help="txt со ссылками на видео/плейлисты, по одной в строке")
    ap.add_argument("--skip-search", action="store_true", help="взять готовый candidates.jsonl")
    ap.add_argument("--per-query", type=int, default=40, help="сколько результатов брать на запрос")
    ap.add_argument("--min-dur", type=int, default=15, help="мин. длительность, с")
    ap.add_argument("--max-dur", type=int, default=900, help="макс. длительность, с")
    ap.add_argument("--max-per-channel", type=int, default=5)
    ap.add_argument("--max-videos", type=int, default=0, help="0 = без лимита")
    ap.add_argument("--height", type=int, default=720, help="макс. высота видео")
    ap.add_argument("--sleep", type=int, default=1, help="пауза между скачиваниями, с")
    ap.add_argument("--cookies-from-browser", default=None, help="chrome / firefox / edge ...")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    cfile = out / "candidates.jsonl"

    if args.skip_search:
        cands = [json.loads(l) for l in cfile.read_text(encoding="utf-8").splitlines() if l.strip()]
    else:
        queries = DEFAULT_QUERIES
        if args.queries_file:
            queries = []
            for line in Path(args.queries_file).read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line:
                    q, _, tag = line.partition("|")
                    queries.append((q.strip(), tag.strip() or "custom"))
        urls = []
        if args.urls_file:
            urls = [l.strip() for l in Path(args.urls_file).read_text(encoding="utf-8").splitlines()
                    if l.strip() and not l.startswith("#")]
        cands = collect(queries, urls, args)
        with open(cfile, "w", encoding="utf-8") as f:
            for c in cands:
                f.write(json.dumps(c, ensure_ascii=False) + "\n")
        print(f"Кандидатов: {len(cands)} (список в {cfile})")

    download(cands, out, args)


if __name__ == "__main__":
    main()
