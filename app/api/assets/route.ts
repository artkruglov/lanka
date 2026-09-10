import { database, bucket } from "@/db";
import { actorFrom, AppError, errorResponse } from "@/lib/server/auth";
import { getDeck, allow, saveDeck } from "@/lib/server/store";
import { changedContent, uid, type Source } from "@/lib/domain/model";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  try {
    const actor = actorFrom(req),
      id = new URL(req.url).searchParams.get("id");
    if (!id) throw new AppError(400, "Не указан файл.");
    const row = await database()
      .prepare(
        "SELECT deck_id, key, content_type, name FROM assets WHERE id = ?",
      )
      .bind(id)
      .first<{
        deck_id: string;
        key: string;
        content_type: string;
        name: string;
      }>();
    if (!row) throw new AppError(404, "Файл недоступен.");
    await getDeck(actor, row.deck_id);
    const file = await bucket().get(row.key);
    if (!file) throw new AppError(404, "Файл недоступен.");
    return new Response(file.body, {
      headers: {
        "Content-Type": row.content_type,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `${row.content_type.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(req: Request) {
  let key: string | undefined;
  try {
    const actor = actorFrom(req);
    if (req.headers.get("origin") !== new URL(req.url).origin)
      throw new AppError(403, "Загрузите файл из приложения.");
    const deckId = req.headers.get("x-deck-id"),
      revision = Number(req.headers.get("x-deck-revision"));
    if (!deckId) throw new AppError(400, "Не указана презентация.");
    const old = await getDeck(actor, deckId);
    allow(old, ["owner", "editor"]);
    if (old.state.revision !== revision)
      throw new AppError(409, "Обновите презентацию перед загрузкой.");
    if (old.state.sources.length >= 30)
      throw new AppError(
        400,
        "В пилоте поддерживается до 30 файлов на презентацию.",
      );
    if (Number(req.headers.get("content-length") || 0) > 5_000_000)
      throw new AppError(413, "Максимальный размер файла — 5 МБ.");
    const reader = req.body?.getReader();
    if (!reader) throw new AppError(400, "Пустой файл.");
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 5_000_000) {
        await reader.cancel();
        throw new AppError(413, "Максимальный размер файла — 5 МБ.");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let off = 0;
    chunks.forEach((c) => {
      bytes.set(c, off);
      off += c.length;
    });
    if (!size) throw new AppError(400, "Файл пуст.");
    const contentType =
      req.headers.get("content-type")?.split(";")[0] || "text/plain";
    const image = contentType === "image/png" || contentType === "image/jpeg";
    const document = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ].includes(contentType);
    if (
      document &&
      (contentType === "application/pdf"
        ? new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-"
        : !(bytes[0] === 80 && bytes[1] === 75))
    )
      throw new AppError(400, "Содержимое файла не соответствует формату.");
    if (
      !image &&
      !document &&
      !["text/plain", "text/markdown", "text/csv", "application/json"].includes(
        contentType,
      )
    )
      throw new AppError(
        415,
        "Поддерживаются PDF, DOCX, PPTX, XLSX, PNG, JPEG, TXT, Markdown, CSV и JSON.",
      );
    if (
      contentType === "image/png" &&
      ![137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)
    )
      throw new AppError(400, "Некорректный PNG.");
    if (
      contentType === "image/jpeg" &&
      !(bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    )
      throw new AppError(400, "Некорректный JPEG.");
    let excerpt = "";
    if (!image && !document) {
      if (size > 200_000)
        throw new AppError(
          413,
          "Текстовый источник должен быть меньше 200 КБ.",
        );
      try {
        excerpt = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new AppError(400, "Сохраните текст в UTF-8.");
      }
    }
    const name = decodeURIComponent(req.headers.get("x-file-name") || "source")
      .replace(/[\r\n]/g, "")
      .slice(0, 180);
    const id = uid(),
      sha256 = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
      createdAt = new Date().toISOString();
    key = `${old.owner}/${old.id}/${id}`;
    await bucket().put(key, bytes, { httpMetadata: { contentType } });
    await database()
      .prepare(
        "INSERT INTO assets (id, deck_id, owner, key, name, kind, sha256, content_type, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        id,
        deckId,
        actor.id,
        key,
        name,
        image ? "image" : document ? "document" : "text",
        sha256,
        contentType,
        excerpt.slice(0, 12000),
        createdAt,
      )
      .run();
    const source: Source = {
      id,
      name,
      kind: image ? "image" : document ? "document" : "text",
      sha256,
      contentType,
      excerpt: excerpt.slice(0, 12000),
      createdAt,
    };
    const state = structuredClone(old.state);
    state.sources.push(source);
    changedContent(state);
    const deck = await saveDeck(actor, old, state, "source.upload");
    return Response.json({ deck, source });
  } catch (e) {
    if (key) {
      await bucket()
        .delete(key)
        .catch(() => {});
      await database()
        .prepare("DELETE FROM assets WHERE key = ?")
        .bind(key)
        .run()
        .catch(() => {});
    }
    return errorResponse(e);
  }
}
