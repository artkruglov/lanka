/** URLs identify a document, never grant access. No forwarded host headers. */
export function deckPath(id: string, mode: "edit" | "present" = "edit") {
  return `/presentations/${encodeURIComponent(id)}${mode === "present" ? "?mode=present" : ""}`;
}
export function deckLinks(origin: string, id: string) {
  const base = new URL(origin);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password)
    throw new Error("Invalid application origin");
  return { editorUrl: new URL(deckPath(id), base.origin).href,
    presentationUrl: new URL(deckPath(id,"present"),base.origin).href,
    access: "existing-permissions" as const };
}
