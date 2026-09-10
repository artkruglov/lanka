/** An authenticated human is not yet an authorized tenant member. */
export type BrowserPrincipal = {
 kind: 'oidc'; userId: string; issuer: string; subject: string;
 sessionId: string; expiresAt: string;
};
export type LoginAttempt = {verifier: string; nonce: string; returnTo: string};
export type VerifiedIdentity = {issuer: string; subject: string; name: string|null; email: string|null};
export interface BrowserIdentityStore {
 begin(deployment: string, state: string, browser: string, login: LoginAttempt): Promise<void>;
 consume(deployment: string, state: string, browser: string): Promise<LoginAttempt|null>;
 establish(deployment: string, identity: VerifiedIdentity, token: string, oldToken: string|null, expiresAt: Date): Promise<void>;
 authenticate(deployment: string, token: string): Promise<BrowserPrincipal|null>;
 logout(deployment: string, token: string): Promise<void>;
}
