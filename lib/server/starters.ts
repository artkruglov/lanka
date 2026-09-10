import seed from "@/lib/examples/lanka-sales.json";
import focus2Seed from "@/lib/examples/lanka-sales-focus-v2.json";
import focus3Seed from "@/lib/examples/lanka-sales-focus-v3.json";
import { createDeck, getDeck } from "./store";
import { fingerprint, lookupReceipt } from "./idempotency";
import { validateDoc } from "@/lib/domain/model";
import { materialInputsSchema } from "@/lib/domain/material-input";
import { AppError, type Actor } from "./auth";
const starters={
  "lanka-sales":{seed,requestId:"d7a9eff8-8f91-4cee-8932-a5b9810361db"},
  "lanka-sales-focus-v2":{seed:focus2Seed,requestId:"460bd1c0-96f5-4683-86a7-213947db4885"},
  "lanka-sales-focus-v3":{seed:focus3Seed,requestId:"ae0bb608-a2ae-4ac4-983e-da0ba312f3a2"},
} as const;
/** Reopen the owner's copy, isolate other owners. Only bundled product examples. */
export async function openStarter(actor:Actor,slug:unknown) {
  if(typeof slug!=="string"||!Object.hasOwn(starters,slug))throw new AppError(404,"Пример недоступен.");
  const starter=starters[slug as keyof typeof starters];
  const receipt={action:"starter.open",requestId:starter.requestId,actorId:actor.id,fingerprint:await fingerprint({starter:slug})};
  const reopen=async()=>{const r=await lookupReceipt(receipt);return r?getDeck(actor,r.deckId):null;};
  const existing=await reopen();if(existing)return existing;
  try{return await createDeck(actor,validateDoc(starter.seed.doc),receipt,undefined,materialInputsSchema.parse(starter.seed.materials));}
  catch(error){const concurrent=await reopen();if(concurrent)return concurrent;throw error;}
}
