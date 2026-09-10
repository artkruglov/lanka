/** A local control capability stays in the browser and is scoped to this conversation.
 * @param {string} value
 * @param {string} sessionId
 * @param {string | undefined} [endpoint]
 */
export function companionPanelLink(value,sessionId,endpoint=undefined){
 if(typeof value!=='string'||value.length>2048||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sessionId))throw Error('Invalid local panel link');
 const url=new URL(value.trim());
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||! /^#[a-f0-9]{64}$/.test(url.hash))throw Error('Invalid local panel link');
 if([...url.searchParams.keys()].some(k=>!['sessionId','endpoint'].includes(k))||url.searchParams.getAll('sessionId').length>1||url.searchParams.has('sessionId')&&url.searchParams.get('sessionId')!==sessionId)throw Error('Wrong conversation');
 if(endpoint!==undefined){const target=new URL(endpoint);if(target.username||target.password||target.search||target.hash||!/^\/mcp\/organizations\/[a-f0-9-]{36}$/.test(target.pathname)||!(target.protocol==='https:'||target.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(target.hostname)))throw Error('Invalid Lanka endpoint');endpoint=target.href;}
 if(url.searchParams.getAll('endpoint').length>1||url.searchParams.has('endpoint')&&url.searchParams.get('endpoint')!==endpoint)throw Error('Wrong Lanka endpoint');
 if(endpoint!==undefined)url.searchParams.set('endpoint',endpoint);
 url.searchParams.set('sessionId',sessionId);return url.href;
}
