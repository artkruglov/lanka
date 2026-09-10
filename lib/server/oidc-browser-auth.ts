import * as oidc from 'openid-client';
import {createHash, randomBytes} from 'node:crypto';
import {z} from 'zod';
import type {BrowserIdentityStore, BrowserPrincipal} from './browser-identity';

const httpsUrl = z.string().url().refine(value => {
 const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash;
}, 'An explicit HTTPS URL is required');
export const oidcBrowserConfigSchema=z.object({
 origin:httpsUrl.refine(value=>new URL(value).origin===value,'Use an origin without a trailing slash'),
 issuer:httpsUrl, clientId:z.string().min(1).max(500),clientSecret:z.string().min(1).max(4000),
 idTokenAlgorithm:z.enum(['RS256','ES256']).default('RS256'),
 backchannelOrigins:z.array(httpsUrl.refine(value=>new URL(value).origin===value)).max(8).default([]),
 sessionSeconds:z.number().int().min(60).max(28800).default(28800),
}).strict();
type Config=z.infer<typeof oidcBrowserConfigSchema>;
const secret=()=>randomBytes(32).toString('base64url');
const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
const loginCookie='__Host-lanka_login', sessionCookie='__Host-lanka_session';
function cookie(request:Request,name:string) {
 const values=(request.headers.get('cookie')??'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'='));
 if(values.length!==1)return null;
 const value=values[0].slice(name.length+1);return tokenPattern.test(value)?value:null;
}
const setCookie=(name:string,value:string,seconds:number)=>`${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
const headers=()=>new Headers({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
const fail=(status:number)=>Response.json({error:status===401?'Войдите в аккаунт.':'Не удалось завершить вход. Начните его заново.'},{status,headers:headers()});
const safeReturn=(value:string|null)=>value&&(value==='/auth/complete'||/^\/(?:documents\/[a-f0-9-]{36}|organizations\/[a-f0-9-]{36}(?:\/documents\/[a-f0-9-]{36})?)?(?:\?chat)?$/.test(value))?value:'/';

/** Node self-hosted adapter. Never consumes trusted Site headers or tenant claims.
 * The deployment must resolve tenant membership after this authentication boundary.
 */
export class OidcBrowserAuth {
 readonly deployment:string;
 private constructor(readonly config:Config,private client:oidc.Configuration,private store:BrowserIdentityStore) {
  this.deployment=createHash('sha256').update(JSON.stringify([config.origin,config.issuer,config.clientId])).digest('hex');
 }
 static async open(input:unknown,store:BrowserIdentityStore,transport:typeof fetch=fetch) {
  const config=oidcBrowserConfigSchema.parse(input);
  const allowed=new Set([new URL(config.issuer).origin,...config.backchannelOrigins]);
  const client=await oidc.discovery(new URL(config.issuer),config.clientId,
   {id_token_signed_response_alg:config.idTokenAlgorithm},oidc.ClientSecretBasic(config.clientSecret),{
    timeout:5,execute:[oidc.enableNonRepudiationChecks],
    [oidc.customFetch]:async(url,options)=>{
     const target=new URL(url);
     if(target.protocol!=='https:'||target.username||target.password||!allowed.has(target.origin))throw Error('OIDC endpoint is outside configured origins');
     // Never follow redirects with client credentials to a different endpoint.
     const {body,...init}=options;
     // Copy typed bytes to a plain ArrayBuffer (Node and Worker fetch typings differ).
     return transport(url,{...init,body:body instanceof Uint8Array?new Uint8Array(body).buffer:body,redirect:'error'});
    },
   });
  const meta=client.serverMetadata();
  for(const value of [meta.authorization_endpoint,meta.token_endpoint,meta.jwks_uri]) {
   if(!value)throw Error('Incomplete OIDC metadata');
   const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||!allowed.has(u.origin))throw Error('Unapproved OIDC endpoint');
  }
  return new OidcBrowserAuth(config,client,store);
 }
 async authenticate(request:Request):Promise<BrowserPrincipal|null> {
  if(new URL(request.url).origin!==this.config.origin)return null;
  const token=cookie(request,sessionCookie);
  return token?this.store.authenticate(this.deployment,token):null;
 }
 /** Mount before product routes; null means a route is not an auth endpoint. */
 async handle(request:Request):Promise<Response|null> {
  const url=new URL(request.url),known=['/auth/login','/auth/callback','/auth/session','/auth/logout'];
  if(!known.includes(url.pathname))return null;
  if(url.origin!==this.config.origin)return fail(403);
  if(request.method!==(url.pathname==='/auth/logout'?'POST':'GET'))return new Response(null,{status:405,headers:headers()});
  if(url.pathname==='/auth/session') {
   const principal=await this.authenticate(request);return principal?Response.json({principal},{headers:headers()}):fail(401);
  }
  if(url.pathname==='/auth/logout') {
   if(request.headers.get('origin')!==this.config.origin||request.headers.get('sec-fetch-site')==='cross-site')return fail(403);
   const token=cookie(request,sessionCookie);if(token)await this.store.logout(this.deployment,token);
   const h=headers();h.append('Set-Cookie',setCookie(sessionCookie,'',0));h.append('Set-Cookie',setCookie(loginCookie,'',0));
   return new Response(null,{status:204,headers:h});
  }
  if(url.pathname==='/auth/login') {
   const state=secret(),browser=secret(),nonce=oidc.randomNonce(),verifier=oidc.randomPKCECodeVerifier();
   const location=oidc.buildAuthorizationUrl(this.client,{redirect_uri:this.config.origin+'/auth/callback',response_type:'code',scope:'openid profile email',
    state,nonce,code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256'});
   await this.store.begin(this.deployment,state,browser,{nonce,verifier,returnTo:safeReturn(url.searchParams.get('returnTo'))});
   const h=headers();h.set('Location',location.href);h.append('Set-Cookie',setCookie(loginCookie,browser,300));
   return new Response(null,{status:302,headers:h});
  }
  const state=url.searchParams.get('state'),browser=cookie(request,loginCookie);
  if(!state||!tokenPattern.test(state)||!browser||url.searchParams.getAll('state').length!==1)return fail(400);
  const login=await this.store.consume(this.deployment,state,browser);
  if(!login)return fail(400);
  // Consumed before network I/O: failed/replayed callbacks cannot reuse a grant.
  try {
   const tokens=await oidc.authorizationCodeGrant(this.client,url,{expectedState:state,expectedNonce:login.nonce,pkceCodeVerifier:login.verifier,idTokenExpected:true});
   const claims=tokens.claims()!;
   if(typeof claims.sub!=='string'||!claims.sub||claims.sub.length>255||typeof claims.exp!=='number')throw Error('Invalid identity');
   const token=secret(),expiresAt=new Date(Math.min(claims.exp*1000,Date.now()+this.config.sessionSeconds*1000));
   if(expiresAt.getTime()<=Date.now())throw Error('Expired identity');
   await this.store.establish(this.deployment,{issuer:this.config.issuer,subject:claims.sub,
    name:typeof claims.name==='string'?claims.name.slice(0,200):null,
    email:claims.email_verified===true&&typeof claims.email==='string'?claims.email.slice(0,320):null},
    token,cookie(request,sessionCookie),expiresAt);
   const h=headers();h.set('Location',login.returnTo);h.append('Set-Cookie',setCookie(loginCookie,'',0));
   h.append('Set-Cookie',setCookie(sessionCookie,token,Math.max(1,Math.floor((expiresAt.getTime()-Date.now())/1000))));
   return new Response(null,{status:302,headers:h});
  } catch {return fail(400);} // Provider payloads, tokens and connection errors never reach the browser.
 }
}
