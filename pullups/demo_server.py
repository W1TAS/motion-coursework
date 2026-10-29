"""Локальная демонстрация гибридного анализа сохранённых видео и скелетов.

.venv/bin/python demo_server.py --port 8768
Не выдаёт архивную обработку за анализ камеры в реальном времени.
"""
import argparse
from functools import lru_cache
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse, parse_qs
import numpy as np
import torch
from threadpoolctl import threadpool_limits
from acquire_data import read_csv, read_json, read_jsonl
from build_dataset import load_segment, resample
from decision_rules import decide
from feature_model import motion_features
from label_tool import App, make_handler
from train import load_aux
import rep_features as rf

BASE = Path(__file__).resolve().parent


class Demo:
    def __init__(self, base, model):
        self.base, self.data = base, base / 'internet_data'
        self.model_path = model
        self.ckpt = torch.load(model,map_location='cpu',weights_only=False)
        if self.ckpt.get('model_type') != 'features': raise ValueError('Нужен классификатор признаков')
        self.knowledge = read_json(base/'knowledge_rules.json',{})
        self.thresholds = {t:self.ckpt['operating_point'][t]['threshold'] for t in self.ckpt['targets']}
        self.aux = load_aux(self.data,None)
        self.rows = {r['rep_id']:r for r in read_csv(self.data/'reps.csv')}
        journal = read_jsonl(self.data/'labels.jsonl')
        self.labels = {r['rep_id']:r for r in journal if r.get('action')=='label'}
        self.banned = {r['video_id'] for r in journal if r.get('action')=='ban_video'}
        self.samples = {r['rep_id']:r for r in read_csv(base/'dataset_audited/samples.csv')}
        self.media = App(SimpleNamespace(data=self.data,split='all',include_unusable=True,max_pbad=1,
                          seed=0,queue='time',queue_file=None,batch_size=0,show_hints=False))

    def overview(self):
        samples = []
        for rid, row in self.rows.items():
            lab = self.labels.get(rid)
            if self.media.find_video(row['video_id']) is None: continue
            reference = 'unlabeled' if lab is None else 'rejected' if lab.get('bad') or lab.get('unsure') else 'confirmed'
            samples.append({'id':rid,'video_id':row['video_id'],'start':float(row['start']),
                            'end':float(row['end']),'view':row.get('facing'),'reference_state':reference,
                            'split':self.samples.get(rid,{}).get('split','not_in_dataset')})
        return {'samples':samples,'audit':read_json(self.base/'audit/data_audit.json',{}),
                'metrics':read_json(self.model_path.parent/'evaluation_test.json',{}),
                'validation':read_json(self.model_path.parent/'cv_report.json',{}).get('selected',{}),
                'knowledge':self.knowledge,'mode':'archive_with_cached_pose'}

    @lru_cache(maxsize=128)
    def analyze(self,rid):
        if rid not in self.rows: return None
        row = self.rows[rid]
        cfg = SimpleNamespace(kp_conf=.3,smooth_s=.1,max_gap_s=.4)
        t,p,conf,scale,center,*_ = load_segment(str(self.data),row['video_id'],int(row['segment_idx']),cfg,rf)
        mask = (t >= float(row['start'])-.2) & (t <= float(row['end'])+.2)
        scores = {}
        if mask.sum() >= 8 and np.isfinite(scale) and scale >= 5:
            _,pos,c = resample((p[mask]-center)/scale,conf[mask],t[mask],30.)
            c = np.where(np.isfinite(pos).all(axis=2),c,0.)
            pos = np.nan_to_num(pos).astype(np.float32)
            aux = self.aux[f'pool:{rid}']
            with threadpool_limits(limits=2):
                for target, entry in self.ckpt['models'].items():
                    x = np.concatenate([aux,motion_features(pos,c)]) if entry['feature_set']=='motion' else aux
                    scores[target] = float(entry['model'].predict_proba(x[None])[0,1])
        decision = decide(row,scores,self.thresholds,self.knowledge)
        lab = self.labels.get(rid)
        reference = None if lab is None else {'labels':lab.get('labels',{}),'clean':lab.get('clean',False),
                                               'bad':lab.get('bad',False),'unsure':lab.get('unsure',False)}
        return {'id':rid,'start':float(row['start']),'top':float(row['top']),'end':float(row['end']),
                'video_id':row['video_id'],'decision':decision,'reference':reference,
                'split':self.samples.get(rid,{}).get('split','not_in_dataset'),
                'measurements':{k:float(row[k]) if row.get(k) and np.isfinite(float(row[k])) else None
                                for k in ('elb_bot','elb_top','knees_ok','ankles_ok','kp_conf','wr_move')}}


def make_demo_handler(demo):
    class Handler(make_handler(demo.media)):
        def do_GET(self):
            u = urlparse(self.path)
            if u.path == '/':
                self._send(200,(demo.base/'demo.html').read_text(), 'text/html; charset=utf-8')
            elif u.path == '/api/demo': self._send(200,demo.overview())
            elif u.path == '/api/analysis':
                try:
                    result = demo.analyze((parse_qs(u.query).get('rep') or [''])[0])
                    self._send(200 if result else 404,result or {'error':'Пример не найден'})
                except (OSError,ValueError,KeyError) as e: self._send(422,{'error':str(e)})
            else: super().do_GET()

        def do_POST(self): self._send(405,{'error':'Демонстрация работает только на чтение'})
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8768)
    parser.add_argument('--model',type=Path,default=BASE/'dataset_audited/model/model_final.pt')
    args = parser.parse_args()
    torch.set_num_threads(2)
    demo = Demo(BASE,args.model)
    server = ThreadingHTTPServer(('127.0.0.1',args.port),make_demo_handler(demo))
    print(f'Демонстрация: http://127.0.0.1:{args.port}/',flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass


if __name__ == '__main__': main()
