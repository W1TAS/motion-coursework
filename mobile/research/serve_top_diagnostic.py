"""Serve a local diagnostic, app assets and fixed frames; freeze each run once."""
import argparse
import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
from urllib.parse import urlsplit

ROOT=Path(__file__).resolve().parents[2]

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--out',type=Path,required=True)
    p.add_argument('--frames',type=Path,required=True)
    p.add_argument('--port',type=int,default=8775)
    args=p.parse_args();args.out.mkdir(parents=True,exist_ok=False)
    sources=['mobile/app/pose-stream.mjs','mobile/app/pose-worker.mjs','mobile/app/pullup-top.mjs','mobile/app/pullup-phases.mjs','mobile/app/pullup-engine.mjs','mobile/app/pullup-bottom.mjs','mobile/app/pullup-rules.mjs','mobile/app/pose-face.mjs','mobile/research/baseline-pose-stream-0.1.14.mjs','mobile/research/top-runtime-diagnostic.mjs','mobile/research/top-runtime-diagnostic.html','mobile/research/serve_top_diagnostic.py']
    hashes={}
    for name in sources:
        src=ROOT/name;dst=args.out/'sources'/name;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dst);hashes[name]=hashlib.sha256(src.read_bytes()).hexdigest()
    (args.out/'protocol.json').write_text(json.dumps(dict(sources=hashes,testUsed=False,fitting=False,scope='Live repetitions and fixed-image timestamp isolation; development diagnosis, not accuracy evaluation.'),indent=2)+'\n')
    class Handler(BaseHTTPRequestHandler):
        def reply(self,code,data=b'',mime='text/plain'):
            self.send_response(code);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
        def do_GET(self):
            path=urlsplit(self.path).path
            if path in ('/','/diagnostic.html'):file=ROOT/'mobile/research/top-runtime-diagnostic.html';allowed=file.parent
            elif path=='/diagnostic.mjs':file=ROOT/'mobile/research/top-runtime-diagnostic.mjs';allowed=file.parent
            elif path=='/baseline-pose-stream.mjs':file=ROOT/'mobile/research/baseline-pose-stream-0.1.14.mjs';allowed=file.parent
            elif path.startswith('/app/'):file=ROOT/'mobile'/path.lstrip('/');allowed=ROOT/'mobile/app'
            elif path.startswith('/frames/'):file=args.frames/path.removeprefix('/frames/');allowed=args.frames
            else:self.reply(404);return
            if not file.resolve().is_relative_to(allowed.resolve()) or not file.is_file():self.reply(404);return
            mime={'.html':'text/html; charset=utf-8','.mjs':'text/javascript','.js':'text/javascript','.wasm':'application/wasm','.json':'application/json','.mp4':'video/mp4','.png':'image/png'}.get(file.suffix,'application/octet-stream')
            self.reply(200,file.read_bytes(),mime)
        def do_POST(self):
            length=int(self.headers.get('Content-Length','0'))
            if self.path!='/runs' or not 0<length<10_000_000:self.reply(400);return
            data=self.rfile.read(length);run=json.loads(data);name=run['id']
            if not name.replace('-','').isalnum():self.reply(400);return
            dest=args.out/(name+'.json')
            try:
                with dest.open('xb') as f:f.write(data)
            except FileExistsError:self.reply(409);return
            self.reply(201,b'Saved')
    print(f'Diagnostic http://127.0.0.1:{args.port}/',flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()

if __name__=='__main__':main()
