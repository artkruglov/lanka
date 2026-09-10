export type Actor = { id: string; email: string };
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function actorFrom(req: Request): Actor {
  const id = req.headers.get("oai-authenticated-user-id"),
    email = req.headers.get("oai-authenticated-user-email");
  if (!id || !email)
    throw new AppError(401, "Войдите в аккаунт, чтобы продолжить.");
  return { id, email: email.toLowerCase() };
}
export function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin || origin !== new URL(req.url).origin)
    throw new AppError(403, "Запрос должен быть отправлен из приложения.");
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    throw new AppError(415, "Ожидается JSON.");
}
export async function jsonBody(req: Request, max = 500_000) {
  if (Number(req.headers.get("content-length") || 0) > max)
    throw new AppError(413, "Слишком большой запрос.");
  const stream = req.body;
  if (!stream) throw new AppError(400, "Пустой запрос.");
  const reader = stream.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new AppError(413, "Слишком большой запрос.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppError(400, "Некорректный JSON.");
  }
}
export function errorResponse(e: unknown) {
  if (e instanceof AppError)
    return Response.json({ error: e.message }, { status: e.status });
  if (e instanceof Error && e.name === "ZodError")
    return Response.json(
      { error: "Данные не соответствуют схеме презентации." },
      { status: 400 },
    );
  if (e instanceof Error && /D1_ERROR|SQLITE|UNIQUE constraint/.test(e.message))
    return Response.json(
      {
        error:
          "Не удалось сохранить: данные изменились или эта версия уже выпущена. Обновите презентацию.",
      },
      { status: 409 },
    );
  console.error(
    "studio request failed",
    e instanceof Error ? e.message : "Unknown failure",
  );
  return Response.json(
    {
      error: e instanceof Error ? e.message : "Не удалось выполнить действие.",
    },
    { status: 400 },
  );
}
