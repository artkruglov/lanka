import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {Pool} from 'pg';
import {z} from 'zod';
import {assertSelfHostedSchema} from '../lib/adapters/postgres/schema';
const args=process.argv.slice(2);let pool:Pool|undefined;
try{
 if(args.length!==4||args[0]!=='--config'||args[2]!=='--request'||!isAbsolute(args[1])||!isAbsolute(args[3]))throw Error('Arguments required');
 const config=z.object({connection:z.object({host:z.string().min(1),port:z.number().int().positive().max(65535),database:z.string().min(1),user:z.string().min(1),password:z.string().optional(),ssl:z.union([z.literal(true),z.object({ca:z.string().optional(),rejectUnauthorized:z.literal(true).optional()}).strict()]).optional()}).strict()}).parse(JSON.parse(await readFile(args[1],'utf8')));
 const request=z.object({role:z.literal('lanka_app'),password:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(JSON.parse(await readFile(args[3],'utf8')));
 pool=new Pool({...config.connection,max:1,connectionTimeoutMillis:5000});
 await assertSelfHostedSchema(pool);
 const c=await pool.connect();try{
  await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtextextended('lanka:runtime-role',0))");
  const current=await c.query("SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='lanka_app'");
  if(current.rowCount){const r=current.rows[0];
   const owned=await c.query("SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=$1 AND deptype='o' LIMIT 1",[r.oid]);
   if(owned.rowCount)throw Error('Existing runtime role owns database objects');if(r.rolsuper||r.rolcreatedb||r.rolcreaterole||r.rolreplication||r.rolbypassrls||(await c.query('SELECT 1 FROM pg_auth_members WHERE member=$1',[r.oid])).rowCount)throw Error('Existing role has unexpected privileges');}
  // Password is operator-supplied, restricted to generated hex, and never printed.
  await c.query(`${current.rowCount?'ALTER':'CREATE'} ROLE lanka_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${request.password}'`);
  await c.query('GRANT USAGE ON SCHEMA lanka TO lanka_app');
  await c.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA lanka TO lanka_app');
  await c.query('GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA lanka TO lanka_app');
  await c.query('ALTER DEFAULT PRIVILEGES IN SCHEMA lanka GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO lanka_app');
  await c.query('ALTER DEFAULT PRIVILEGES IN SCHEMA lanka GRANT USAGE,SELECT,UPDATE ON SEQUENCES TO lanka_app');
  await c.query('REVOKE INSERT,UPDATE,DELETE ON lanka.schema_migrations FROM lanka_app');
  await c.query('REVOKE UPDATE,DELETE ON lanka.publications,lanka.publication_blobs,lanka.publication_artifacts,lanka.publication_withdrawals,lanka.publication_receipts,lanka.publication_audit,lanka.revision_dependency_snapshots,lanka.revision_dependency_blobs,lanka.design_packages,lanka.design_package_assets,lanka.revision_design_packages FROM lanka_app');
  await c.query('COMMIT');
 }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}
 process.stdout.write('Runtime role configured. Migration registry is read-only for lanka_app.\n');
}catch{process.stderr.write('Runtime role setup failed. Check operator credentials, completed migrations and private role request. No credentials are printed.\n');process.exitCode=1;}
finally{await pool?.end();}
