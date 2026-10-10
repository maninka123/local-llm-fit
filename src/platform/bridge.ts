import { fetchTransport, setTransport, type Transport } from "../catalog/net";
import type { HardwareReport } from "../domain/types";
import { fetchOllamaTransport, OllamaClient, type MemorySample, type OllamaTransport } from "./ollamaLocal";

// Runtime bridge. Desktop (Tauri): everything goes through the Rust backend.
// Browser preview: demo hardware, Vite dev proxy for metadata, direct fetch to local Ollama.

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
/** Static hosting (GitHub Pages): no dev proxy is available. */
export const isStaticHosting = (): boolean => import.meta.env.VITE_STATIC_HOSTING === "1";

let invokeFn: Invoke | null = null;
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!invokeFn) {
    const core = await import("@tauri-apps/api/core");
    invokeFn = core.invoke as Invoke;
  }
  return invokeFn<T>(cmd, args);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const tauriTransport: Transport = async (req) => {
  const r = await invoke<{ status: number; text?: string; bytesB64?: string; link?: string }>("http_get", {
    url: req.url,
    accept: req.accept ?? null,
    rangeEnd: req.rangeEnd ?? null,
    binary: !!req.binary,
  });
  return { status: r.status, text: r.text ?? undefined, bytes: r.bytesB64 ? b64ToBytes(r.bytesB64) : undefined, link: r.link ?? undefined };
};

const PROXY: [string, string][] = [
  ["https://ollama.com", "/__proxy/ollama-com"],
  ["https://registry.ollama.ai", "/__proxy/ollama-registry"],
];

export function initNetwork() {
  if (isTauri()) setTransport(tauriTransport);
  else if (isStaticHosting()) setTransport(fetchTransport());
  else setTransport(fetchTransport((url) => PROXY.reduce((u, [from, to]) => (u.startsWith(from) ? to + u.slice(from.length) : u), url)));
}

/** Whether live ollama.com lookups can work in this environment. */
export const canReachOllamaCom = () => isTauri() || !isStaticHosting();

export async function probeHardware(): Promise<HardwareReport | null> {
  if (!isTauri()) return null;
  return invoke<HardwareReport>("probe_hardware");
}

export async function sampleMemory(): Promise<MemorySample> {
  if (!isTauri()) {
    return { ramUsedBytes: null, vramUsedBytes: null };
  }
  const s = await invoke<{ ramUsedBytes: number | null; vramUsedBytes: number | null }>("sample_memory");
  return { ramUsedBytes: s.ramUsedBytes, vramUsedBytes: s.vramUsedBytes };
}

const tauriOllama: OllamaTransport = {
  request: (method, path, body) => invoke("ollama_request", { method, path, body: body ?? null }),
  async stream(path, body, onLine) {
    const { Channel } = await import("@tauri-apps/api/core");
    const ch = new Channel<Record<string, unknown>>();
    let err: unknown = null;
    ch.onmessage = (m) => {
      try {
        onLine(m);
      } catch (e) {
        err = e;
      }
    };
    await invoke("ollama_stream", { path, body, onEvent: ch });
    if (err) throw err;
  },
};

let client: OllamaClient | null = null;
export function ollama(): OllamaClient {
  if (!client) {
    client = new OllamaClient(
      isTauri() ? tauriOllama : fetchOllamaTransport(isStaticHosting() ? "http://127.0.0.1:11434" : "/__proxy/ollama-local"),
    );
  }
  return client;
}

export async function exportFile(name: string, contents: string, mime: string): Promise<string> {
  if (isTauri()) return invoke<string>("export_file", { fileName: name, contents });
  const blob = new Blob([contents], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return name;
}
