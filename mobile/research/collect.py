#!/usr/bin/env python3
"""Bounded, resumable acquisition of public instructional videos (no accounts/cookies).
Saves source pages, provenance and checksums. Near-duplicate audit is separate.
"""
from pathlib import Path
import urllib.request,re,json,hashlib,html,argparse
ROOT=Path(__file__).resolve().parent
SOURCES={
 '753559':('7-foundational-movements-plank','Quinn Hurt / Marine Corps Base Quantico'),
 '773312':('us-navy-plank-cfl-acfl-training-official','Douglas Bedford / Navy Personnel Command'),
 '1000181':('get-fit-improving-your-plank-form','Parker Dummer / AFN Aviano'),
 '825280':('forearm-plank','Randall Moose / Air Force'),
 '283728':('push-up-demonstration','DVIDS; see saved source page'),
}
def fetch(url):
 return urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'CourseworkPoseValidation/1.0'}),timeout=45)
def main():
 p=argparse.ArgumentParser();p.add_argument('ids',nargs='*');a=p.parse_args()
 if any(ident not in SOURCES for ident in a.ids):p.error('Allowed source IDs: '+', '.join(SOURCES))
 root=ROOT/'sources';root.mkdir(exist_ok=True)
 manifest=root/'manifest.json';items={x['id']:x for x in json.loads(manifest.read_text())} if manifest.exists() else {}
 for ident in a.ids or SOURCES:
  slug,author=SOURCES[ident];url=f'https://www.dvidshub.net/video/{ident}/{slug}';page=root/f'{ident}.html'
  try:
   if not page.exists():page.write_bytes(fetch(url).read())
   content=page.read_text();media=sorted(set(re.findall(r'https[^\s"<>]+\.mp4[^\s"<>]*',content)))[0]
   dest=root/f'{ident}.mp4'
   if not dest.exists():
    size=0;part=dest.with_suffix('.part')
    with fetch(html.unescape(media)) as r,part.open('wb') as f:
     while chunk:=r.read(1024*1024):
      size+=len(chunk)
      if size>150_000_000:raise ValueError('Source exceeds 150 MB limit')
      f.write(chunk)
    part.replace(dest)
   sha=hashlib.sha256(dest.read_bytes()).hexdigest()
   items[ident]={'id':ident,'page':url,'author':author,'media_url':media,'sha256':sha,'bytes':dest.stat().st_size,'retrieved':'2026-10-26','license':'Public domain per source page; https://www.dvidshub.net/about/copyright','role':'development candidate; requires interval review','exact_duplicate_of':next((k for k,v in items.items() if k!=ident and v['sha256']==sha),None)}
   manifest.write_text(json.dumps(list(items.values()),ensure_ascii=False,indent=2))
   print(ident,dest.stat().st_size,'bytes',flush=True)
  except Exception as e:print(ident,'FAILED:',e,flush=True)
if __name__=='__main__':main()
