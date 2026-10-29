#!/usr/bin/env python3
"""Start the existing read-only app server for this computer and its Wi-Fi LAN."""
import socket
import subprocess
import sys
import webbrowser
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def lan_address():
    try:
        interfaces = json.loads(subprocess.check_output(['ip', '-j', '-4', 'address', 'show', 'up'], stderr=subprocess.DEVNULL))
        for interface in interfaces:
            if interface['ifname'].startswith(('wl', 'en', 'eth')):
                for address in interface.get('addr_info', []):
                    if address.get('scope') == 'global':
                        return address['local']
    except (OSError, ValueError, subprocess.CalledProcessError):
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            # UDP connect chooses an interface; no packet or user data is sent.
            s.connect(('192.0.2.1', 9))
            return s.getsockname()[0]
    except OSError:
        return 'АДРЕС-КОМПЬЮТЕРА'

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default=lan_address(), help='Wi-Fi IPv4 address of this computer')
    parser.add_argument('--open', action='store_true')
    args=parser.parse_args()
    print('На компьютере: http://127.0.0.1:8770/', flush=True)
    print(f'На телефоне в той же Wi-Fi сети: http://{args.host}:8770/', flush=True)
    print('Через Wi-Fi HTTP доступны видеопримеры; для камеры нужен HTTPS или APK.', flush=True)
    print('Оставьте это окно открытым. Остановка: Ctrl+C.', flush=True)
    if args.open:
        # Open after a short delay, once the server has bound its socket.
        import threading
        threading.Timer(1, lambda: webbrowser.open('http://127.0.0.1:8770/')).start()
    children=[]
    try:
        for host in dict.fromkeys(['127.0.0.1',args.host]):
            children.append(subprocess.Popen([sys.executable, str(ROOT/'serve.py'), '--host',host]))
        while all(c.poll() is None for c in children):
            import time
            time.sleep(.5)
    except KeyboardInterrupt:
        pass
    finally:
        for child in children:
            if child.poll() is None:child.terminate()
        for child in children:child.wait()
