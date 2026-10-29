import {measurePullup} from '../app/pullup-engine.mjs';

const median = values => {
 const sorted = values.slice().sort((a,b)=>a-b), middle = (sorted.length-1)/2;
 return (sorted[Math.floor(middle)]+sorted[Math.ceil(middle)])/2;
};

// Same original 2D, both-arm initial measurement as the frozen bottom baseline.
export function initialBottom2D(frames, bottomMs, topMs) {
 const local = frames.filter(f=>f.now>=bottomMs-120-1e-6 && f.now<=Math.min(topMs,bottomMs+120)+1e-6);
 const angles = local.map(f=>measurePullup(f.landmarks,f.width,f.height))
  .filter(m=>m.valid && m.arms===2).map(m=>m.elbow);
 const covered = local.length>=3 && local[0].now<=bottomMs+40 && local.at(-1).now>=bottomMs-40;
 if(!covered || angles.length<3 || angles.length/local.length<.8)
  return {state:'unavailable',frames:local.length,bothArmsValid:angles.length};
 const angle = median(angles);
 return {state:'measured',angle,predictedError:angle<150,frames:local.length,bothArmsValid:angles.length};
}

// Ordered one-to-one matching: maximize matched events, then minimize time error.
// Labels and geometry are deliberately absent from the interface.
export function matchEvents(references, detections, {bottomMs=500,topMs=400}={}) {
 const refs=references.map((v,index)=>({...v,index})).sort((a,b)=>a.top-b.top);
 const reps=detections.map((v,index)=>({...v,index})).sort((a,b)=>a.top-b.top);
 const table=Array.from({length:refs.length+1},()=>Array(reps.length+1));
 table[0][0]={n:0,cost:0,pairs:[]};
 const best=(a,b)=>!a||b.n>a.n||(b.n===a.n&&b.cost<a.cost)?b:a;
 for(let i=0;i<=refs.length;i++)for(let j=0;j<=reps.length;j++){
  const cell=table[i][j]; if(!cell)continue;
  if(i<refs.length)table[i+1][j]=best(table[i+1][j],cell);
  if(j<reps.length)table[i][j+1]=best(table[i][j+1],cell);
  if(i<refs.length&&j<reps.length){
   const dt=Math.abs(refs[i].top-reps[j].top),db=Math.abs(refs[i].bottom-reps[j].sampleStart);
   if(dt<=topMs&&db<=bottomMs){
    const next={n:cell.n+1,cost:cell.cost+dt+db,pairs:[...cell.pairs,[refs[i].index,reps[j].index]]};
    table[i+1][j+1]=best(table[i+1][j+1],next);
   }
  }
 }
 return table.at(-1).at(-1).pairs;
}

// A prior from nine approximate image references; never a detected bar or chin.
export function scaledFaceState(measurement,prior,{when='top',point='mouth',range=true}={}) {
 const value=measurement?.[when]?.[point],ref=measurement?.reference;
 if(measurement?.state!=='measured'||!value||!ref)return {state:'unavailable'};
 const [lo,hi]=range?prior.empiricalFractionRange:[prior.torsoFraction,prior.torsoFraction];
 const interval=[value.clearancePixels-hi*ref.torsoPixels,value.clearancePixels-lo*ref.torsoPixels];
 const state=interval[1]<-ref.tolerancePixels?'below':interval[0]>ref.tolerancePixels?'above':'uncertain';
 return {state,clearanceIntervalPixels:interval,tolerancePixels:ref.tolerancePixels,
  scope:'Facial proxy versus a shifted wrist line; no chin-over-bar verdict.'};
}
