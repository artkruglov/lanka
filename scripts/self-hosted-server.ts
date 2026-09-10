import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {Pool} from 'pg';
import {z} from 'zod';
import {OidcBrowserAuth,oidcBrowserConfigSchema} from '../lib/server/oidc-browser-auth';
import {PostgresBrowserIdentityStore} from '../lib/adapters/postgres/browser-identity';
import {PostgresOrganizationAccess} from '../lib/adapters/postgres/organization-access';
import {createCorporateApplication,corporateNodeHandler} from '../lib/server/corporate-http';
import {assertSelfHostedSchema,SelfHostedSchemaError} from '../lib/adapters/postgres/schema';
const path=process.argv[process.argv.indexOf('--config')+1];
if(!process.argv.includes('--config')||!path?.startsWith('/'))throw Error('Pass --config with an absolute private configuration path.');
let pool:Pool|undefined;
try {
 const config=z.object({format:z.literal('lanka-self-hosted/v1'),auth:oidcBrowserConfigSchema,runtimeRoot:z.string().startsWith('/'),
  host:z.enum(['127.0.0.1','0.0.0.0']).default('127.0.0.1'),port:z.number().int().min(1).max(65535).default(4318),
  connection:z.object({host:z.string(),port:z.number().int(),database:z.string(),user:z.string(),password:z.string().optional(),ssl:z.union([z.literal(true),z.object({ca:z.string().optional(),rejectUnauthorized:z.literal(true).optional()}).strict()]).optional()}).strict(),
 }).strict().parse(JSON.parse(await readFile(path,'utf8')));
 pool=new Pool({...config.connection,max:15,connectionTimeoutMillis:5000});pool.on('error',()=>{});
 // Runtime never creates a default owner or runs migrations. Operator provisioning is separate.
 await assertSelfHostedSchema(pool);
 // Unicode title search must not inherit a database initialized with C locale.
 await pool.query(`SELECT lower('ПЛАН' COLLATE "und-x-icu")`);
 const identity=new PostgresBrowserIdentityStore(pool),auth=await OidcBrowserAuth.open(config.auth,identity),access=new PostgresOrganizationAccess(pool);
 const app=createCorporateApplication(auth,access,{runtimeRoot:config.runtimeRoot,assetRoot:resolve(import.meta.dirname),uiRefresh:process.env.LANKA_UI_REFRESH==='1'}),server=createServer(corporateNodeHandler(app,config.auth.origin));
 server.requestTimeout=30_000;server.headersTimeout=10_000;
 await new Promise<void>((ready,reject)=>{server.once("error",reject);server.listen(config.port,config.host,()=>{server.removeListener("error",reject);ready();});});
 process.stdout.write(`Lanka corporate server ready on port ${config.port}; TLS origin is configured.\n`);
 const cleanup=setInterval(()=>void identity.cleanup().catch(()=>{}),300_000);cleanup.unref();
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{clearInterval(cleanup);server.close(()=>{void pool!.end().finally(()=>process.exit(0));});});
}catch(error) {await pool?.end();process.stderr.write(error instanceof SelfHostedSchemaError?error.message+'\n':'Corporate server could not start. Check private configuration, migrations, database and OIDC provider.\n');process.exitCode=1;}
