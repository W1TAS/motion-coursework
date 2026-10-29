import test from 'node:test';import assert from 'node:assert/strict';
import {visibleFacePoints,drawPoseFace} from '../app/pose-face.mjs';
const points=()=>Array.from({length:33},(_,i)=>({x:.3+i*.005,y:.2+i*.005,visibility:.9,presence:.9}));
test('pullup overlay draws the existing eleven face landmarks, independently of body links',()=>{
 const arcs=[],ctx={beginPath(){},moveTo(){},lineTo(){},stroke(){},fill(){},arc(x,y){arcs.push([x,y]);}};
 const p=points();
 assert.equal(drawPoseFace(ctx,p,640,480),11);assert.equal(arcs.length,11);
 assert.deepEqual(arcs[0],[p[0].x*640,p[0].y*480]);
 assert.deepEqual(arcs[10],[p[10].x*640,p[10].y*480]);
});
test('an uncertain nose or mouth does not hide other available face landmarks',()=>{
 const p=points();p[0].visibility=.1;p[9].presence=.1;p[10]=null;
 assert.deepEqual(visibleFacePoints(p,640,480).map(p=>p.id),[1,2,3,4,5,6,7,8]);
});
test('missing, invalid or off-image landmarks are never invented or displayed',()=>{
 assert.deepEqual(visibleFacePoints(null,640,480),[]);
 const p=points();p[0].x=NaN;p[1].y=-.1;p[2].visibility=undefined;p[3].presence=NaN;
 assert.equal(visibleFacePoints(p,640,480).length,7);
 assert.equal(visibleFacePoints(p,0,480).length,0);
});
