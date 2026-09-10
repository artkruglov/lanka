/** Portable connection data only. Never accepts native commands, profiles or runtime paths. */
export function companionConnection(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['format','url','token','sessionId','expiresAt'].includes(k)))throw Error('Invalid companion connection');
 const {format,url,token,sessionId,expiresAt}=input;
 if(format!=='lanka-companion-connection/v1'||typeof url!=='string'||typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)||typeof sessionId!=='string'||!/^[a-f0-9-]{36}$/.test(sessionId)||typeof expiresAt!=='string'||!Number.isFinite(Date.parse(expiresAt)))throw Error('Invalid companion connection');
 const endpoint=new URL(url);if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!/^\/mcp\/organizations\/[a-f0-9-]{36}$/.test(endpoint.pathname)||!(endpoint.protocol==='https:'||endpoint.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)))throw Error('Invalid companion endpoint');
 return {format:'lanka-companion-connection/v1',url:endpoint.href,token,sessionId,expiresAt};
}
