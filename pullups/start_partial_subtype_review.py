"""Start the prepared annotation viewer on localhost; do not rebuild its data."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen
import webbrowser

ROOT = Path(__file__).resolve().parent
DIRECTORY = ROOT / 'dataset_mediapipe_gpu/human-reviews/expanded-3d/review'
URL = 'http://127.0.0.1:8772/partial-subtypes/index.html'
PAGES = {'partial-subtypes': 'Подтягивания — один ответ 1–5', 'top-proxy': 'Перепроверка верхней точки'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--page', choices=PAGES, default='partial-subtypes')
    args = parser.parse_args()
    url = f'http://127.0.0.1:8772/{args.page}/index.html'
    if not (DIRECTORY / args.page / 'index.html').is_file():
        raise SystemExit('Подготовленная разметка не найдена. Пакет нужно восстановить из архива.')
    try:
        with urlopen(url, timeout=2) as response:
            already_running = PAGES[args.page] in response.read(1024).decode('utf-8')
    except (URLError, TimeoutError, UnicodeError):
        already_running = False
    if already_running:
        print(f'Просмотрщик уже работает: {url}', flush=True)
        if not args.no_browser:
            webbrowser.open(url)
        return
    handler = partial(SimpleHTTPRequestHandler, directory=str(DIRECTORY))
    try:
        server = ThreadingHTTPServer(('127.0.0.1', 8772), handler)
    except OSError as error:
        raise SystemExit(f'Не удалось запустить просмотрщик на порту 8772: {error}') from error
    print(f'Разметка: {url}\nОставьте это окно открытым. Остановка: Ctrl+C.', flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
