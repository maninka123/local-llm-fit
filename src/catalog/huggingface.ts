import { addEvidence, emptyCapabilities } from "../domain/capabilities";
import { normalizeQuant } from "../domain/quant";
import type { Artifact, ArchMeta, Capabilities, CapEvidence, ModelVariant } from "../domain/types";
import { httpJson } from "./net";
import { cleanText, safeModelName } from "./sanitize";
import { useCasesFor } from "./families";

// Hugging Face public API (no token): search, model info, config.json, file tree.

export interface HfSearchHit {
  id: string;
  downloads?: number;
  likes?: number;
  pipeline_tag?: string;
  tags?: string[];
}

export interface HfModelInfo {
  id: string;
  pipeline_tag?: string;
  tags?: string[];
  safetensors?: { total?: number; parameters?: Record<string, number> };
  gguf?: { total?: number; architecture?: string; context_length?: number };
  cardData?: { license?: string; base_model?: string | string[] };
  lastModified?: string;
}

export interface HfConfig {
  [k: string]: unknown;
  text_config?: HfConfig;
}

export async function searchHf(q: string, limit = 8): Promise<HfSearchHit[]> {
  return httpJson<HfSearchHit[]>(`https://huggingface.co/api/models?search=${encodeURIComponent(q)}&limit=${limit}&sort=downloads`);
}

export async function fetchHfModel(id: string): Promise<HfModelInfo> {
  if (!safeModelName(id)) throw new Error("Invalid Hugging Face model id");
  return httpJson<HfModelInfo>(`https://huggingface.co/api/models/${id}`);
}

export async function fetchHfConfig(id: string): Promise<HfConfig | null> {
  try {
    return await httpJson<HfConfig>(`https://huggingface.co/${id}/resolve/main/config.json`);
  } catch {
    return null;
  }
}

/** The listing API returns at most this many entries per page. */
export const HF_TREE_PAGE = 1000;

export async function fetchHfTree(id: string): Promise<{ path: string; size?: number; type?: string }[]> {
  try {
    return await httpJson(`https://huggingface.co/api/models/${id}/tree/main?recursive=true`);
  } catch {
    return [];
  }
}

const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function archFromConfig(cfg: HfConfig, source: string, sourceUrl: string, checkedAt: string): ArchMeta | null {
  const c = (cfg.text_config ?? cfg) as HfConfig;
  const layers = n(c.num_hidden_layers) ?? n(c.n_layer) ?? n(c.num_layers);
  const heads = n(c.num_attention_heads) ?? n(c.n_head);
  const hidden = n(c.hidden_size) ?? n(c.n_embd) ?? n(c.d_model);
  const kvHeads = n(c.num_key_value_heads) ?? heads;
  const headDim = n(c.head_dim) ?? (hidden && heads ? hidden / heads : undefined);
  if (!layers) return null;
  return {
    archName: typeof c.model_type === "string" ? c.model_type : undefined,
    layers,
    kvHeads,
    keyDim: headDim,
    valueDim: n(c.v_head_dim) ?? headDim,
    embeddingLength: hidden,
    contextLength: n(c.max_position_embeddings),
    slidingWindow: n(c.sliding_window) ?? undefined,
    expertCount: n(c.num_experts) ?? n(c.num_local_experts) ?? n(c.n_routed_experts),
    expertUsedCount: n(c.num_experts_per_tok) ?? n(c.moe_top_k),
    kvLoraRank: n(c.kv_lora_rank),
    vocabSize: n(c.vocab_size),
    provenance: "verified",
    source,
    sourceUrl,
    checkedAt,
  };
}

/**
 * Derive active parameters for standard MoE configs (Mixtral/Qwen-MoE/DeepSeek style):
 *   active ≈ total − moeLayers × (experts − usedPerToken) × 3 × hidden × expertFFN
 * Returns null whenever the config lacks any input (never guesses).
 */
