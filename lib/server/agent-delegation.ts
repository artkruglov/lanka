import type {BridgeTaskAddress} from '../project/bridge-task';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {BrowserPrincipal} from './browser-identity';
/** The credential is authenticated again inside every authorized operation's transaction. */
export type DelegatedPrincipal={kind:'delegated';tokenHash:string;task?:BridgeTaskAddress};
export type CorporatePrincipal=BrowserPrincipal|DelegatedPrincipal;
export type DelegationScope={write?:boolean}&({documentId:string;capability:'read'|'comment'|'propose'}|{workspace:true;capability:'read'|'comment'|'propose'|'create'|'organize'});
export function delegatedPrincipal(secret:string):DelegatedPrincipal {
 z.string().regex(/^[a-f0-9]{64}$/).parse(secret);
 return {kind:'delegated',tokenHash:createHash('sha256').update(secret).digest('hex')};
}
