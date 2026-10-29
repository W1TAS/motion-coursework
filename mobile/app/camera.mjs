export const CAMERA_NAMES=Object.freeze({user:'Фронтальная',environment:'Задняя'});
export function savedFacing(storage){try{const value=storage.getItem('motion-camera');return Object.hasOwn(CAMERA_NAMES,value)?value:'user';}catch{return 'user';}}
export async function openCamera(mediaDevices,facing){
 if(!Object.hasOwn(CAMERA_NAMES,facing))throw new Error('Выберите фронтальную или заднюю камеру');
 // A preference may silently open another camera; request the selected direction explicitly.
 const supportsFacing=mediaDevices.getSupportedConstraints?.().facingMode!==false;
 const video={width:{ideal:640},height:{ideal:480}};
 if(supportsFacing)video.facingMode={exact:facing};
 let stream;
 try{stream=await mediaDevices.getUserMedia({audio:false,video});}
 catch(error){
  if(error.name==='OverconstrainedError'||error.name==='NotFoundError')throw new Error(`${CAMERA_NAMES[facing]} камера недоступна. Выберите другую камеру.`);
  throw error;
 }
 const actual=stream.getVideoTracks()[0]?.getSettings?.().facingMode;
 if(actual&&actual!==facing){stream.getTracks().forEach(t=>t.stop());throw new Error(`Устройство включило другую камеру. Выберите «${CAMERA_NAMES[actual]??'другую камеру'}».`);}
 return {stream,actual:Object.hasOwn(CAMERA_NAMES,actual)?actual:null,mirror:actual==='user'};
}
export function poseFeedback(result,exercise){
 if(!result.valid)return {state:'warning',title:'Не хватает данных для подсчёта',text:result.message};
 if(result.phase==='confirming')return {state:'warning',title:'Проверяю положение',text:result.message};
 if(!result.active)return {state:'warning',title:'Подсчёт приостановлен',text:result.message};
 if(result.phase==='waiting')return {state:'warning',title:'Примите исходное положение',text:result.message};
 if(exercise==='plank')return {state:'active',title:'Время засчитывается',text:result.message};
 return {state:'active',title:result.phase==='bottom'?'Нижняя фаза распознана':'Положение подходит для подсчёта',text:result.message};
}
