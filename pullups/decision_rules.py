"""Явные правила качества и интерпретации. Метки человека не входят во вход решателя."""
import math


def number(row, name, default=math.nan):
    try:
        value = float(row[name])
        return value if math.isfinite(value) else default
    except (KeyError, TypeError, ValueError):
        return default


def decide(row, scores, thresholds, knowledge):
    q = knowledge['quality']
    checks = [
        ('Q1', number(row,'nan_frac',1) <= q['max_nan_frac'] and number(row,'kp_conf',0) >= q['min_kp_conf'],
         'Проверена видимость основных точек тела'),
        ('Q2', number(row,'box_jump',1) <= q['max_box_jump'], 'Проверена непрерывность отслеживания'),
        ('Q3', number(row,'wr_move',math.inf) <= q['max_wrist_move'], 'Проверено смещение рук в пределах фрагмента'),
    ]
    core = row.get('usable') in ('1',1,True) and all(ok for _,ok,_ in checks)
    legs = min(number(row,'knees_ok',0), number(row,'ankles_ok',0)) >= q['min_legs_fraction']
    trace = [{'rule':rid,'passed':bool(ok),'explanation':text} for rid,ok,text in checks]
    trace.append({'rule':'Q4','passed':bool(legs),'explanation':'Ноги видны достаточно долго для оценки раскачивания'})
    results = {}
    for i, target in enumerate(('partial','swing')):
        available = core and (target != 'swing' or legs)
        score = scores.get(target)
        available = available and score is not None and math.isfinite(score)
        threshold = thresholds[target]
        state = 'flagged' if available and score >= threshold else 'not_detected' if available else 'unavailable'
        results[target] = {'state':state,'score':score if available else None,'threshold':threshold}
        trace.append({'rule':f'C{i+1}','passed':available,'explanation':
                      f'Оценка {score:.3f}, порог {threshold:.3f}' if available else 'Классификация не выдана: недостаточно пригодных наблюдений'})
    state = ('insufficient' if any(r['state']=='unavailable' for r in results.values()) else
             'deviation' if any(r['state']=='flagged' for r in results.values()) else 'no_detected_deviation')
    return {'state':state,'targets':results,'trace':trace,
            'scope':'Проверяются только два наблюдаемых признака; отсутствие срабатываний не подтверждает всю технику.'}
