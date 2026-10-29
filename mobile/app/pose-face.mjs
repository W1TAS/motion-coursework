// Existing Pose Landmarker points only. No face detector or inferred chin.
const connections=[[0,1],[1,2],[2,3],[3,7],[0,4],[4,5],[5,6],[6,8],[9,10]];
export function visibleFacePoints(landmarks,width,height){
 if(!(width>0&&height>0))return [];
 const points=[];
 for(let id=0;id<=10;id++){
  const p=landmarks?.[id];
  if(!p||![p.x,p.y].every(Number.isFinite)||p.x<0||p.x>1||p.y<0||p.y>1||
   !Number.isFinite(p.visibility)||!(Math.min(p.visibility,p.presence??1)>=.45))continue;
  points.push({id,x:p.x*width,y:p.y*height});
 }
 return points;
}
export function drawPoseFace(ctx,landmarks,width,height){
 const points=visibleFacePoints(landmarks,width,height),byId=new Map(points.map(p=>[p.id,p]));
 ctx.strokeStyle='#73c8ef';ctx.fillStyle='#73c8ef';ctx.lineWidth=Math.max(1,width/300);
 for(const [a,b]of connections){
  const p=byId.get(a),q=byId.get(b);if(!p||!q)continue;
  ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke();
 }
 for(const p of points){ctx.beginPath();ctx.arc(p.x,p.y,Math.max(2,width/240),0,Math.PI*2);ctx.fill();}
 return points.length;
}
