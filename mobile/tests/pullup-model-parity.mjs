import fs from 'node:fs';import assert from 'node:assert/strict';import {predictHGB} from '../app/pullup-model.mjs';
const model=JSON.parse(fs.readFileSync('mobile/app/models/pullup-hgb.json')),cases=JSON.parse(fs.readFileSync('mobile/research/pullup-model-fixtures.json'));let maxError=0;
for(const row of cases)for(const [target,entry]of Object.entries(model.models)){
 const p=predictHGB(entry,row.x.map(v=>v===null?NaN:v));maxError=Math.max(maxError,Math.abs(p-row.expected[target]));assert.ok(Math.abs(p-row.expected[target])<1e-12,`${row.uid}/${target}`);
}
const result={cases:cases.length,maxError,modelSha256:model.sourceSha256};fs.writeFileSync('mobile/tests/pullup-model-parity-result.json',JSON.stringify(result,null,2));console.log(result);
