// Small RFC 4180 CSV parser/serializer (quoted fields, escaped quotes, CRLF, embedded newlines).

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (ch === "\n" || ch === "\r") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      if (ch === "\r" && src[i + 1] === "\n") i++;
      i++;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export function parseCsvObjects(text: string): { header: string[]; records: Record<string, string>[]; widthErrors: number[] } {
  const rows = parseCsv(text);
  if (rows.length === 0) return { header: [], records: [], widthErrors: [] };
  const header = rows[0].map((h) => h.trim());
  const widthErrors: number[] = [];
  const records = rows.slice(1).map((r, idx) => {
    if (r.length !== header.length) widthErrors.push(idx + 2);
    return Object.fromEntries(header.map((h, j) => [h, (r[j] ?? "").trim()]));
  });
  return { header, records, widthErrors };
}

const needsQuote = /[",\r\n]/;
export function toCsv(header: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return needsQuote.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header.join(","), ...rows.map((r) => header.map((h) => esc(r[h])).join(","))].join("\n") + "\n";
}
