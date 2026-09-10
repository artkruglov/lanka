import {corporateMcp} from './corporate-mcp';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Readable} from 'node:stream';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {OidcBrowserAuth} from './oidc-browser-auth';
import {withBrowserIdentity} from './browser-auth-gate';
import type {PostgresOrganizationAccess} from '../adapters/postgres/organization-access';
import {organizationApi} from './organization-api';
import {OrganizationAccessError} from './organization-access';
import {OrganizationDocumentView} from '../adapters/postgres/document-view';
import {PostgresResourceAccess} from '../adapters/postgres/resource-access';

const policy="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const html=(body:string,status=200)=>new Response(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lanka</title></head><body>${body}</body></html>`,{status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':policy}});
/** Same-origin self-hosted HTTP application. Site and loopback identity adapters are not consulted. */
export function createCorporateApplication(auth:OidcBrowserAuth,access:PostgresOrganizationAccess,{assetRoot,runtimeRoot,uiRefresh=false}:{assetRoot:string;runtimeRoot:string;uiRefresh?:boolean}) {
 const api=organizationApi(access,runtimeRoot),mcp=corporateMcp(new PostgresResourceAccess(access),auth.config.origin,runtimeRoot);
 const shared=new OrganizationDocumentView(new PostgresResourceAccess(access));
 const protectedHandler=withBrowserIdentity(auth,async(req,principal)=>{
  const url=new URL(req.url);
  if(url.pathname.startsWith('/api/'))return api(req,principal);
  if(req.method!=='GET')return new Response(null,{status:405});
  if(url.pathname==='/auth/complete')return html('<main><h1>Вход выполнен</h1><p>Вернитесь в исходную вкладку Lanka и нажмите «Я вошёл — продолжить».</p><a href="/">Открыть организации</a></main>');
  const statics:Record<string,[string,string]>={'/project.js':['project.js','text/javascript; charset=utf-8'],'/project.css':['project.css','text/css; charset=utf-8']};
  statics['/fonts/focus3-fonts.zip']=['focus3-fonts.zip','application/zip'];
  for(const file of ['DejaVuSans.ttf','DejaVuSans-Bold.ttf','IBMPlexSans-Regular.ttf','IBMPlexSans-SemiBold.ttf','IBMPlexMono-Medium.ttf'])statics['/fonts/'+file]=['../public/fonts/'+file,'font/ttf'];
  if(statics[url.pathname]){const [file,type]=statics[url.pathname];return new Response(new Uint8Array(await readFile(resolve(assetRoot,file))),{headers:{'Content-Type':type,'Cache-Control':'no-store','Cross-Origin-Resource-Policy':'same-origin','X-Content-Type-Options':'nosniff'}});}
  const route=url.pathname.match(/^\/organizations\/([a-f0-9-]{36})(?:\/documents\/([a-f0-9-]{36}))?$/);
  if(url.pathname!=='/'&&!route)return html('<h1>Страница не найдена</h1><a href="/">Организации</a>',404);
  let documentMode='editor';
  if(route)try {if(route[2]){const view=await shared.read(principal,route[1],route[2]);documentMode=view.permission.isOwner?'editor':'view';}else await access.withTenant(principal,route[1],async()=>{});}
   catch(error){if(error instanceof OrganizationAccessError)return html('<h1>Нет доступа</h1><p>Организация или презентация недоступны этому аккаунту.</p><a href="/">Организации</a>',error.status);throw error;}
  return new Response(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lanka — презентации</title><link rel="stylesheet" href="/project.css"></head><body data-ui="${uiRefresh?'refresh':'classic'}" data-workspace="true" data-auth="oidc" data-user-id="${principal.userId}" data-document-mode="${documentMode}"><div id="root"></div><script src="/project.js" defer></script></body></html>`,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':policy,'Referrer-Policy':'no-referrer'}});
 });
 return async(req:Request)=>{
  const u=new URL(req.url);
  const route=u.pathname.match(/^\/mcp\/organizations\/([a-f0-9-]{36})(?:\/documents\/([a-f0-9-]{36}))?$/);
  if(route)return mcp(req,route[1],route[2]);
  const response=await protectedHandler(req);
  if(response.status===401&&req.method==='GET'&&!u.pathname.startsWith('/api/')&&!u.pathname.startsWith('/auth/')&&u.pathname!=='/project.js'&&u.pathname!=='/project.css'&&!u.pathname.startsWith('/fonts/')) {
   const target='/auth/login?returnTo='+encodeURIComponent(u.pathname+(u.search==='?chat'?'?chat':''));
   return html(`<main style="max-width:520px;margin:15vh auto;padding:24px;font-family:system-ui"><h1>Lanka</h1><p>Войдите, чтобы открыть организации и презентации.</p><a href="${target}">Войти через компанию</a></main>`);
  }
  return response;
 };
}

/** Reverse proxy must preserve the configured Host; Forwarded headers cannot select an identity or origin. */
export function corporateNodeHandler(app:(req:Request)=>Promise<Response>,origin:string) {
 return async(req:IncomingMessage,res:ServerResponse)=>{
  if(req.headers.host!==new URL(origin).host||!req.url?.startsWith('/')||req.url.startsWith('//')||req.url.includes('\\')){res.writeHead(403);res.end('Host denied');return;}
  const controller=new AbortController();req.once('aborted',()=>controller.abort());
  try {
   const headers=new Headers();for(const [k,v] of Object.entries(req.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(','):v);
   const init:RequestInit={method:req.method,headers,signal:controller.signal};
   if(req.method!=='GET'&&req.method!=='HEAD')Object.assign(init,{body:Readable.toWeb(req),duplex:'half'});
   const response=await app(new Request(new URL(req.url,origin),init));
   res.statusCode=response.status;for(const [k,v] of response.headers)if(k!=='set-cookie')res.setHeader(k,v);
   const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('Set-Cookie',cookies);
   if(response.body){res.end(Buffer.from(await response.arrayBuffer()));}else res.end();
  }catch{if(!res.headersSent)res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"error":"Сервис временно недоступен."}');}
 };
}
