#!/usr/bin/env python3
"""Read-only preview and APK download. Does not expose coursework datasets."""
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit
import argparse,re,xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parent
VERSION=ET.parse(ROOT/'android/AndroidManifest.xml').getroot().get('{http://schemas.android.com/apk/res/android}versionName')
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*a,**kw):super().__init__(*a,directory=str(ROOT/'app'),**kw)
 def list_directory(self,path):self.send_error(404);return None
 def video(self,head=False):
  path=Path(self.translate_path(self.path))
  if path.suffix!='.mp4' or not path.is_file():return False
  length=path.stat().st_size;start=0;end=length-1;status=200
  requested=self.headers.get('Range')
  if requested:
   match=re.fullmatch(r'bytes=(\d*)-(\d*)',requested)
   if not match or not any(match.groups()):self.send_error(416);return True
   first,last=match.groups()
   start=int(first) if first else max(0,length-int(last))
   end=min(length-1,int(last)) if first and last else length-1
   if start>=length or end<start:self.send_error(416);return True
   status=206
  self.send_response(status);self.send_header('Content-Type','video/mp4');self.send_header('Accept-Ranges','bytes');self.send_header('Content-Length',str(end-start+1))
  if status==206:self.send_header('Content-Range',f'bytes {start}-{end}/{length}')
  self.end_headers()
  if not head:
   with path.open('rb') as stream:
    stream.seek(start);remaining=end-start+1
    while remaining:
     chunk=stream.read(min(65536,remaining))
     if not chunk:break
     try:self.wfile.write(chunk)
     except (BrokenPipeError,ConnectionResetError):break
     remaining-=len(chunk)
  return True
 def do_GET(self):
  if self.video():return
  path=urlsplit(self.path).path
  if path=='/install':
   b='''<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Установить «Движение»</title><style>body{font:17px/1.6 system-ui;background:#111e2c;color:#edf3f1;max-width:540px;margin:40px auto;padding:24px}a{display:block;background:#c7ee90;color:#172b26;padding:18px;border-radius:14px;text-align:center;text-decoration:none;font-weight:600}li{margin:16px 0}small{color:#a0b1bc}</style><h1>Движение · 0.1.8</h1><p>Прототип для Android 8 и новее</p><ol><li>Скачайте APK по кнопке ниже.</li><li>Откройте файл. Если Android спросит, разрешите вашему браузеру установку из этого источника.</li><li>Установите приложение и разрешите камеру при первом запуске анализа.</li></ol><a href="/download/motion-prototype.apk?v=0.1.8" download>Скачать APK · 17 МБ</a><p><small>Отжимания и планка по камере. Модель включена в APK: после установки компьютер и интернет не нужны. Это учебная сборка с собственной подписью, без публикации в Google Play. Качество подсчёта на вашем телефоне ещё предстоит проверить.</small></p></html>'''.replace('17 МБ',f"{(ROOT/'downloads/motion-prototype.apk').stat().st_size/1_000_000:.1f} МБ").encode()
   b=b.replace(b'0.1.8',VERSION.encode())
   self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b);return
  if path=='/download/motion-prototype.apk':
   apk=ROOT/'downloads/motion-prototype.apk'
   if not apk.exists():self.send_error(404);return
   self.send_response(200);self.send_header('Cache-Control','no-store');self.send_header('Content-Type','application/vnd.android.package-archive');self.send_header('Content-Disposition',f'attachment; filename="motion-prototype-{VERSION}.apk"');self.send_header('Content-Length',str(apk.stat().st_size));self.end_headers()
   with apk.open('rb') as f:
    import shutil;shutil.copyfileobj(f,self.wfile)
   return
  return super().do_GET()
 def do_HEAD(self):
  if self.video(head=True):return
  if urlsplit(self.path).path=='/download/motion-prototype.apk':
   apk=ROOT/'downloads/motion-prototype.apk'
   if not apk.exists():self.send_error(404);return
   self.send_response(200);self.send_header('Cache-Control','no-store');self.send_header('Content-Type','application/vnd.android.package-archive');self.send_header('Content-Length',str(apk.stat().st_size));self.end_headers();return
  super().do_HEAD()
 def end_headers(self):
  self.send_header('X-Content-Type-Options','nosniff');self.send_header('Cache-Control','no-store');super().end_headers()
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--host',default='127.0.0.1');p.add_argument('--port',type=int,default=8770);a=p.parse_args()
 Handler.extensions_map.update({'.mjs':'text/javascript','.wasm':'application/wasm','.task':'application/octet-stream'})
 print(f'Preview http://{a.host}:{a.port}/ ; APK /install',flush=True)
 ThreadingHTTPServer((a.host,a.port),Handler).serve_forever()
