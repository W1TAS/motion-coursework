"""Make a small blind review packet from development-only OOF disagreements."""
from pathlib import Path
import json,subprocess,zipfile
ROOT=Path(__file__).resolve().parents[1]
p=ROOT/'pullups/dataset_mediapipe_gpu'
queue=json.loads((p/'model/development-review-queue.json').read_text())['windows']
out=p/'review-batch';out.mkdir(exist_ok=True)
items=[]
for i,r in enumerate(queue,1):
 assert r['split']!='test'
 start=max(0,r['start']-.7);end=r['end']+.7;name=f'clip-{i:02}.mp4'
 dest=out/name
 subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-y','-threads','2','-ss',str(start),'-i',r['video'],'-t',str(end-start),'-vf','scale=-2:640','-an','-c:v','libx264','-threads','2','-preset','veryfast','-crf','24','-pix_fmt','yuv420p','-movflags','+faststart',str(dest)],check=True)
 info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','json',str(dest)]))
 assert float(info['format']['duration'])>=r['end']-start-.1
 items.append(dict(id=r['uid'],file=name,windowStart=r['start']-start,windowEnd=r['end']-start,sourceStart=start))
 print(name,flush=True)
html='''<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Проверка восьми повторений</title>
<style>body{font:17px system-ui;margin:0;background:#f5f5f3;color:#202020}main{max-width:1000px;margin:auto;padding:20px}h1{font-size:24px}video{width:100%;max-height:55vh;background:#111}section{display:grid;grid-template-columns:1fr 1fr;gap:14px}label{display:block;margin:12px 0}select,textarea,button{font:inherit;padding:9px;border:1px solid #aaa;background:white;border-radius:4px}select,textarea{width:100%;box-sizing:border-box}button{cursor:pointer;margin:4px 6px 4px 0}p{line-height:1.5}.muted{font-size:14px;color:#555}#time{font-variant-numeric:tabular-nums;padding:8px}#time.inside{background:#e3f1dc}@media(max-width:650px){section{display:block}}
</style><main><h1>Проверка повторений — <span id="count"></span></h1>
<p>Оцени выделенный интервал, а не весь ролик. Зелёная строка означает попадание в исходное окно. Если движение или положение не видно, выбирай «Не могу определить». Подсказки в самом исходном видео могут быть ошибочны.</p>
<video id="video" controls playsinline preload="metadata"></video><div id="time"></div>
<button id="normal">Обычная скорость</button><button id="slow">Замедлить ×2</button><button id="replay">К началу окна</button>
<section id="fields"></section><label>Что мешает оценить или что нужно поправить?<textarea id="note" rows="2"></textarea></label>
<button id="prev">← Назад</button><button id="next">Дальше →</button><button id="save">Сохранить ответы JSON</button><p id="status" class="muted"></p>
<p class="muted">Ответы не изменяют исходную разметку автоматически. После проверки их нужно сопоставить с видео. Сохраняй JSON перед закрытием страницы; резервное хранение в браузере может быть недоступно для локальных файлов.</p></main>
<script>
const items=ITEMS;const questions=[
 ['view','Ракурс',['Почти спереди','Со спины','Сбоку или сильный поворот','Не могу определить']],
 ['visible','Видны ли руки, голова и перекладина?',['Да, всё видно','Часть скрыта или слишком мелкая','Не могу определить']],
 ['window','Что попало в выделенное окно?',['Одно полное повторение: низ → верх → низ','Только подъём: низ → верх','Обрезанное или смещённое повторение','Несколько повторений','Нет подтягивания']],
 ['bottom','Руки в нижней точке',['Полностью или почти полностью разогнуты','Заметно согнуты','Нижняя точка не видна / не могу определить']],
 ['top','Подбородок в верхней точке относительно перекладины',['Видимо выше перекладины','Не достиг перекладины','Перспектива / перекрытие мешает определить']],
 ['swing','Движения корпуса и ног при подъёме',['Нет заметной раскачки или рывка ногами','Видна раскачка или рывок ногами','Не могу определить']]
];let index=0,answers={};const key='pullup-development-review-v1';try{answers=JSON.parse(localStorage.getItem(key)||'{}')}catch{}
const $=id=>document.getElementById(id),video=$('video');
for(const [id,text,options]of questions){const label=document.createElement('label');label.textContent=text;const select=document.createElement('select');select.id=id;select.append(new Option('Выберите ответ',''));options.forEach(o=>select.append(new Option(o,o)));select.onchange=record;label.append(select);$('fields').append(label);}
function record(){answers[items[index].id]={...Object.fromEntries(questions.map(([id])=>[id,$(id).value])),note:$('note').value};try{localStorage.setItem(key,JSON.stringify(answers))}catch{}$('status').textContent='Заполнено окон: '+Object.values(answers).filter(a=>questions.every(([id])=>a[id])).length+' из '+items.length;}
function show(){const item=items[index],a=answers[item.id]||{};video.src=item.file;$('count').textContent=(index+1)+' / '+items.length;for(const[id]of questions)$(id).value=a[id]||'';$('note').value=a.note||'';$('prev').disabled=index===0;$('next').disabled=index===items.length-1;updateTime();}
function updateTime(){const i=items[index],inside=video.currentTime>=i.windowStart&&video.currentTime<=i.windowEnd;$('time').classList.toggle('inside',inside);$('time').textContent='Кадр '+video.currentTime.toFixed(2)+' с · исходное окно '+i.windowStart.toFixed(2)+'–'+i.windowEnd.toFixed(2)+' с';}
video.ontimeupdate=updateTime;$('note').oninput=record;$('prev').onclick=()=>{record();index--;show()};$('next').onclick=()=>{record();index++;show()};$('normal').onclick=()=>video.playbackRate=1;$('slow').onclick=()=>video.playbackRate=.5;$('replay').onclick=()=>{video.currentTime=items[index].windowStart;video.play()};$('save').onclick=()=>{record();const data={schema:1,scope:'development-only review, not automatic relabeling',items,answers,exportedAt:new Date().toISOString()};const u=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='pullup-review-answers.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)};show();
</script></html>'''.replace('ITEMS',json.dumps(items,ensure_ascii=False))
(out/'index.html').write_text(html)
(out/'README.txt').write_text('Распакуйте архив полностью и откройте index.html в браузере на компьютере. Нужны все MP4 рядом с HTML. Интернет не нужен. Заполните ответы и нажмите «Сохранить ответы JSON». Можно сохранить неполную партию. Если смотрите клипы отдельно на телефоне, сообщите ответы по номерам 01–08. Исходные модельные ответы скрыты; надписи автора исходного видео скрыть автоматически нельзя. Это проверка обучающих примеров, не тест модели.\n')
archive=p/'pullup-review-8.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
 for f in sorted(out.iterdir()):z.write(f,'pullup-review/'+f.name)
print(archive,archive.stat().st_size)
