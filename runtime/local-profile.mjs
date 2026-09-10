import {mkdir,realpath,chmod} from 'node:fs/promises';
import {resolve} from 'node:path';

/** A private profile per local owner. No credentials or configuration are copied. */
export async function dedicatedProfile(runtimeRoot,tenantId,ownerId) {
  if(![tenantId,ownerId].every(v=>/^[a-f0-9-]{36}$/i.test(v)))throw Error('Invalid local owner');
  const home=resolve(runtimeRoot,'codex-profiles',tenantId,ownerId);
  await mkdir(home,{recursive:true,mode:0o700});
  if(await realpath(home)!==home)throw Error('Dedicated Codex profile must use a real directory');
  await chmod(home,0o700);
  return home;
}
