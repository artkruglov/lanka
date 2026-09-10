const docCommands = new Set([
  "create",
  "save",
  "brand",
  "propose",
  "accept",
  "reject",
  "comment",
  "resolve",
  "approve",
  "release",
  "restore",
  "share",
]);
/** One network retry only for operations that carry a stable idempotency key. */
export async function clientRequest<T>(
  path: string,
  body?: unknown,
): Promise<T> {
  let input = body as Record<string, unknown> | undefined;
  const keyed = Boolean(
    input &&
      ((path === "/api/studio" && docCommands.has(String(input.action))) ||
        (path === "/api/agent" && input.action === "start") ||
        path === "/api/tasks"),
  );
  if (keyed)
    input = { ...input, requestId: input?.requestId ?? crypto.randomUUID() };
  const options: RequestInit = input
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }
    : { cache: "no-store" };
  let response: Response;
  try {
    response = await fetch(path, options);
  } catch (error) {
    if (!keyed) throw error;
    response = await fetch(path, options);
  }
  let data: T & { error?: string };
  try {
    data = (await response.json()) as T & { error?: string };
  } catch {
    throw new Error(
      "Сервер вернул неожиданный ответ. Обновите страницу и проверьте состояние документа.",
    );
  }
  if (!response.ok)
    throw new Error(data.error || "Не удалось выполнить действие.");
  return data;
}
export async function proposalRequestId(value: unknown) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(value)),
    ),
  );
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes.slice(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
