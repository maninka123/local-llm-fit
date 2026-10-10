import { addEvidence, capabilitiesFromOllamaList, emptyCapabilities, mergeCapabilities } from "../domain/capabilities";
import { normalizeQuant } from "../domain/quant";
import type { ArchMeta, BenchmarkRecord, CapEvidence, Capabilities, ModelVariant } from "../domain/types";
import { parseParamLabel } from "../lib/units";
import { useCasesFor, developerFor } from "../catalog/families";

// Local Ollama HTTP API client (https://github.com/ollama/ollama/blob/main/docs/api.md).
// Transport is injected: Rust backend in the desktop app, fetch in the web preview.
// Nothing here runs inference or downloads unless a UI action with explicit consent calls it.

export interface OllamaTransport {
  request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T>;
  /** Streams NDJSON lines; resolves when the stream ends. */
  stream(path: string, body: unknown, onLine: (obj: Record<string, unknown>) => void): Promise<void>;
}

export const OLLAMA_PATHS = ["/api/version", "/api/tags", "/api/show", "/api/ps", "/api/generate", "/api/pull"] as const;

export interface OllamaTagModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  modified_at?: string;
  details?: { format?: string; family?: string; families?: string[]; parameter_size?: string; quantization_level?: string };
}

export interface OllamaShow {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
  details?: OllamaTagModel["details"];
  parameters?: string;
  projector_info?: Record<string, unknown>;
}

export interface OllamaPsModel {
  name: string;
  model: string;
  size: number;
  size_vram: number;
  digest: string;
  context_length?: number;
  expires_at?: string;
}

export function fetchOllamaTransport(base: string): OllamaTransport {
  return {
    async request(method, path, body) {
      const res = await fetch(base + path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error(`Ollama ${path}: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
      return (await res.json()) as never;
    },
    async stream(path, body, onLine) {
      const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok || !res.body) throw new Error(`Ollama ${path}: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) onLine(JSON.parse(line));
        }
      }
      if (buf.trim()) onLine(JSON.parse(buf));
    },
  };
}

export class OllamaClient {
  constructor(private t: OllamaTransport) {}
  version = () => this.t.request<{ version: string }>("GET", "/api/version");
  tags = () => this.t.request<{ models: OllamaTagModel[] }>("GET", "/api/tags");
  show = (model: string) => this.t.request<OllamaShow>("POST", "/api/show", { model });
  ps = () => this.t.request<{ models: OllamaPsModel[] }>("GET", "/api/ps");
  unload = (model: string) => this.t.request("POST", "/api/generate", { model, keep_alive: 0 });
  generateStream = (body: Record<string, unknown>, onLine: (o: Record<string, unknown>) => void) => this.t.stream("/api/generate", { ...body, stream: true }, onLine);
  pull = (model: string, onLine: (o: Record<string, unknown>) => void) => this.t.stream("/api/pull", { model, stream: true }, onLine);
}

// ------------------------------------------------------------------ metadata mapping

export function archFromModelInfo(mi: Record<string, unknown> | undefined, checkedAt: string): ArchMeta | null {
  if (!mi) return null;
  const a = String(mi["general.architecture"] ?? "");
  if (!a) return null;
  const num = (k: string): number | undefined => {
    const v = mi[`${a}.${k}`];
    if (typeof v === "number") return v;
    if (Array.isArray(v)) {
      const ns = v.filter((x): x is number => typeof x === "number");
      return ns.length ? ns.reduce((s, x) => s + x, 0) / ns.length : undefined;
    }
    return undefined;
  };
  const heads = num("attention.head_count");
  const embed = num("embedding_length");
  const keyDim = num("attention.key_length") ?? (embed && heads ? embed / heads : undefined);
  return {
    archName: a,
    layers: num("block_count"),
    kvHeads: num("attention.head_count_kv") ?? heads,
    keyDim,
    valueDim: num("attention.value_length") ?? keyDim,
    embeddingLength: embed,
    contextLength: num("context_length"),
    slidingWindow: num("attention.sliding_window"),
    expertCount: num("expert_count"),
    expertUsedCount: num("expert_used_count"),
    kvLoraRank: num("attention.kv_lora_rank"),
    provenance: "verified",
    source: "Local Ollama /api/show",
    checkedAt,
  };
}