export function deriveActiveParams(cfg: HfConfig, totalParams: number): { activeB: number; formula: string } | null {
  const c = (cfg.text_config ?? cfg) as HfConfig;
  const E = n(c.num_experts) ?? n(c.num_local_experts) ?? n(c.n_routed_experts);
  const k = n(c.num_experts_per_tok) ?? n(c.moe_top_k);
  const hidden = n(c.hidden_size);
  const L = n(c.num_hidden_layers);
  const ffn = n(c.moe_intermediate_size) ?? (n(c.num_local_experts) ? n(c.intermediate_size) : undefined);
  if (!E || !k || !hidden || !L || !ffn || E <= k) return null;
  const denseLayers = n(c.first_k_dense_replace) ?? 0;
  const moeLayers = L - denseLayers;
  const inactive = moeLayers * (E - k) * 3 * hidden * ffn;
  const active = totalParams - inactive;
  if (active <= 0 || active >= totalParams) return null;
  return {
    activeB: active / 1e9,
    formula: `${(totalParams / 1e9).toFixed(2)}B − ${moeLayers} MoE layers × (${E} − ${k}) experts × 3 × ${hidden} × ${ffn}`,
  };
}

export function capabilitiesFromPipeline(pipeline: string | undefined, tags: string[], url: string, checkedAt: string): Capabilities {
  let c = emptyCapabilities();
  const ev = (note: string): CapEvidence => ({ status: "verified_supported", scope: "model_card", source: "Hugging Face model card (pipeline tag)", sourceUrl: url, checkedAt, note });
  const p = pipeline ?? "";
  const textIn = ["text-generation", "text2text-generation", "image-text-to-text", "audio-text-to-text", "video-text-to-text", "feature-extraction", "sentence-similarity", "any-to-any"];
  if (textIn.includes(p)) c.inputs.text = addEvidence(c.inputs.text, ev(`pipeline: ${p}`));
  if (p === "image-text-to-text" || p === "visual-question-answering" || p === "image-to-text") c.inputs.image = addEvidence(c.inputs.image, ev(`pipeline: ${p}`));
  if (p === "audio-text-to-text" || p === "automatic-speech-recognition") c.inputs.audio = addEvidence(c.inputs.audio, ev(`pipeline: ${p}`));
  if (p === "video-text-to-text") c.inputs.video = addEvidence(c.inputs.video, ev(`pipeline: ${p}`));
  if (["text-generation", "text2text-generation", "image-text-to-text", "audio-text-to-text", "video-text-to-text", "automatic-speech-recognition"].includes(p))
    c.outputs.text = addEvidence(c.outputs.text, ev(`pipeline: ${p}`));
  if (p === "feature-extraction" || p === "sentence-similarity") {
    c.outputs.embeddings = addEvidence(c.outputs.embeddings, ev(`pipeline: ${p}`));
    c.outputs.text = addEvidence(c.outputs.text, { ...ev(`pipeline: ${p}`), status: "verified_unsupported" });
  }
  if (p === "text-to-image") c.outputs.image = addEvidence(c.outputs.image, ev(`pipeline: ${p}`));
  if (p === "text-to-speech" || p === "text-to-audio") c.outputs.audio = addEvidence(c.outputs.audio, ev(`pipeline: ${p}`));
  if (tags.some((t) => /tool|function.?call/i.test(t)))
    c.outputs.tools = addEvidence(c.outputs.tools, { status: "family_suggests", scope: "family", source: "Hugging Face tags", sourceUrl: url, checkedAt });
  return c;
}

const GGUF_QUANT_RE = /(IQ\d_[A-Z]+|Q\d_K_[MSL]|Q\d_K|Q\d_\d|Q\d|F16|BF16|F32|MXFP4)/i;

export function ggufArtifactsFromTree(id: string, tree: { path: string; size?: number }[], checkedAt: string): Artifact[] {
  const files = tree.filter((f) => /\.gguf$/i.test(f.path) && !/mmproj/i.test(f.path) && f.size);
  const projectors = tree.filter((f) => /mmproj/i.test(f.path) && /\.gguf$/i.test(f.path) && f.size);
  // Prefer the F16 projector when several precisions are offered.
  const mmproj = projectors.find((f) => /f16/i.test(f.path)) ?? projectors[0];
  // One group per model file: split shards (…-00001-of-00003.gguf) belong to the same file.
  const groups = new Map<string, { quant: string; size: number; file: string }>();
  for (const f of files) {
    const file = f.path.replace(/-\d{5}-of-\d{5}(?=\.gguf$)/i, "");
    const q = GGUF_QUANT_RE.exec(file.split("/").pop() ?? "")?.[1]?.toUpperCase();
    if (!q) continue;
    const g = groups.get(file) ?? { quant: q, size: 0, file };
    g.size += f.size ?? 0;
    groups.set(file, g);
  }
  // Same quantization offered twice (e.g. one file and the same model split into shards):
  // keep one copy, never add them together. Genuinely different files keep their own entry.
  const byQuant = new Map<string, { quant: string; size: number; file: string }[]>();
  for (const g of groups.values()) {
    const list = byQuant.get(g.quant) ?? [];
    if (!list.some((x) => Math.abs(x.size - g.size) / Math.max(x.size, g.size) < 0.02)) list.push(g);
    byQuant.set(g.quant, list);
  }
  return [...byQuant.values()].flatMap((list) =>
    list.map((g) => ({
      quant: normalizeQuant(g.quant),
      quantLabel: list.length > 1 ? `${g.quant} (${g.file.split("/").pop()})` : g.quant,
      weightBytes: g.size,
      projectorBytes: mmproj?.size,
      downloadBytes: g.size + (mmproj?.size ?? 0),
      provenance: "verified" as const,
      source: "Hugging Face file listing (GGUF)",
      sourceUrl: `https://huggingface.co/${id}`,
      checkedAt,
    })),
  );
}

