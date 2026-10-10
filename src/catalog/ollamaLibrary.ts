import { parseSizeString } from "../lib/units";
import { cleanText, decodeEntities } from "./sanitize";

// Parsers for official ollama.com HTML pages (library index, search, family tags page).
// The site has no documented JSON catalog API, so parsing is defensive: every field is
// optional and failures produce empty results rather than invented values.

export interface LibraryEntry {
  name: string;
  description: string;
  capabilities: string[]; // e.g. vision, tools, thinking, embedding, audio
  sizes: string[]; // size badges, e.g. ["1b","4b"]
  cloud: boolean;
  pulls?: string;
  tagCount?: number;
  updated?: string;
}

export function parseLibraryIndex(html: string): LibraryEntry[] {
  const out: LibraryEntry[] = [];
  const parts = html.split(/<li\s[^>]*>/).slice(1);
  for (const part of parts) {
    const m = /href="\/library\/([a-z0-9._-]+)"/i.exec(part);
    if (!m) continue;
    const name = m[1];
    const desc = /<p class="[^"]*break-words[^"]*">([\s\S]*?)<\/p>/.exec(part)?.[1] ?? "";
    const caps: string[] = [];
    const sizes: string[] = [];
    let cloud = false;
    const badge = /<span\s+class="inline-flex items-center rounded-md bg-([^\s"]+)[^"]*">([^<]+)<\/span>/g;
    let b: RegExpExecArray | null;
    while ((b = badge.exec(part))) {
      const bg = b[1];
      const text = b[2].trim().toLowerCase();
      if (bg.includes("ddf4ff")) sizes.push(text);
      else if (bg.startsWith("cyan") || text === "cloud") cloud = cloud || text === "cloud";
      else caps.push(text);
    }
    const pulls = /<span\s*>([\d.]+[KMB]?)<\/span>\s*<span class="hidden sm:flex">&nbsp;Pulls/.exec(part)?.[1];
    const tags = /<span\s*>(\d+)<\/span>\s*<span class="hidden sm:flex">&nbsp;Tags/.exec(part)?.[1];
    const updated = /title="([^"]+UTC)"/.exec(part)?.[1];
    out.push({
      name,
      description: cleanText(desc, 300),
      capabilities: [...new Set(caps)],
      sizes,
      cloud,
      pulls,
      tagCount: tags ? Number(tags) : undefined,
      updated,
    });
  }
  // de-duplicate by name (index pages can repeat entries)
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)));
}

export interface TagRow {
  tag: string; // full "family:tag"
  name: string; // part after ":"
  digest?: string; // 12-hex short digest shown on the page
  sizeBytes: number | null; // download size (decimal GB on page), null for cloud
  contextTokens: number | null;
  inputs: string[]; // e.g. ["text","image"]
  cloud: boolean;
}

export function parseContextLabel(s: string): number | null {
  const m = /^([\d.]+)\s*([KM])?$/i.exec(s.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult = m[2]?.toUpperCase() === "M" ? 1024 * 1024 : m[2]?.toUpperCase() === "K" ? 1024 : 1;
  return Math.round(n * mult);
}

export function parseTagsPage(html: string): TagRow[] {
  const rows: TagRow[] = [];
  const re = /<input class="command hidden" value="([^"]+)"\s*\/?>/g;
  const hits: { tag: string; idx: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) hits.push({ tag: decodeEntities(m[1]), idx: m.index });
  hits.forEach((h, i) => {
    const chunk = html.slice(h.idx, hits[i + 1]?.idx ?? h.idx + 6000);
    const ps = [...chunk.matchAll(/<p\s+class="col-span-2[^"]*">([\s\S]*?)<\/p>/g)].map((x) => x[1]);
    const sizeText = ps[0] ? cleanText(ps[0]) : "";
    const ctxText = ps[1] ? cleanText(ps[1]) : "";
    const inputText = /<div class="col-span-2[^"]*">\s*([^<]+?)\s*<\/div>/.exec(chunk)?.[1] ?? "";
    const digest = /font-mono text-\[11px\]">([0-9a-f]{12})</.exec(chunk)?.[1];
    const sizeBytes = sizeText ? parseSizeString(sizeText) : null;
    const name = h.tag.includes(":") ? h.tag.split(":")[1] : h.tag;
    rows.push({
      tag: h.tag,
      name,
      digest,
      sizeBytes,
      contextTokens: ctxText ? parseContextLabel(ctxText) : null,
      inputs: inputText
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      cloud: sizeBytes == null || /(^|[-:])cloud$/.test(name),
    });
  });
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.tag) ? false : (seen.add(r.tag), true)));
}

/** Tags that belong to a listed size variant, e.g. variant "4b" → "4b", "4b-it-q8_0", … */
export function tagsForVariant(rows: TagRow[], variant: string): TagRow[] {
  const v = variant.toLowerCase();
  return rows.filter((r) => !r.cloud && (r.name === v || r.name.startsWith(`${v}-`)));
}

/** Summary text on a family page. */
export function parseFamilySummary(html: string): string {
  return cleanText(/<span id="summary-content">([\s\S]*?)<\/span>/.exec(html)?.[1] ?? "", 400);
}

/** Quantization hinted by a tag name, e.g. "4b-it-q8_0" → "q8_0". */
export function quantFromTagName(name: string): string | null {
  const m = /(?:^|-)(q\d(?:_[0-9a-z]+)*|fp16|bf16|f16|mxfp4|fp8)$/i.exec(name);
  return m ? m[1] : null;
}
