import type { DeckDoc } from "./model";

/** Object key order changes during schema parsing; it is not a document edit. */
export function sameDocument(a: DeckDoc, b: DeckDoc): boolean {
  const canonical = (doc: DeckDoc) =>
    JSON.stringify(doc, (_key, value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([x], [y]) =>
              x < y ? -1 : x > y ? 1 : 0,
            ),
          )
        : value,
    );
  return canonical(a) === canonical(b);
}

/** A save response must never replace text typed after that request started. */
export function afterSave(
  current: DeckDoc | null,
  sent: DeckDoc,
  saved: DeckDoc,
): DeckDoc | null {
  if (!current || current.id !== sent.id) return current;
  return sameDocument(current, sent) ? structuredClone(saved) : current;
}