/** Build/enrich a catalog model from an installed Ollama model. */
export function modelFromInstalled(tag: OllamaTagModel, show: OllamaShow | null, existing: ModelVariant | undefined, checkedAt: string): ModelVariant {
  const [family, variant = "latest"] = tag.name.split(":");
  const arch = archFromModelInfo(show?.model_info, checkedAt);
  const paramCount = typeof show?.model_info?.["general.parameter_count"] === "number" ? (show!.model_info!["general.parameter_count"] as number) / 1e9 : null;
  const paramLabel = tag.details?.parameter_size ? parseParamLabel(tag.details.parameter_size) : null;
  const total = paramCount ?? paramLabel;
  const caps: Capabilities = show?.capabilities
    ? capabilitiesFromOllamaList(show.capabilities, "ollama_local", "Local Ollama /api/show", checkedAt)
    : emptyCapabilities();
  const projector = show?.projector_info && Object.keys(show.projector_info).length > 0;
  if (projector) caps.inputs.image = addEvidence(caps.inputs.image, { status: "verified_supported", scope: "ollama_local", source: "Local Ollama projector_info", checkedAt });
  const quantLabel = tag.details?.quantization_level ?? "unknown";

  const base: ModelVariant = existing ?? {
    id: tag.name.toLowerCase(),
    family,
    variant,
    displayName: tag.name,
    resolvedTag: tag.name,
    lookupCandidate: tag.name,
    developer: developerFor(family),
    origin: "ollama_local",
    totalParamsB: { value: null, provenance: "unknown" },
    activeParamsB: { value: null, provenance: "unknown" },
    architecture: { value: null, provenance: "unknown" },
    contextMax: { value: null, provenance: "unknown" },
    artifacts: [],
    arch: null,
    capabilities: emptyCapabilities(),
    useCases: useCasesFor(family, show?.capabilities?.includes("embedding") ? "embedding" : show?.capabilities?.includes("vision") ? "vision+text" : "text"),
    sourceUrls: [],
    lastVerified: null,
    notes: [],
  };

  const artifacts = base.artifacts.filter((a) => a.digest !== tag.digest.slice(0, 12) && a.source !== "Local Ollama install");
  artifacts.unshift({
    quant: normalizeQuant(quantLabel),
    quantLabel,
    tag: tag.name,
    digest: tag.digest.slice(0, 12),
    // /api/tags size is the total of all blobs; we cannot split weights vs projector here.
    weightBytes: tag.size,
    downloadBytes: tag.size,
    provenance: "verified",
    source: "Local Ollama install",
    checkedAt,
    isDefaultTag: true,
  });
  // Only one default per quant
  for (const a of artifacts.slice(1)) if (a.quant === artifacts[0].quant) a.isDefaultTag = false;

  return {
    ...base,
    resolvedTag: tag.name,
    installed: { name: tag.name, digest: tag.digest, sizeBytes: tag.size, quantLabel, parameterSize: tag.details?.parameter_size, modifiedAt: tag.modified_at },
    artifacts,
    arch: arch ?? base.arch,
    totalParamsB: total ? { value: +total.toFixed(3), provenance: "verified", source: "Local Ollama", checkedAt } : base.totalParamsB,
    architecture:
      arch?.expertCount && arch.expertCount > 1
        ? { value: "moe", provenance: "verified", source: "Local Ollama /api/show", checkedAt }
        : arch?.layers
          ? { value: "dense", provenance: "verified", source: "Local Ollama /api/show", checkedAt }
          : base.architecture,
    contextMax: arch?.contextLength ? { value: arch.contextLength, provenance: "verified", source: "Local Ollama /api/show", checkedAt } : base.contextMax,
    capabilities: mergeCapabilities(base.capabilities, caps),
    lastVerified: checkedAt,
  };
}

// ------------------------------------------------------------------ benchmark

export const BENCH_PROMPT =
  "Explain in about 120 words how a refrigerator keeps food cold. Use plain language and no lists.";

export interface MemorySample {
  ramUsedBytes: number | null;
  vramUsedBytes: number | null;
}

export interface BenchOptions {
  model: string;
  contextTokens: number;
  kind: "cold" | "warm";
  numPredict?: number;
  sampleMemory?: () => Promise<MemorySample>;
  onStatus?: (s: string) => void;
  meta: Pick<BenchmarkRecord, "digest" | "quantLabel" | "parameterSize" | "ollamaVersion" | "gpuName" | "driverVersion" | "osName" | "backend" | "powerSource" | "predictedClass" | "predictedTotalBytes">;
}

export const nsToSec = (ns: number) => ns / 1e9;

/** Pure: compute rates from Ollama's nanosecond durations. */
export function computeRates(final: Record<string, unknown>) {
  const g = (k: string) => (typeof final[k] === "number" ? (final[k] as number) : undefined);
  const evalCount = g("eval_count");
  const evalDur = g("eval_duration");
  const pCount = g("prompt_eval_count");
  const pDur = g("prompt_eval_duration");
  return {
    evalCount,
    evalDur,
    pCount,
    pDur,
    load: g("load_duration"),
    total: g("total_duration"),
    generationTokPerSec: evalCount && evalDur ? evalCount / nsToSec(evalDur) : undefined,
    promptTokPerSec: pCount && pDur ? pCount / nsToSec(pDur) : undefined,
  };
}

export function placementFromPs(p: OllamaPsModel | undefined): BenchmarkRecord["placement"] {
  if (!p || !p.size) return "unknown";
  if (p.size_vram >= p.size * 0.999) return "gpu_100";
  if (p.size_vram <= 0) return "cpu_100";
  return "mixed";
}

