// A full-cycle result must belong to this ascent, even when cycle indices differ.
export function pullupResultView(ascent,cycle){
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
 const geometry=full?.model?.geometry;
 if(geometry?.state==='measured'){
  rows.push(`Угол локтя за полный цикл: ${Math.round(geometry.top)}–${Math.round(geometry.bottom)}°`);
  rows.push(full.lateral==='visible'?'При подъёме заметно боковое смещение корпуса':'Боковое смещение при подъёме не обнаружено');
 }else if(!full)rows.push('Полный возврат вниз ещё не подтверждён.');
 else if(geometry?.reason)rows.push(geometry.reason);
 rows.push('Правильность подтягивания не подтверждена: высота подбородка над перекладиной не проверяется.');
 return {rows,bottomCandidate:analysis?.bottomCandidate,targets:full?.model?.targets??null,
  modelMessage:analysis?.error??full?.model?.error??(!full?'Для модели полного цикла нужен возврат вниз.':!full.model?'Вычисляю оценку полного цикла…':null)};
}
