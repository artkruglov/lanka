import { env } from "cloudflare:workers";
export function database() {
  if (!env.DB) throw new Error("Хранилище временно недоступно.");
  return env.DB;
}
export function bucket() {
  if (!env.BUCKET) throw new Error("Хранилище файлов временно недоступно.");
  return env.BUCKET;
}
