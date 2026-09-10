export class LocalRequestError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message); }
}

/** Only the loopback editor uses this transport. Corporate authentication is separate. */
export function createLocalTransport(fetcher: typeof fetch = (...args) => fetch(...args)) {
  let refresh: Promise<void> | null = null;
  let generation = 0;
  async function errorBody(response: Response): Promise<Record<string, unknown> | null> {
    const value: unknown = await response.clone().json().catch(() => null);
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  }
  async function send(path: string, init?: RequestInit) {
    try { return await fetcher(path, init); }
    catch (error) {
      if (init?.signal?.aborted) throw error;
      throw new LocalRequestError("Нет связи с локальной Lanka. Восстанавливаем подключение; введённый текст остаётся у вас.");
    }
  }
  return async function localFetch(path: string, init?: RequestInit): Promise<Response> {
    if (!path.startsWith("/api/")) throw new Error("Local API path required");
    const started = generation;
    let response = await send(path, init);
    if (response.status === 403) {
      const error = await errorBody(response);
      if (error?.code === "LOCAL_SESSION_EXPIRED") {
        if (started === generation) {
          if (!refresh) refresh = (async () => {
            const page = await send("/", {cache: "no-store", credentials: "same-origin"});
            if (!page.ok || !page.headers.get("content-type")?.includes("text/html"))
              throw new LocalRequestError("Не удалось восстановить локальное подключение. Повторите действие.", page.status);
            await page.body?.cancel();
            generation++;
          })().finally(() => { refresh = null; });
          await refresh;
        }
        // The expiry response precedes command execution. Replay exactly once, with identical bytes.
        response = await send(path, init);
      }
    }
    if (!response.ok) {
      const error = await errorBody(response);
      const message = typeof error?.error === "string" ? error.error : typeof error?.message === "string" ? error.message : null;
      throw new LocalRequestError(message || "Lanka не смогла выполнить действие. Повторите после восстановления подключения.", response.status);
    }
    return response;
  };
}

export function createCorporateTransport(context:BrowserContext,fetcher:typeof fetch=(...args)=>fetch(...args),onAuthRequired:()=>void=()=>window.dispatchEvent(new Event('lanka:auth-required'))) {
 return async(path:string,init?:RequestInit)=>{
  const headers=new Headers(init?.headers);headers.set('X-Lanka-Page-User',context.userId);
  let response:Response;
  try{response=await fetcher(scopedApiPath(path,context),{...init,headers,credentials:'same-origin'});}
  catch(error){if(init?.signal?.aborted)throw error;throw new LocalRequestError('Нет связи с Lanka. Правки остаются в редакторе.');}
  if(!response.ok){const error=await response.clone().json().catch(()=>({})) as {code?:string;error?:string};if(response.status===401||error.code==='ACCOUNT_CHANGED')onAuthRequired();throw new LocalRequestError(error.error||'Не удалось выполнить действие.',response.status,error.code);}
  return response;
 };
}
let corporate:{key:string;send:ReturnType<typeof createCorporateTransport>}|null=null;
const loopback=createLocalTransport();
export const localFetch=(path:string,init?:RequestInit)=>{
 const context=corporateContext();if(!context)return loopback(path,init);
 const key=JSON.stringify(context);if(corporate?.key!==key)corporate={key,send:createCorporateTransport(context)};
 return corporate.send(path,init);
};
import {corporateContext,scopedApiPath,type BrowserContext} from './browser-context';
