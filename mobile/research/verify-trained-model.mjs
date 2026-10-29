// Verify a separately exported candidate without replacing the app's model.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {predictHGB} from '../app/pullup-model.mjs';
const dir=path.resolve(process.argv[2]);
const model=JSON.parse(fs.readFileSync(path.join(dir,'pullup-hgb.json')));
const cases=JSON.parse(fs.readFileSync(path.join(dir,'parity-fixtures.json')));
assert.ok(cases.length>0,'No feature vectors for export verification');
let maxError=0;
for(const row of cases)for(const [target,entry] of Object.entries(model.models)){
 const actual=predictHGB(entry,row.x.map(v=>v===null?NaN:v));
 const error=Math.abs(actual-row.expected[target]);
 assert.ok(Number.isFinite(error)&&error<1e-12,`${row.uid}/${target}: export mismatch`);
 maxError=Math.max(error,maxError);
}
const result={cases:cases.length,maxError,modelSha256:model.sourceSha256};
fs.writeFileSync(path.join(dir,'export-verification.json'),JSON.stringify(result,null,2));
console.log('Verified exported model:',result);
