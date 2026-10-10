// Pluggable HTTP transport for metadata fetches. The desktop app routes through the Rust
// backend (host allowlist); the web preview uses the Vite dev proxy; scripts/tests use fetch.
// Only metadata is fetched (HTML pages, JSON, and small byte ranges of GGUF headers).

export interface HttpRequest {
  url: string;
  accept?: string;
  /** Inclusive end byte for a Range request starting at 0. */
  rangeEnd?: number;
  binary?: boolean;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  text?: string;
  bytes?: Uint8Array;
}

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export const ALLOWED_HOSTS = ["ollama.com", "registry.ollama.ai", "huggingface.co"];

export function assertAllowedUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (u.protocol !== "https:") throw new Error("Only https URLs are allowed");
  if (!ALLOWED_HOSTS.includes(u.hostname)) throw new Error(`Host not allowed: ${u.hostname}`);
  return u;
}

export const fetchTransport =
  (rewrite?: (url: string) => string): Transport =>
  async (req) => {
    const headers: Record<string, string> = {};
    if (req.accept) headers.Accept = req.accept;
    if (req.rangeEnd != null) headers.Range = `bytes=0-${req.rangeEnd}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), req.timeoutMs ?? 20000);
    try {
      const res = await fetch(rewrite ? rewrite(req.url) : req.url, { headers, signal: ctl.signal });
      if (req.binary) {
        // Never read more than requested even if the server ignores Range.
        const limit = (req.rangeEnd ?? 4 * 1024 * 1024) + 1;
        const reader = res.body?.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        if (reader) {
          while (total < limit) {
            const { done, value } = await reader.read();
            if (done || !value) break;
            chunks.push(value);
            total += value.length;
          }
          await reader.cancel().catch(() => undefined);
        }
        const out = new Uint8Array(Math.min(total, limit));
        let off = 0;
        for (const c of chunks) {
          const take = Math.min(c.length, out.length - off);
          out.set(c.subarray(0, take), off);
          off += take;
          if (off >= out.length) break;
        }
        return { status: res.status, bytes: out };
      }
      return { status: res.status, text: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  };

let transport: Transport = fetchTransport();
export const setTransport = (t: Transport) => {
  transport = t;
};

export async function httpText(url: string, accept?: string): Promise<string> {
  assertAllowedUrl(url);
  const r = await transport({ url, accept });
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text ?? "";
}

export async function httpJson<T>(url: string, accept?: string): Promise<T> {
  const t = await httpText(url, accept ?? "application/json");
  return JSON.parse(t) as T;
}

export async function httpBytes(url: string, rangeEnd: number): Promise<Uint8Array> {
  assertAllowedUrl(url);
  const r = await transport({ url, rangeEnd, binary: true });
  if (r.status !== 200 && r.status !== 206) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.bytes ?? new Uint8Array();
}
