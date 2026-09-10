import test from 'node:test';import assert from 'node:assert/strict';import {normalizeNpmSbom} from './normalize-npm-sbom.mjs';
const fixture=()=>({components:[{'bom-ref':'a',name:'a',version:'1',scope:'optional',properties:[{name:'path',value:'nested/a'}],hashes:[{alg:'SHA-256',content:'abc'}]},{'bom-ref':'a',name:'a',version:'1',scope:'required',properties:[{name:'path',value:'a'}],hashes:[{alg:'SHA-256',content:'abc'}]}],dependencies:[{ref:'a',dependsOn:['b']},{ref:'a',dependsOn:['c','b']}]});
test('normalization preserves installation paths and dependency edges without mutating input',()=>{const input=fixture(),before=structuredClone(input),b=normalizeNpmSbom(input);assert.deepEqual(input,before);assert.equal(b.components.length,1);assert.equal(b.components[0].properties.length,2);assert.equal(b.components[0].scope,'required');assert.equal(b.components[0].hashes.length,1);assert.deepEqual(b.dependencies,[{ref:'a',dependsOn:['b','c']}]);});
test('conflicting identity or same-algorithm hash is not silently merged',()=>{const a=fixture();a.components[1].version='2';assert.throws(()=>normalizeNpmSbom(a),/Conflicting package identity/);const b=fixture();b.components[1].hashes[0].content='def';assert.throws(()=>normalizeNpmSbom(b),/Conflicting package hash/);});

import {validateNpmSbom} from './validate-npm-sbom.mjs';
test('bundled CycloneDX schema rejects invalid type, timestamp and URI without network',async()=>{
 const bom={bomFormat:'CycloneDX',specVersion:'1.5',version:1,components:[{type:'library',name:'example',version:'1'}]};await validateNpmSbom(bom);
 await assert.rejects(validateNpmSbom({...bom,components:[{type:'invalid',name:'example'}]}),/schema validation failed/);
 await assert.rejects(validateNpmSbom({...bom,metadata:{timestamp:'not-a-date'}}),/schema validation failed/);
 await assert.rejects(validateNpmSbom({...bom,externalReferences:[{type:'website',url:'bad uri with spaces'}]}),/schema validation failed/);
});
