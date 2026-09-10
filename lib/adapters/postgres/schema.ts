import type {DatabasePool} from './database-pool';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const versions=['0001_chat','0002_chat_creation','0003_export_artifacts','0004_workspace_catalog','0005_revision_import_aliases','0006_browser_identity','0007_organization_membership','0008_native_catalog','0009_resource_access','0010_agent_runtime','0011_source_intakes','0012_agent_delegations','0013_delegated_proposals','0014_workspace_delegations','0015_agent_source_grants','0016_source_intake_deletions','0017_library_delegation','0018_folder_delegation','0019_shared_folder_delegation','0020_shared_creation','0021_document_reactions','0022_workspace_sessions','0023_agent_bridge','0024_bridge_results','0025_bridge_selection','0026_bridge_tasks','0027_bridge_executions','0028_bridge_quota','0029_publications','0030_publication_dependencies','0031_revision_dependencies','0032_revision_dependency_limit','0033_document_source_grants','0034_colleague_reviews','0035_design_packages','0036_revision_design_packages'];
// Exact pre-commit 0031 variant recovered from the creation command and verified
// against the installed receipt. Its sole SQL difference is 1.5 MB vs 3 MB;
// 0032 converges both. No receipt rewrite or general checksum bypass is allowed.
function matchesMigration(version:string,applied:unknown,expected:string){
 return applied===expected||(version==='0031_revision_dependencies'
  &&expected==='be2c730cd225937a43200335d5ef49b1c769f13f19d6ed4b30b7b44c81b51ef5'
  &&applied==='41fbed0778f8bf124e12d3b670ab04b027119dd5299a5f4a089a9e42564818fc');
}
async function requiredMigrations(){
 return Promise.all(versions.map(async version=>{const sql=await readFile(resolve(import.meta.dirname,`../db/self-hosted/${version}.sql`),'utf8');return {version,sql,checksum:createHash('sha256').update(sql).digest('hex')};}));
}
/** Read-only startup gate. Applying or repairing migrations remains an operator action. */
export class SelfHostedSchemaError extends Error {}
export async function assertSelfHostedSchema(pool:Pick<DatabasePool,'query'>){
 const migrations=await requiredMigrations(),result=await pool.query('SELECT version,checksum FROM lanka.schema_migrations');
 const applied=new Map(result.rows.map(row=>[row.version,row.checksum]));
 const invalid=migrations.filter(m=>!matchesMigration(m.version,applied.get(m.version),m.checksum)).map(m=>m.version);
 if(invalid.length)throw new SelfHostedSchemaError('Required schema migrations are missing or changed: '+invalid.join(', ')+'. Run installation migrations with operator credentials.');
 return {count:migrations.length,latest:migrations.at(-1)!.version};
}
/** Run with the installation's migration credentials, not a browser/user identity. */
export async function applySelfHostedMigrations(pool:DatabasePool) {
 const migrations=await requiredMigrations();
 const c=await pool.connect();
 try {
  await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtextextended('lanka:schema-migrations',0))");
  await c.query('CREATE SCHEMA IF NOT EXISTS lanka; CREATE TABLE IF NOT EXISTS lanka.schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const {version,sql,checksum} of migrations) {
   const current=await c.query('SELECT checksum FROM lanka.schema_migrations WHERE version=$1',[version]);
   if(current.rowCount&&!matchesMigration(version,current.rows[0].checksum,checksum))throw Error('Applied migration changed; add a new migration instead.');
   if(!current.rowCount){await c.query(sql);await c.query('INSERT INTO lanka.schema_migrations(version,checksum) VALUES($1,$2)',[version,checksum]);}
  }
  await c.query('COMMIT');
 }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}
}
