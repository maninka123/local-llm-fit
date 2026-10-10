import type { LibraryEntry } from "./ollamaLibrary";
import { searchOllama } from "./ollamaOfficial";
import { searchHf, type HfSearchHit } from "./huggingface";
import { safeModelName } from "./sanitize";
import { canReachOllamaCom } from "../platform/bridge";

// Arbitrary model lookup. Only the user's search terms leave the machine — never hardware data.

export type LookupQuery =
  | { kind: "ollama_url"; family: string; tag?: string }
  | { kind: "hf_id"; id: string }
  | { kind: "text"; text: string; sizeHintB?: number; activeHintB?: number };

export function parseLookupQuery(raw: string): LookupQuery | null {
  const q = raw.trim();
  if (!q || q.length > 200) return null;
  try {
    const u = new URL(q);
    if (u.hostname === "ollama.com") {
      const m = /^\/library\/([a-z0-9._-]+)(?::([a-z0-9._-]+))?/i.exec(decodeURIComponent(u.pathname));
      if (m) return { kind: "ollama_url", family: m[1].toLowerCase(), tag: m[2] };
    }
    if (u.hostname === "huggingface.co") {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 2 && safeModelName(`${parts[0]}/${parts[1]}`)) return { kind: "hf_id", id: `${parts[0]}/${parts[1]}` };
    }
    return null;
  } catch {
    /* not a URL */
  }
  if (/^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(q)) return { kind: "hf_id", id: q };
  if (/^[a-z0-9._-]+:[a-z0-9._-]+$/i.test(q)) {
    const [family, tag] = q.split(":");
    return { kind: "ollama_url", family: family.toLowerCase(), tag };
  }
  const size = /\b(\d+(?:\.\d+)?)\s*b\b/i.exec(q);
  const active = /\ba(\d+(?:\.\d+)?)b\b/i.exec(q);
  const text = q.replace(/[^\w\s.:-]/g, " ").replace(/\s+/g, " ").trim();
  return { kind: "text", text, sizeHintB: size ? parseFloat(size[1]) : undefined, activeHintB: active ? parseFloat(active[1]) : undefined };
}

export interface LookupCandidates {
  ollama: LibraryEntry[];
  hf: HfSearchHit[];
  errors: string[];
}

export async function searchCandidates(q: LookupQuery): Promise<LookupCandidates> {
  const errors: string[] = [];
  const text = q.kind === "text" ? q.text : q.kind === "hf_id" ? q.id : q.family;
  const ollamaTerm = q.kind === "text" ? q.text.split(" ")[0] : text;
  const [o, h] = await Promise.allSettled([
    q.kind === "hf_id" ? Promise.resolve([] as LibraryEntry[]) : searchOllama(ollamaTerm),
    // Ollama-style queries skip Hugging Face, except where ollama.com can't be reached (the browser).
    q.kind === "ollama_url" && canReachOllamaCom() ? Promise.resolve([] as HfSearchHit[]) : searchHf(q.kind === "hf_id" ? q.id : text),
  ]);
  if (o.status === "rejected") errors.push(`Ollama search failed: ${(o.reason as Error).message}`);
  if (h.status === "rejected") errors.push(`Hugging Face search failed: ${(h.reason as Error).message}`);
  let ollama = o.status === "fulfilled" ? o.value : [];
  if (q.kind === "ollama_url") ollama = ollama.filter((e) => e.name === q.family).concat(ollama.filter((e) => e.name !== q.family)).slice(0, 8);
  return { ollama: ollama.slice(0, 8), hf: h.status === "fulfilled" ? h.value.slice(0, 8) : [], errors };
}
