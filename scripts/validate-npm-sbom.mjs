import {readFile} from 'node:fs/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {fullFormats} from 'ajv-formats/dist/formats.js';
const asciiFormat=name=>value=>{
 if(!/^[\x00-\x7f]*$/.test(value))return false;
 const rule=fullFormats[name];return typeof rule==='function'?rule(value):rule instanceof RegExp?rule.test(value):rule.validate(value);
};
let validator;
async function compile(){
 const ajv=new Ajv({strict:false,allErrors:true});addFormats(ajv);
 // Conservative subset: never silently accept unvalidated international URI/email values.
 ajv.addFormat('iri-reference',asciiFormat('uri-reference'));ajv.addFormat('idn-email',asciiFormat('email'));
 for(const file of ['spdx.schema.json','jsf-0.82.schema.json'])ajv.addSchema(JSON.parse(await readFile(new URL('../vendor/cyclonedx-1.5/'+file,import.meta.url))));
 return ajv.compile(JSON.parse(await readFile(new URL('../vendor/cyclonedx-1.5/bom-1.5.schema.json',import.meta.url))));
}
export async function validateNpmSbom(bom){
 if(bom?.specVersion!=='1.5')throw Error('Unsupported CycloneDX version; expected 1.5');
 validator??=compile();const check=await validator;
 if(!check(bom))throw Error('SBOM schema validation failed: '+JSON.stringify(check.errors.slice(0,3)));
}