export async function runBenchmark(client: OllamaClient, o: BenchOptions): Promise<BenchmarkRecord> {
  const notes: string[] = [];
  const say = o.onStatus ?? (() => undefined);
  if (o.kind === "cold") {
    say("Unloading model for a cold start…");
    await client.unload(o.model).catch(() => notes.push("Could not unload the model first; cold numbers may be warm."));
  }
  let baseline: MemorySample = { ramUsedBytes: null, vramUsedBytes: null };
  let peak: MemorySample = { ramUsedBytes: null, vramUsedBytes: null };
  if (o.sampleMemory) baseline = await o.sampleMemory().catch(() => baseline);
  peak = { ...baseline };
  let sampling = true;
  const sampler = (async () => {
    while (sampling && o.sampleMemory) {
      const s = await o.sampleMemory().catch(() => null);
      if (s) {
        if (s.ramUsedBytes != null) peak.ramUsedBytes = Math.max(peak.ramUsedBytes ?? 0, s.ramUsedBytes);
        if (s.vramUsedBytes != null) peak.vramUsedBytes = Math.max(peak.vramUsedBytes ?? 0, s.vramUsedBytes);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  })();

  say(o.kind === "cold" ? "Loading model and generating…" : "Generating…");
  const t0 = performance.now();
  let ttft: number | undefined;
  let final: Record<string, unknown> = {};
  try {
    await client.generateStream(
      { model: o.model, prompt: BENCH_PROMPT, options: { temperature: 0, seed: 42, num_ctx: o.contextTokens, num_predict: o.numPredict ?? 160 } },
      (line) => {
        if (ttft == null && ((typeof line.response === "string" && line.response.length > 0) || (typeof line.thinking === "string" && line.thinking.length > 0))) {
          ttft = performance.now() - t0;
        }
        if (line.error) throw new Error(String(line.error));
        if (line.done) final = line;
      },
    );
  } finally {
    sampling = false;
    await sampler;
  }
  const wallMs = performance.now() - t0;
  const rates = computeRates(final);
  let ps: OllamaPsModel | undefined;
  try {
    ps = (await client.ps()).models.find((m) => m.name === o.model || m.model === o.model);
  } catch {
    notes.push("/api/ps unavailable; GPU residency unknown.");
  }
  notes.push("TTFT is measured from request start to the first streamed token (includes model load on cold runs).");
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    model: o.model,
    ...o.meta,
    contextTokens: o.contextTokens,
    temperature: 0,
    kind: o.kind,
    promptEvalCount: rates.pCount,
    promptEvalDurationNs: rates.pDur,
    evalCount: rates.evalCount,
    evalDurationNs: rates.evalDur,
    loadDurationNs: rates.load,
    totalDurationNs: rates.total,
    ttftMs: ttft,
    wallMs,
    generationTokPerSec: rates.generationTokPerSec,
    promptTokPerSec: rates.promptTokPerSec,
    baselineRamUsedBytes: baseline.ramUsedBytes ?? undefined,
    peakRamUsedBytes: peak.ramUsedBytes ?? undefined,
    baselineVramUsedBytes: baseline.vramUsedBytes ?? undefined,
    peakVramUsedBytes: peak.vramUsedBytes ?? undefined,
    residentBytes: ps?.size,
    residentVramBytes: ps?.size_vram,
    placement: placementFromPs(ps),
    notes,
  };
}

// ------------------------------------------------------------------ smoke tests (user-triggered)

// 64×64 solid red PNG (generated).
export const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwIqof2UTMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFj12qxUDxeFqrFAAAAABJRU5ErkJggg==";

export async function smokeTest(client: OllamaClient, model: string, kind: "text" | "image"): Promise<CapEvidence> {
  const checkedAt = new Date().toISOString();
  const body: Record<string, unknown> = {
    model,
    prompt: kind === "text" ? "Reply with the single word: ready" : "What is the main color of this image? Answer with one word.",
    options: { temperature: 0, num_predict: 16 },
  };
  if (kind === "image") body.images = [RED_PNG_BASE64];
  let out = "";
  try {
    await client.generateStream(body, (l) => {
      if (l.error) throw new Error(String(l.error));
      if (typeof l.response === "string") out += l.response;
    });
  } catch (e) {
    const msg = (e as Error).message;
    const unsupported = /does not support|not support images|vision/i.test(msg);
    return { status: unsupported ? "verified_unsupported" : "unknown", scope: "smoke_test", source: "Local smoke test", checkedAt, note: msg.slice(0, 200) };
  }
  if (kind === "text") return { status: out.trim() ? "verified_supported" : "unknown", scope: "smoke_test", source: "Local smoke test", checkedAt, note: `Reply: ${out.trim().slice(0, 60)}` };
  const ok = /red/i.test(out);
  return {
    status: ok ? "verified_supported" : "unknown",
    scope: "smoke_test",
    source: "Local smoke test",
    checkedAt,
    note: ok ? `Correctly described a red test image (“${out.trim().slice(0, 40)}”)` : `Reply did not identify the image (“${out.trim().slice(0, 40)}”); inconclusive`,
  };
}
