import type {DatabasePool} from './database-pool';
import {createHash, randomUUID} from 'node:crypto';
import type {BrowserIdentityStore, BrowserPrincipal, LoginAttempt, VerifiedIdentity} from '../../server/browser-identity';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Only hashes of browser credentials are persisted. OIDC tokens are discarded. */
export class PostgresBrowserIdentityStore implements BrowserIdentityStore {
 constructor(readonly pool: DatabasePool) {}
 async begin(deployment: string, state: string, browser: string, login: LoginAttempt) {
  await this.pool.query(`INSERT INTO lanka.browser_logins
   (deployment,state_hash,browser_hash,verifier,nonce,return_to,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,now()+interval '5 minutes')`,
   [deployment,hash(state),hash(browser),login.verifier,login.nonce,login.returnTo]);
 }
 async consume(deployment: string, state: string, browser: string) {
  const r = await this.pool.query(`DELETE FROM lanka.browser_logins
   WHERE deployment=$1 AND state_hash=$2 AND browser_hash=$3 AND expires_at>now()
   RETURNING verifier,nonce,return_to`, [deployment,hash(state),hash(browser)]);
  return r.rowCount ? {verifier:r.rows[0].verifier,nonce:r.rows[0].nonce,returnTo:r.rows[0].return_to} : null;
 }
 async establish(deployment: string, identity: VerifiedIdentity, token: string, oldToken: string|null, expiresAt: Date) {
  const c = await this.pool.connect();
  try {
   await c.query('BEGIN');
   const r = await c.query(`INSERT INTO lanka.auth_identities(id,issuer,subject,display_name,verified_email)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(issuer,subject) DO UPDATE
    SET display_name=excluded.display_name,verified_email=excluded.verified_email
    RETURNING id,auth_epoch,disabled`,[randomUUID(),identity.issuer,identity.subject,identity.name,identity.email]);
   const user = r.rows[0];
   if(user.disabled) throw Error('Identity is disabled');
   await c.query(`INSERT INTO lanka.browser_sessions(token_hash,id,deployment,identity_id,auth_epoch,expires_at,idle_expires_at)
    VALUES($1,$2,$3,$4,$5,$6,least($6,now()+interval '30 minutes'))`,
    [hash(token),randomUUID(),deployment,user.id,user.auth_epoch,expiresAt]);
   if(oldToken) await c.query('DELETE FROM lanka.browser_sessions WHERE deployment=$1 AND token_hash=$2',[deployment,hash(oldToken)]);
   await c.query('COMMIT');
  } catch(error) {await c.query('ROLLBACK');throw error;} finally {c.release();}
 }
 async authenticate(deployment: string, token: string): Promise<BrowserPrincipal|null> {
  const r = await this.pool.query(`UPDATE lanka.browser_sessions s
   SET idle_expires_at=least(s.expires_at,now()+interval '30 minutes')
   FROM lanka.auth_identities i WHERE s.identity_id=i.id AND NOT i.disabled
   AND s.auth_epoch=i.auth_epoch AND s.deployment=$1 AND s.token_hash=$2
   AND s.expires_at>now() AND s.idle_expires_at>now()
   RETURNING s.id,s.expires_at,i.id AS user_id,i.issuer,i.subject`,[deployment,hash(token)]);
  if(!r.rowCount) return null;
  const row=r.rows[0];
  return {kind:'oidc',userId:row.user_id,issuer:row.issuer,subject:row.subject,sessionId:row.id,expiresAt:row.expires_at.toISOString()};
 }
 async logout(deployment: string, token: string) {
  await this.pool.query('DELETE FROM lanka.browser_sessions WHERE deployment=$1 AND token_hash=$2',[deployment,hash(token)]);
 }
 /** Maintenance is explicit; callers do not launch a timer or steal process locks. */
 async cleanup() {
  await this.pool.query('DELETE FROM lanka.browser_logins WHERE expires_at<=now()');
  await this.pool.query('DELETE FROM lanka.browser_sessions WHERE expires_at<=now() OR idle_expires_at<=now()');
 }
}
