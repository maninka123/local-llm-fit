// External model-card / registry content is DATA, never instructions or markup.
// Strip tags, collapse whitespace, cap length. React escapes text on render as well.

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " ", "&#x27;": "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|nbsp|#39|#x27);/g, (m) => ENTITIES[m] ?? m);
}

export function cleanText(s: string | null | undefined, max = 400): string {
  if (!s) return "";
  const t = decodeEntities(s.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]*>/g, " "))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Allow only https links to known model sources; anything else is dropped. */
export function safeSourceUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    if (url.protocol !== "https:") return null;
    if (!["ollama.com", "huggingface.co", "registry.ollama.ai", "github.com"].includes(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Model identifiers: letters, digits, . _ - : / only. */
export function safeModelName(s: string): string | null {
  const t = s.trim();
  return /^[A-Za-z0-9._:/-]{1,128}$/.test(t) ? t : null;
}
