import type {BrowserPrincipal} from './browser-identity';
import type {OidcBrowserAuth} from './oidc-browser-auth';

/** There is deliberately no fallback to local owner config or proxy identity headers.
 * A product handler must resolve authorized membership for this principal separately.
 */
export function withBrowserIdentity(auth:OidcBrowserAuth,handler:(request:Request,principal:BrowserPrincipal)=>Promise<Response>) {
 return async(request:Request):Promise<Response>=>{
  try {
   const response=await auth.handle(request);if(response)return response;
   const principal=await auth.authenticate(request);
   if(!principal)return Response.json({error:'Войдите в аккаунт.'},{status:401,headers:{'Cache-Control':'no-store'}});
   const expected=request.headers.get('x-lanka-page-user');
   if(expected&&expected!==principal.userId)return Response.json({code:'ACCOUNT_CHANGED',error:'В этой вкладке открыт другой аккаунт. Войдите в прежний аккаунт, чтобы продолжить.'},{status:409,headers:{'Cache-Control':'no-store'}});
   if(!['GET','HEAD'].includes(request.method)&&request.headers.get('origin')!==auth.config.origin)
    return Response.json({error:'Запрос должен быть отправлен из приложения.'},{status:403,headers:{'Cache-Control':'no-store'}});
   return await handler(request,principal);
  }catch {
   return Response.json({error:'Сервис временно недоступен.'},{status:503,headers:{'Cache-Control':'no-store'}});
  }
 };
}