export async function resolveHfModel(id: string, checkedAt = new Date().toISOString()): Promise<ModelVariant> {
  const info = await fetchHfModel(id);
  const url = `https://huggingface.co/${info.id}`;
  const [cfg, tree] = await Promise.all([fetchHfConfig(info.id), fetchHfTree(info.id)]);
  const total = info.safetensors?.total ?? info.gguf?.total ?? null;
  const arch = cfg ? archFromConfig(cfg, "Hugging Face config.json", url, checkedAt) : null;
  const derived = cfg && total ? deriveActiveParams(cfg, total) : null;
  const isMoe = (arch?.expertCount ?? 0) > 1;
  const [org, repo] = info.id.split("/");
  const caps = capabilitiesFromPipeline(info.pipeline_tag, info.tags ?? [], url, checkedAt);
  const artifacts = ggufArtifactsFromTree(info.id, tree, checkedAt);
  // A full page may mean the listing was cut off: don't present it as complete.
  if (tree.length >= HF_TREE_PAGE) for (const a of artifacts) a.provenance = "estimated";
  return {
    id: `hf:${info.id}`.toLowerCase(),
    family: repo ?? info.id,
    variant: total ? `${(total / 1e9).toFixed(1)}b` : "unknown",
    displayName: info.id,
    resolvedTag: null,
    lookupCandidate: info.id,
    developer: org,
    description: cleanText(info.pipeline_tag ? `Hugging Face · ${info.pipeline_tag}` : "Hugging Face model", 200),
    origin: "huggingface",
    totalParamsB: total
      ? { value: +(total / 1e9).toFixed(3), provenance: "verified", source: info.safetensors?.total ? "Hugging Face safetensors metadata" : "Hugging Face GGUF metadata", sourceUrl: url, checkedAt }
      : { value: null, provenance: "unknown" },
    activeParamsB: derived
      ? { value: +derived.activeB.toFixed(2), provenance: "derived", source: "Derived from config.json", sourceUrl: url, checkedAt, note: derived.formula }
      : isMoe
        ? { value: null, provenance: "unknown", note: "MoE config lacks fields needed to derive active parameters." }
        : arch
          ? { value: total ? +(total / 1e9).toFixed(3) : null, provenance: total ? "derived" : "unknown", source: "Dense config: all weights active", checkedAt }
          : { value: null, provenance: "unknown" },
    architecture: arch ? { value: isMoe ? "moe" : "dense", provenance: "verified", source: "Hugging Face config.json", sourceUrl: url, checkedAt } : { value: null, provenance: "unknown" },
    contextMax: arch?.contextLength ? { value: arch.contextLength, provenance: "verified", source: "config.json max_position_embeddings", sourceUrl: url, checkedAt } : info.gguf?.context_length ? { value: info.gguf.context_length, provenance: "verified", source: "GGUF metadata", checkedAt } : { value: null, provenance: "unknown" },
    artifacts,
    arch,
    capabilities: caps,
    useCases: useCasesFor(repo ?? info.id, info.pipeline_tag === "image-text-to-text" ? "vision+text" : info.pipeline_tag === "feature-extraction" ? "embedding" : "text"),
    sourceUrls: [url],
    lastVerified: checkedAt,
    notes: [
      "Hugging Face metadata describes the model; it does not prove the model runs in your installed Ollama.",
      ...(artifacts.length ? [] : ["No GGUF files in this repo: sizes are hypothetical estimates from parameter count."]),
    ],
  };
}
