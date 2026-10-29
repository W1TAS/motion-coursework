import test from 'node:test';import assert from 'node:assert/strict';
import {pullupResultView} from '../app/pullup-presentation.mjs';
test('an early ascent never displays the previous full-cycle verdict',()=>{
 const view=pullupResultView({index:3},{index:2,ascentIndex:2,model:{targets:{partial:{state:'flagged'}}}});
 assert.equal(view.targets,null);assert.match(view.modelMessage,/возврат/);
 assert.ok(view.rows.includes('Подъём № 3'));
});
test('full-cycle and ascent indices may differ; initial measurement remains the early one',()=>{
 const early={initialBottom:{state:'measured',angle3d:165},bottomCandidate:{state:'not_detected'}};
 const cycle={index:2,ascentIndex:3,model:{initialBottom:{state:'measured',angle3d:120},
  geometry:{state:'measured',top:65,bottom:170},targets:{partial:{state:'flagged'}}}};
 const view=pullupResultView({index:3,analysis:early},cycle);
 assert.match(view.rows.join(' '),/165°/);assert.doesNotMatch(view.rows.join(' '),/120°/);
 assert.equal(view.bottomCandidate.state,'not_detected');assert.equal(view.targets,cycle.model.targets);
});
test('lost initial position is explained rather than declared normal',()=>{
 const view=pullupResultView({index:1,analysis:{initialBottom:{state:'unavailable',reason:'Начало потеряно'},
  bottomCandidate:{state:'unavailable'}}});
 assert.match(view.rows.join(' '),/Начало потеряно/);assert.equal(view.bottomCandidate.state,'unavailable');
 assert.equal(pullupResultView(null),null);
});
test('top feedback distinguishes low, uncertain and above without a correctness verdict; it can be hidden',()=>{
 for(const state of ['below','above','uncertain','unavailable']){
  const ascent={index:1,analysis:{topHeight:{state,reason:'Мало кадров'}}};
  const view=pullupResultView(ascent);
  assert.ok(view.rows.some(t=>t.startsWith('Верх:')));assert.equal(view.topHeight.state,state);
  const off=pullupResultView(ascent,null,{topEnabled:false});assert.equal(off.topHeight,null);
  assert.ok(!off.rows.some(t=>t.startsWith('Верх:')));
 }
});
