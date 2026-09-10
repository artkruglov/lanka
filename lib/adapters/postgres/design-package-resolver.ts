import type {PoolClient} from 'pg';
import {captureInstalledDesign} from '../../design-packages/capture';
import {saveDesignPackageIn,loadDesignPackageIn} from './design-package-storage';
/** Internal installation capture; never accepts renderer bytes from an agent or browser. */
export async function saveInstalledDesignIn(c:PoolClient,tenant:string,profile:'focus-v2'|'focus-v3'){
 const captured=await captureInstalledDesign(profile);
 return saveDesignPackageIn(c,tenant,captured.manifest,captured.blobs);
}
/** Exact lookup, never fall back to the currently installed template. Caller authorises tenant. */
export async function resolveDesignPackageIn(c:PoolClient,tenant:string,digest:string,profile:'focus-v2'|'focus-v3'){
 const stored=await loadDesignPackageIn(c,tenant,digest);
 if(!stored)throw Error('Выбранная версия шаблона недоступна.');
 if(stored.manifest.profile!==profile)throw Error('Версия относится к другому шаблону.');
 if(stored.manifest.componentSchema!=='lanka-scene/v1')throw Error('Версия компонентов шаблона не поддерживается.');
 return stored;
}
