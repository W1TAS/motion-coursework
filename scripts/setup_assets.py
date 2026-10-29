#!/usr/bin/env python3
"""Restore pinned public MediaPipe runtime assets; never download project data."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / 'mobile/app/vendor'


def download(url):
    request = Request(url, headers={'User-Agent': 'MotionCoursework/asset-setup'})
    with urlopen(request, timeout=45) as response:
        data = response.read(64 * 1024 * 1024 + 1)
    if len(data) > 64 * 1024 * 1024:
        raise ValueError('Размер зависимости превышает 64 МиБ')
    return data


def install(relative, data, expected):
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f'Неверная контрольная сумма: {relative}')
    path = VENDOR / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Verify only; no network or file changes')
    args = parser.parse_args()
    dependencies = json.loads((VENDOR / 'DEPENDENCIES.json').read_text())
    missing = []
    for relative, expected in dependencies['sha256'].items():
        path = VENDOR / relative
        if not path.is_file():
            missing.append(relative)
        elif hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise SystemExit(f'Файл изменён, автоматическая замена отменена: {relative}')
    if missing and args.check:
        raise SystemExit('Нет зависимостей: ' + ', '.join(missing) + '. Запустите python scripts/setup_assets.py')
    package_files = [p for p in missing if p != 'pose_landmarker_lite.task']
    if package_files:
        package = download(dependencies['package_url'])
        with tarfile.open(fileobj=io.BytesIO(package), mode='r:gz') as archive:
            for relative in package_files:
                names = [f'package/{relative}']
                if relative == 'LICENSE-mediapipe.txt':
                    names += ['package/LICENSE', 'package/LICENSE.txt']
                members = {m.name: m for m in archive.getmembers() if m.isfile()}
                member = next((members[n] for n in names if n in members), None)
                if member is None:
                    raise ValueError(f'В пакете не найден файл: {relative}')
                with archive.extractfile(member) as stream:
                    install(relative, stream.read(), dependencies['sha256'][relative])
    if 'pose_landmarker_lite.task' in missing:
        install('pose_landmarker_lite.task', download(dependencies['model_url']),
                dependencies['sha256']['pose_landmarker_lite.task'])
    print('MediaPipe: все пять файлов доступны, контрольные суммы совпадают.')


if __name__ == '__main__':
    main()
