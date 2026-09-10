import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {Pool} from 'pg';
import {z} from 'zod';
import {applySelfHostedMigrations} from '../lib/adapters/postgres/schema';
const args=process.argv.slice(2);
let pool:Pool|undefined;
try {
 if(args.length!==2||args[0]!=='--config'||!isAbsolute(args[1]))throw Error('Configuration required');
 const config=z.object({connection:z.object({host:z.string().min(1),port:z.number().int().positive().max(65535),database:z.string().min(1),user:z.string().min(1),password:z.string().optional(),ssl:z.union([z.literal(true),z.object({ca:z.string().optional(),rejectUnauthorized:z.literal(true).optional()}).strict()]).optional()}).strict()}).parse(JSON.parse(await readFile(args[1],'utf8')));
 pool=new Pool({...config.connection,max:2,connectionTimeoutMillis:5000});
 await applySelfHostedMigrations(pool);
 await pool.query(`SELECT lower('ПЛАН' COLLATE "und-x-icu")`);
 process.stdout.write('Self-hosted schema is ready. No identity, organization or document was created.\n');
}catch {process.stderr.write('Schema setup failed. Check --config /absolute/database.json, PostgreSQL access and ICU support.\n');process.exitCode=1;}
finally {await pool?.end();}
