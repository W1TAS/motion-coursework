"""Compare image-, torso- and hand-relative bar offset priors on held-out scenes.

Only agent image references are fitted; technique labels are never read.
"""
import hashlib
import json
from pathlib import Path

import numpy as np

BASE=Path(__file__).resolve().parent/'dataset_mediapipe_gpu/human-reviews'
OUT=BASE/'top-proxy-v1/bar-offset-audit-v1'


def fit_coefficient(rows,scale):
    if not rows or any(r[scale]<=0 for r in rows):
        raise ValueError('Positive geometric scales required')
    return float(np.median([r['offsetPixels']/r[scale] for r in rows]))


def shifted_line(left,right,offset):
    """Translate upwards along the line normal, regardless of anatomical order."""
    a,b=sorted([left,right],key=lambda p:p['x'])
    dx,dy=b['x']-a['x'],b['y']-a['y'];length=np.hypot(dx,dy)
    if not np.isfinite(offset) or length<=1e-6:
        raise ValueError('Finite offset and distinct wrists required')
    nx,ny=dy/length,-dx/length
    return [dict(x=float(p['x']+offset*nx),y=float(p['y']+offset*ny)) for p in (left,right)]


def main():
    geometry_bytes=(OUT/'refined.json').read_bytes();geometry=json.loads(geometry_bytes)
    candidate=json.loads((OUT/'candidates.json').read_text());by_number={r['number']:r for r in candidate['rows']}
    selected=json.loads((BASE/'top-proxy-v1/review-selection.json').read_text())
    groups={r['uid']:r['group'] for r in selected['rows']}
    rows=[]
    for row in geometry['rows']:
        if 'offsetPixels' not in row:
            continue
        ref=by_number[row['number']]['imageReference'];hand=row['hand']
        if hand is None:
            raise ValueError('Use the same scenes for every scale comparison')
        hand_length=float(np.mean([np.hypot(p[0]-w['x'],p[1]-w['y']) for p,w in zip(hand['points'],(ref['left'],ref['right']),strict=True)]))
        rows.append(dict(number=row['number'],uid=row['uid'],group=groups[row['uid']],
                         offsetPixels=row['offsetPixels'],frameHeight=ref['height'],torso=ref['torsoPixels'],handLength=hand_length))
    assert len(rows)==len({r['group'] for r in rows})==9
    models={}
    for name,scale in [('frame_height','frameHeight'),('torso','torso'),('hand_proxy','handLength')]:
        predictions=[]
        for held in rows:
            train=[r for r in rows if r['group']!=held['group']]
            assert len(train)==8
            coefficient=fit_coefficient(train,scale)
            predicted=coefficient*held[scale]
            predictions.append(dict(number=held['number'],uid=held['uid'],heldOutGroup=held['group'],
                                    trainingGroups=sorted(r['group'] for r in train),coefficient=coefficient,
                                    reference=held['offsetPixels'],predicted=predicted,error=predicted-held['offsetPixels']))
        errors=np.array([abs(r['error']) for r in predictions]);coef=fit_coefficient(rows,scale)
        models[name]=dict(scale=scale,fullDevelopmentCoefficient=coef,
                         meanAbsoluteErrorPixels=float(errors.mean()),medianAbsoluteErrorPixels=float(np.median(errors)),
                         maximumAbsoluteErrorPixels=float(errors.max()),within3Pixels=int(sum(errors<=3)),predictions=predictions)
    result=dict(schema=1,geometrySha256=hashlib.sha256(geometry_bytes).hexdigest(),scenes=9,
                protocol='Leave one scene/channel out: median offset/scale fitted on the other eight image references. Same nine scenes for all three scales. Frame-height baseline equals constant pixels only at common height 640. No technique judgments used.',
                referenceUncertaintyPixels=3,models=models,rows=rows,
                limitations=['Only nine approximate agent image references, not an independent human-annotated bar benchmark.',
                             'Exploratory comparison of predefined scales, not a validated model or confidence interval.',
                             'Fixed scene, wrist reliability, grip and camera angle remain requirements.',
                             'Torso normalization addresses framing scale, not the absence of a chin landmark.'])
    (OUT/'scaling-comparison.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    ratios=[r['offsetPixels']/r['torso'] for r in rows]
    prior=dict(schema=1,state='experimental_prior_not_measured_bar',torsoDefinition='Pixel distance between mid-shoulders and mid-hips in the initial stable frames',
               torsoFraction=models['torso']['fullDevelopmentCoefficient'],empiricalFractionRange=[min(ratios),max(ratios)],
               rangeIsConfidenceInterval=False,geometrySha256=result['geometrySha256'],
               scope='Image geometry pilot on nine scenes only; no application deployment or label overwriting.')
    (OUT/'torso-prior.json').write_text(json.dumps(prior,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:{key:v[key] for key in ('fullDevelopmentCoefficient','meanAbsoluteErrorPixels','medianAbsoluteErrorPixels','maximumAbsoluteErrorPixels','within3Pixels')} for k,v in models.items()},indent=2))


if __name__=='__main__':main()
