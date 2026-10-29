"""Проверка локального видео на возможный перезалив, включая зеркальное отражение.

Не подтверждает уникальность. Совпадения требуют проверки перед разбиением данных.
"""
import argparse
import hashlib
from pathlib import Path
import cv2
import numpy as np
from acquire_data import read_json, atomic_json, similar_fingerprints


def source_key(platform, publication_id):
    if platform not in ('youtube','tiktok','vk','rutube','vimeo'):
        raise ValueError('Неизвестная платформа')
    value = str(publication_id)
    if not value or not all(c.isalnum() or c in '_-' for c in value):
        raise ValueError('Недопустимый идентификатор')
    return f'{platform}:{value}'


def phash(frame):
    gray=cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY)
    coeff=cv2.dct(cv2.resize(gray,(32,32)).astype(np.float32))[:8,:8].flatten()[1:]
    return hex(sum(int(b)<<i for i,b in enumerate(coeff>np.median(coeff))))


def variants(path):
    cap=cv2.VideoCapture(str(path)); n=cap.get(cv2.CAP_PROP_FRAME_COUNT)
    hashes={'normal':[],'mirrored':[]}
    try:
        if n>0:
            for frac in np.linspace(.08,.92,12):
                cap.set(cv2.CAP_PROP_POS_FRAMES,int(frac*(n-1)))
                ok,frame=cap.read()
                if ok:
                    hashes['normal'].append(phash(frame))
                    hashes['mirrored'].append(phash(cv2.flip(frame,1)))
    finally: cap.release()
    return hashes


def check(path,index):
    digest=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):digest.update(chunk)
    fingerprints=variants(path)
    matches=[]
    for name,entry in index.items():
        if Path(name).resolve()==path.resolve():continue
        for variant,hashes in fingerprints.items():
            if similar_fingerprints(hashes,entry['hashes']):
                matches.append({'video_id':entry['video_id'],'path':name,'variant':variant,'action':'quarantine_until_review'})
                break
    return {'input':str(path.resolve()),'sha256':digest.hexdigest(),'frames':len(fingerprints['normal']),
            'possible_matches':matches,'unique_guaranteed':False,
            'limitations':['index coverage may be incomplete','cropping, edits, overlays and very short clips can evade detection',
                           'similarity is not proof; do not automatically copy labels']}


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--video',type=Path,required=True)
    ap.add_argument('--index',type=Path,default=Path('internet_data/fingerprints.json'))
    ap.add_argument('--out',type=Path,default=Path('audit/repost_check.json'))
    args=ap.parse_args(); result=check(args.video,read_json(args.index,{}))
    args.out.parent.mkdir(parents=True,exist_ok=True);atomic_json(args.out,result)
    print('Подозрительных совпадений:',len(result['possible_matches']))


if __name__=='__main__': main()
