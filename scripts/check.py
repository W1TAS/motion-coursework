#!/usr/bin/env python3
"""Check source-only logic; optionally verify locally restored runtime assets."""
import argparse
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets', action='store_true', help='Also verify local MediaPipe assets')
    args = parser.parse_args()
    node = shutil.which('node')
    if not node:
        raise SystemExit('Нужен Node.js для проверок JavaScript.')
    if args.assets:
        subprocess.run([sys.executable, 'scripts/setup_assets.py', '--check'], cwd=ROOT, check=True)
    tests = sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'mobile/tests').glob('*.test.mjs'))
    tests += sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'pullups').glob('test_*review*.cjs'))
    if not tests:
        raise SystemExit('Не найдены проверки JavaScript.')
    subprocess.run([node, '--test', *tests], cwd=ROOT, check=True)
    for pattern in ('test_criterion_reviews.py', 'test_ascent_windows.py'):
        subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'pullups', '-p', pattern],
                       cwd=ROOT, check=True)
    print('Основные проверки пройдены.', flush=True)


if __name__ == '__main__':
    main()
