"""Compare wrist offset with image geometry; experimental, not app calibration."""
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np

from measure_bar_offsets import BASE, OUT, PACKET, propose, signed_distance


def hand_reference(packet, item, ref):
    local=[f for f in packet['poses'][item['id']] if abs(f['t']-item['windowStart'])<=.2+1e-5]
    hands=[[],[]]
    for f in local:
        if not f['p']:
            continue
        for side,ids in enumerate(((17,19,21),(18,20,22))):
            good=[f['p'][i] for i in ids if f['p'][i][2]>=.45]
            if len(good)>=2:
                hands[side].append(np.mean([[p[0]*ref['width'],p[1]*ref['height']] for p in good],axis=0))
    if any(len(h)<3 or len(h)/max(1,len(local))<.8 for h in hands):
        return None
    points=[np.median(h,axis=0).tolist() for h in hands]
    return dict(points=points,frames=[len(h) for h in hands],
                offsetPixels=float(np.mean([signed_distance(p,ref['left'],ref['right']) for p in points])))


def anchored_candidate(candidates, hand, torso):
    if hand is None:
        return dict(status='unavailable',reason='hand_points_unavailable')
    options=[]
    for i,first in enumerate(candidates):
        for second in candidates[i+1:]:
            upper,lower=first,second
            if upper['offsetPixels']<lower['offsetPixels']:
                upper,lower=lower,upper
            diameter=upper['offsetPixels']-lower['offsetPixels']
            if not 2<=diameter<=.12*torso or abs(upper['angleDegrees']-lower['angleDegrees'])>5:
                continue
            gaps=[]
            for point in hand['points']:
                ds=[]
                for edge in (upper,lower):
                    a=dict(zip(('x','y'),edge['a']));b=dict(zip(('x','y'),edge['b']))
                    ds.append(signed_distance(point,a,b))
                gaps.append(abs(np.mean(ds)))
            gap=float(np.mean(gaps))
            if gap>.08*torso:
                continue
            support=min(upper['coverage'],lower['coverage'])
            score=support-3*gap/torso-.1*diameter/torso
            options.append(dict(status='paired_edge_candidate',upper=upper,lower=lower,
                                gapToHandPixels=gap,diameterPixels=diameter,score=score,
                                offsetPixels=upper['offsetPixels']))
    if not options:
        return dict(status='unavailable',reason='no_supported_edge_pair')
    options.sort(key=lambda c:-c['score'])
    best=options[0]
    rival=next((c for c in options[1:] if abs(c['offsetPixels']-best['offsetPixels'])>.03*torso),None)
    if rival and best['score']-rival['score']<.1:
        return dict(status='unavailable',reason='ambiguous_edge_pairs',bestCandidate=best)
    return best


def main():
    raw=(PACKET/'packet-data.json').read_bytes();packet=json.loads(raw)
    prior=json.loads((OUT/'candidates.json').read_text())
    assert prior['packetSha256']==hashlib.sha256(raw).hexdigest()
    refs_bytes=(OUT/'visual-references.json').read_bytes();visual={r['number']:r for r in json.loads(refs_bytes)['rows']}
    rows=[]
    for item,old in zip(packet['items'],prior['rows'],strict=True):
        assert item['id']==old['uid']
        ref=old['imageReference']; image=cv2.imread(str(OUT/old['referenceImage']))
        hand=hand_reference(packet,item,ref)
        candidates=propose(image,ref,canny=(25,90),max_candidates=30)['candidates']
        if item['measurement'].get('reason') in ('reference_wrists_unstable','reference_wrists_unavailable'):
            auto=dict(status='unavailable',reason='wrist_reference_not_reliable')
        else:
            auto=anchored_candidate(candidates,hand,ref['torsoPixels'])
        vr=visual[old['number']]; row=dict(number=old['number'],uid=item['id'],hand=hand,automatic=auto,
                                        sourceImageSha256=hashlib.sha256((OUT/old['referenceImage']).read_bytes()).hexdigest(),
                                        visualReference=vr)
        if vr['status']=='approximate_reference':
            point=np.mean([vr['a'],vr['b']],axis=0)
            offset=signed_distance(point,ref['left'],ref['right'])
            row.update(offsetPixels=offset,offsetTorso=offset/ref['torsoPixels'])
            if hand:
                row['handProxyErrorPixels']=hand['offsetPixels']-offset
            if auto['status']=='paired_edge_candidate':
                row['automaticErrorPixels']=auto['offsetPixels']-offset
            row['naiveCandidateErrorPixels']=old['candidates'][0]['offsetPixels']-offset if old['candidates'] else None
        rows.append(row)
    good=[r for r in rows if 'offsetPixels' in r]
    measured=[r['offsetPixels'] for r in good];scaled=[r['offsetTorso'] for r in good]
    compared=[r for r in good if 'automaticErrorPixels' in r]
    summary=dict(approximateReferences=len(good),excluded=len(rows)-len(good),
                 pixelsAt640=dict(min=float(min(measured)),median=float(np.median(measured)),max=float(max(measured))),
                 torsoFraction=dict(min=float(min(scaled)),median=float(np.median(scaled)),max=float(max(scaled))),
                 automaticCandidates=len(compared),automaticWithin3Pixels=sum(abs(r['automaticErrorPixels'])<=3 for r in compared),
                 naiveWithin3Pixels=sum(r['naiveCandidateErrorPixels'] is not None and abs(r['naiveCandidateErrorPixels'])<=3 for r in good))
    output=dict(schema=1,packetSha256=prior['packetSha256'],visualReferenceSha256=hashlib.sha256(refs_bytes).hexdigest(),
                protocol='Development image experiment only: hand landmarks anchor nearby pairs of approximately parallel image edges. Upper visible edge is the reference. No exercise labels, threshold fitting or corrections to old answers.',
                summary=summary,rows=rows,
                limitations=['Only 12 targeted scenes, nine approximate visual references chosen by the agent, not independent human bar annotations.',
                             'Reference reading uncertainty is approximately ±3 pixels at reference height 640.',
                             'Pixel scale and camera/hand projection vary; no universal pixel or torso-ratio correction validated.',
                             'Candidate pairing may select a background structure. Multigrip/occluded scenes need abstention or explicit reference.',
                             'No existing review page, original answers, model weights or APK modified.'])
    (OUT/'refined.json').write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(summary,ensure_ascii=False,indent=2))
    for r in rows:
        print(r['number'], 'visual',round(r.get('offsetPixels',0),1),
              'hand',None if not r['hand'] else round(r['hand']['offsetPixels'],1),
              'auto',r['automatic']['status'],round(r.get('automaticErrorPixels',0),1))


if __name__=='__main__':main()
