import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {Pool} from 'pg';
import {z} from 'zod';
import {applySelfHostedMigrations} from '../lib/adapters/postgres/schema';
import {provisionOrganization} from '../lib/adapters/postgres/organization-access';
const args=process.argv.slice(2);
function file(flag:string){const i=args.indexOf(flag);if(i<0||!args[i+1]||!isAbsolute(args[i+1]))throw Error(`Pass ${flag} with an absolute JSON file path`);return args[i+1];}
if(args.length!==4||args.filter(a=>a==='--config').length!==1||args.filter(a=>a==='--request').length!==1)throw Error('Usage: provision-organization --config /absolute/database.json --request /absolute/organization.json');
let pool:Pool|undefined;
try {
 // Config may be the private local config; only its database connection is consumed.
 const config=z.object({connection:z.object({host:z.string().min(1),port:z.number().int().positive().max(65535),database:z.string().min(1),user:z.string().min(1),password:z.string().optional(),ssl:z.union([z.literal(true),z.object({ca:z.string().optional(),rejectUnauthorized:z.literal(true).optional()}).strict()]).optional()}).strict()}).parse(JSON.parse(await readFile(file('--config'),'utf8')));
 const request=JSON.parse(await readFile(file('--request'),'utf8'));
 pool=new Pool({...config.connection,max:2,connectionTimeoutMillis:5000});
 await applySelfHostedMigrations(pool);process.stdout.write(JSON.stringify(await provisionOrganization(pool,request))+'\n');
}
catch {process.stderr.write('Организация не создана: проверьте подключение, существующую identity владельца и уникальность запроса/slug.\n');process.exitCode=1;}
finally {await pool?.end();}
