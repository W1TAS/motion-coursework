"""Serve exact ZIP entry names; unlike SimpleHTTPServer, never normalize slashes."""
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit,unquote
import zipfile,mimetypes,re
ROOT=Path(__file__).resolve().parents[1]
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  kind,_,entry=unquote(urlsplit(self.path).path).lstrip('/').partition('/')
  apk=Path('/tmp/cp-mobile-0.1.apk') if kind=='old' else ROOT/'downloads/motion-prototype.apk'
  try:
   with zipfile.ZipFile(apk) as z:data=z.read(entry)
  except (OSError,KeyError,zipfile.BadZipFile):self.send_error(404);return
  mime='text/javascript' if entry.endswith(('.js','.mjs')) else 'application/wasm' if entry.endswith('.wasm') else mimetypes.guess_type(entry)[0] or 'application/octet-stream'
  total=len(data);status=200;content_range=None
  if mime=='video/mp4' and self.headers.get('Range'):
   match=re.fullmatch(r'bytes=(\d+)-(\d*)',self.headers['Range'])
   if match:
    start=int(match[1]);end=min(total-1,int(match[2])) if match[2] else total-1
    if start>=total or end<start:self.send_error(416);return
    data=data[start:end+1];status=206;content_range=f'bytes {start}-{end}/{total}'
  self.send_response(status);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(data)));self.send_header('X-Content-Type-Options','nosniff')
  if mime=='video/mp4':self.send_header('Accept-Ranges','bytes')
  if content_range:self.send_header('Content-Range',content_range)
  self.end_headers();self.wfile.write(data)
 def log_message(self,*args):pass
if __name__=='__main__':ThreadingHTTPServer(('127.0.0.1',8771),Handler).serve_forever()
