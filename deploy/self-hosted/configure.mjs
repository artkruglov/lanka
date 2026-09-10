import {mkdir,writeFile,rm} from 'node:fs/promises';import {randomBytes,randomUUID} from 'node:crypto';import {resolve,isAbsolute} from 'node:path';
// Local preparation only. No network, Docker, login, database or runtime startup.
const args=process.argv.slice(2);let created=false,directory;
try{
 if(args.length!==1||!isAbsolute(args[0]))throw Error('Pass a new absolute private directory.');directory=args[0];
 await mkdir(directory,{mode:0o700});created=true;
 const operator=randomBytes(32).toString('hex'),runtime=randomBytes(32).toString('hex'),connection={host:'db',port:5432,database:'lanka'};
 const files={'database-password':operator+'\n','operator.json':{connection:{...connection,user:'lanka_operator',password:operator}},'runtime-role.json':{role:'lanka_app',password:runtime},'lanka.json':{format:'lanka-self-hosted/v1',host:'0.0.0.0',port:4318,runtimeRoot:'/var/lib/lanka',connection:{...connection,user:'lanka_app',password:runtime},auth:{origin:'https://lanka.example.invalid',issuer:'https://idp.example.invalid',clientId:'REPLACE_WITH_CORPORATE_CLIENT_ID',clientSecret:'REPLACE_WITH_CORPORATE_CLIENT_SECRET'}},'organization.json':{requestId:randomUUID(),slug:'company',name:'Company',ownerUserId:'REPLACE_AFTER_FIRST_OIDC_LOGIN'}};
 // Individual Compose bind-mounted files must be readable by uid 1000; parent directory is private.
 for(const [name,value] of Object.entries(files))await writeFile(resolve(directory,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o644});
 console.log('Private configuration prepared. Set real HTTPS OIDC settings before startup; no services were started.');
}catch(e){if(created)await rm(directory,{recursive:true,force:true});console.error(e.message);process.exitCode=1;}
