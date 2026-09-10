import widths from "./font-metrics.json";
const glyphs = widths as {
  regular: Record<string, number>;
  bold: Record<string, number>;
};
export function measure(text: string, size: number, bold = false) {
  return Array.from(text).reduce(
    (sum, c) =>
      sum +
      (glyphs[bold ? "bold" : "regular"][String(c.codePointAt(0))] ?? 0.7) *
        size,
    0,
  );
}
export function wrap(
  text: string,
  maxWidth: number,
  size: number,
  bold: boolean,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const token of paragraph.split(/\s+/)) {
      const trial = line ? line + " " + token : token;
      if (measure(trial, size, bold) <= maxWidth) {
        line = trial;
        continue;
      }
      if (line) {
        lines.push(line);
        line = "";
      }
      if (measure(token, size, bold) <= maxWidth) line = token;
      else
        for (const char of Array.from(token)) {
          if (measure(line + char, size, bold) > maxWidth) {
            lines.push(line);
            line = "";
          }
          line += char;
        }
    }
    lines.push(line);
  }
  return lines;
}
