// A full-cycle result must belong to this ascent, even when cycle indices differ.
export function pullupResultView(ascent,cycle,{topEnabled=true}={}){
 if(!ascent)return null;
 const full=cycle?.ascentIndex===ascent.index?cycle:null;
 const analysis=ascent.analysis??full?.model,bottom=analysis?.initialBottom;
 const rows=[`Подъём № ${ascent.index}`];
 if(analysis?.error)rows.push(analysis.error);
 else if(bottom?.state==='unavailable')rows.push(`Начальное положение: ${bottom.reason}`);
 else if(bottom?.state==='measured'){
  if(Number.isFinite(bottom.angle3d))rows.push(`Руки перед подъёмом: ${Math.round(bottom.angle3d)}° (оценка 3D)`);
  else rows.push(`Руки перед подъёмом: ${Math.round(bottom.angle2d)}° на изображении; 3D недоступна`);
 }else rows.push('Проверяю исходное положение…');
 const top=analysis?.topHeight;
 if(topEnabled){
  const text={below:'Верх: возможна недостаточная высота',above:'Верх: рот выше расчётного уровня',uncertain:'Верх: пограничная высота, уверенной оценки нет'};
  rows.push(top?.state==='unavailable'?`Верх: недостаточно данных — ${top.reason}`:text[top?.state]??'Проверяю высоту верха…');
 }
 const geometry=full?.model?.geometry;
 if(geometry?.state==='measured'){
  rows.push(`Угол локтя за полный цикл: ${Math.round(geometry.top)}–${Math.round(geometry.bottom)}°`);
  rows.push(full.lateral==='visible'?'При подъёме заметно боковое смещение корпуса':'Боковое смещение при подъёме не обнаружено');
 }else if(!full)rows.push('Полный возврат вниз ещё не подтверждён.');
 else if(geometry?.reason)rows.push(geometry.reason);
 rows.push('Высота оценивается по рту и кистям. Подбородок и реальная перекладина не определяются; правильность всего повторения не подтверждена.');
 return {rows,topHeight:topEnabled?top:null,bottomCandidate:analysis?.bottomCandidate,targets:full?.model?.targets??null,
  modelMessage:analysis?.error??full?.model?.error??(!full?'Для модели полного цикла нужен возврат вниз.':!full.model?'Вычисляю оценку полного цикла…':null)};
}
