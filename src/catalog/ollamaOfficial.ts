import { addEvidence, emptyCapabilities, mergeCapabilities } from "../domain/capabilities";
import { normalizeQuant } from "../domain/quant";
import type { Artifact, ArchMeta, Capabilities, CapEvidence, ModelVariant } from "../domain/types";
import { parseParamLabel } from "../lib/units";
import { parseGgufHeader, summarizeGguf } from "./gguf";
import { httpBytes, httpJson, httpText } from "./net";
import { parseFamilySummary, parseLibraryIndex, parseTagsPage, quantFromTagName, tagsForVariant, type LibraryEntry, type TagRow } from "./ollamaLibrary";
import { developerFor, useCasesFor } from "./families";

// Official Ollama sources:
//   https://ollama.com/library                         family index (+ capability badges)
//   https://ollama.com/library/<family>/tags           per-tag digest, size, context, inputs
//   https://registry.ollama.ai/v2/library/<f>/manifests/<tag>   exact blob sizes
//   https://registry.ollama.ai/v2/library/<f>/blobs/<config>    file_type, parameter size
//   ranged read of the model blob                      GGUF header (layers, KV heads, ...)

const REGISTRY = "https://registry.ollama.ai/v2/library";
const MANIFEST_ACCEPT = "application/vnd.docker.distribution.manifest.v2+json";
const GGUF_PREFIX_BYTES = 256 * 1024 - 1;

export interface ManifestInfo {
  configDigest?: string;
  modelDigest?: string;
  modelBytes: number;
  projectorBytes?: number;
  totalBytes: number;
  format?: string;
  runner?: string;
}

interface RawManifest {
  config?: { digest?: string; size?: number };
  layers?: { mediaType?: string; digest?: string; size?: number }[];
  format?: string;
  runner?: string;
}

export function parseManifest(j: RawManifest): ManifestInfo {
  const layers = Array.isArray(j.layers) ? j.layers : [];
  const model = layers.find((l) => l.mediaType === "application/vnd.ollama.image.model");
  const projector = layers.filter((l) => l.mediaType === "application/vnd.ollama.image.projector");
  const total = layers.reduce((a, l) => a + (typeof l.size === "number" ? l.size : 0), 0);
  return {
    configDigest: j.config?.digest,
    modelDigest: model?.digest,
    modelBytes: typeof model?.size === "number" ? model.size : 0,
    projectorBytes: projector.length ? projector.reduce((a, l) => a + (l.size ?? 0), 0) : undefined,
    totalBytes: total,
    format: j.format,
    runner: j.runner,
  };
}

export interface ConfigInfo {
  model_format?: string;
  model_family?: string;
  model_families?: string[];
  model_type?: string; // e.g. "3.9B"
  file_type?: string; // e.g. "Q4_K_M"
}

export async function fetchLibraryIndex(sort?: "newest" | "popular"): Promise<LibraryEntry[]> {
  return parseLibraryIndex(await httpText(`https://ollama.com/library${sort ? `?sort=${sort}` : ""}`));
}

export async function searchOllama(q: string): Promise<LibraryEntry[]> {
  return parseLibraryIndex(await httpText(`https://ollama.com/search?q=${encodeURIComponent(q)}`));
}

export async function fetchTags(family: string): Promise<{ rows: TagRow[]; summary: string }> {
  const html = await httpText(`https://ollama.com/library/${encodeURIComponent(family)}/tags`);
  return { rows: parseTagsPage(html), summary: parseFamilySummary(html) };
}

export async function fetchManifest(family: string, tag: string): Promise<ManifestInfo> {
  return parseManifest(await httpJson<RawManifest>(`${REGISTRY}/${encodeURIComponent(family)}/manifests/${encodeURIComponent(tag)}`, MANIFEST_ACCEPT));
}

export async function fetchConfig(family: string, digest: string): Promise<ConfigInfo> {
  return httpJson<ConfigInfo>(`${REGISTRY}/${encodeURIComponent(family)}/blobs/${digest}`);
}

export async function fetchGgufArch(family: string, digest: string, checkedAt: string) {
  const url = `${REGISTRY}/${encodeURIComponent(family)}/blobs/${digest}`;
  const bytes = await httpBytes(url, GGUF_PREFIX_BYTES);
  return summarizeGguf(parseGgufHeader(bytes), "GGUF header of the official Ollama model blob", `https://ollama.com/library/${family}`, checkedAt);
}

/** Capabilities from the exact tag's "Input" column (runtime scope, verified for that tag). */
export function capabilitiesFromTagInputs(row: TagRow, familyBadges: string[], checkedAt: string): Capabilities {
  let c = emptyCapabilities();
  const url = `https://ollama.com/library/${row.tag}`;
  const tagEv = (status: CapEvidence["status"], note?: string): CapEvidence => ({ status, scope: "ollama_tag", source: "ollama.com tag listing", sourceUrl: url, checkedAt, note });
  const fam = (note: string): CapEvidence => ({ status: "family_suggests", scope: "family", source: "ollama.com family badges", sourceUrl: url, checkedAt, note });
  const inputs = new Set(row.inputs);
  const isEmbedding = familyBadges.includes("embedding");
  if (inputs.size) {
    c.inputs.text = addEvidence(c.inputs.text, tagEv(inputs.has("text") ? "verified_supported" : "verified_unsupported"));
    c.inputs.image = addEvidence(c.inputs.image, tagEv(inputs.has("image") ? "verified_supported" : "verified_unsupported"));
    // Absence from the listing is NOT treated as proof for audio/video: they stay unknown
    // unless listed (or confirmed by /api/show or a smoke test).
    if (inputs.has("audio")) c.inputs.audio = addEvidence(c.inputs.audio, tagEv("verified_supported"));
    if (inputs.has("video")) c.inputs.video = addEvidence(c.inputs.video, tagEv("verified_supported"));
  }
  if (isEmbedding) {
    c.outputs.embeddings = addEvidence(c.outputs.embeddings, fam("Family is tagged 'embedding' on ollama.com"));
  } else if (inputs.has("text")) {
    c.outputs.text = addEvidence(c.outputs.text, fam("Chat/completion model per ollama.com listing"));
  }
  if (familyBadges.includes("tools")) c.outputs.tools = addEvidence(c.outputs.tools, fam("Family is tagged 'tools' on ollama.com"));
  if (familyBadges.includes("thinking")) c.thinking = addEvidence(c.thinking, fam("Family is tagged 'thinking' on ollama.com"));
  return c;
}

export interface VerifyProgress {
  (msg: string): void;
}

export interface OllamaVerification {
  family: string;
  variant: string;
  defaultTag: TagRow | null;
  artifacts: Artifact[];
  arch: ArchMeta | null;
  totalParamsB: number | null;
  contextTokens: number | null;
  capabilities: Capabilities;
  summary: string;
  cloudOnly: boolean;
  checkedAt: string;
  errors: string[];
}

/**
 * Verify one family size variant (e.g. gemma3 / 4b) against official Ollama sources.
 * Fetches metadata only (HTML, manifest JSON, config JSON, ~256 KiB GGUF header).
 */
export async function verifyOllamaVariant(
  family: string,
  variant: string,
  opts: { badges?: string[]; maxTags?: number; progress?: VerifyProgress; now?: string; tagsCache?: { rows: TagRow[]; summary: string } } = {},
): Promise<OllamaVerification> {
  const checkedAt = opts.now ?? new Date().toISOString();
  const errors: string[] = [];
  const say = opts.progress ?? (() => undefined);
  say(`Reading ollama.com/library/${family}/tags`);
  const tags = opts.tagsCache ?? (await fetchTags(family));
  const allRows = tags.rows;
  const rows = tagsForVariant(allRows, variant);
  const cloudOnly = rows.length === 0 && allRows.some((r) => r.cloud && (r.name === variant || r.name.startsWith(`${variant}-`)));
  const badges = opts.badges ?? [];

  const result: OllamaVerification = {
    family,
    variant,
    defaultTag: null,
    artifacts: [],
    arch: null,
    totalParamsB: null,
    contextTokens: null,
    capabilities: emptyCapabilities(),
    summary: tags.summary,
    cloudOnly,
    checkedAt,
    errors,
  };
  if (!rows.length) {
    errors.push(cloudOnly ? "Only cloud tags exist for this variant (not downloadable for local use)." : `No local tag named "${variant}" found on ollama.com.`);
    return result;
  }

  const def = rows.find((r) => r.name === variant) ?? rows[0];
  result.defaultTag = def;
  result.contextTokens = def.contextTokens;
  result.capabilities = capabilitiesFromTagInputs(def, badges, checkedAt);

  // One artifact per distinct digest (aliases share a digest), default tag first.
  const byDigest = new Map<string, TagRow>();
  for (const r of [def, ...rows.filter((r) => r !== def)]) {
    const key = r.digest ?? r.tag;
    if (!byDigest.has(key)) byDigest.set(key, r);
  }
  const unique = [...byDigest.values()].slice(0, opts.maxTags ?? 8);

  for (const row of unique) {
    const tagName = row.name;
    try {
      say(`Manifest ${row.tag}`);
      const man = await fetchManifest(family, tagName);
      let cfg: ConfigInfo = {};
      if (man.configDigest) {
        try {
          cfg = await fetchConfig(family, man.configDigest);
        } catch (e) {
          errors.push(`${row.tag}: config unavailable (${(e as Error).message})`);
        }
      }
      const quantLabel = cfg.file_type ?? quantFromTagName(tagName) ?? "unknown";
      result.artifacts.push({
        quant: normalizeQuant(quantLabel),
        quantLabel,
        tag: row.tag,
        digest: row.digest,
        weightBytes: man.modelBytes,
        projectorBytes: man.projectorBytes,
        downloadBytes: man.totalBytes,
        provenance: "verified",
        source: "Ollama registry manifest",
        sourceUrl: `https://ollama.com/library/${row.tag}`,
        checkedAt,
        isDefaultTag: row === def,
      });
      if (row === def) {
        const p = cfg.model_type ? parseParamLabel(cfg.model_type) : null;
        if (p) result.totalParamsB = p;
        if (man.projectorBytes) {
          result.capabilities.inputs.image = addEvidence(result.capabilities.inputs.image, {
            status: "verified_supported",
            scope: "ollama_tag",
            source: "Ollama registry manifest (vision projector layer)",
            sourceUrl: `https://ollama.com/library/${row.tag}`,
            checkedAt,
          });
        }
        if (man.modelDigest && (man.format ?? cfg.model_format ?? "gguf") === "gguf") {
          try {
            say(`GGUF header ${row.tag}`);
            const g = await fetchGgufArch(family, man.modelDigest, checkedAt);
            result.arch = g.arch;
            if (!result.totalParamsB && g.parameterCount) result.totalParamsB = g.parameterCount / 1e9;
          } catch (e) {
            errors.push(`${row.tag}: GGUF header unreadable (${(e as Error).message})`);
          }
        }
      }
    } catch (e) {
      errors.push(`${row.tag}: ${(e as Error).message}`);
    }
  }
  return result;
}

/** Apply an official verification onto a catalog model, preserving provenance. */
export function applyVerification(model: ModelVariant, v: OllamaVerification): ModelVariant {
  const def = v.artifacts.find((a) => a.isDefaultTag);
  const next: ModelVariant = {
    ...model,
    resolvedTag: def?.tag ?? model.resolvedTag,
    cloudOnly: v.cloudOnly || undefined,
    artifacts: v.artifacts.length ? v.artifacts : model.artifacts,
    arch: v.arch ?? model.arch,
    lastVerified: v.artifacts.length ? v.checkedAt : model.lastVerified,
    description: model.description ?? (v.summary || undefined),
    capabilities: mergeCapabilities(model.capabilities, v.capabilities),
    notes: [...model.notes.filter((n) => !n.startsWith("Verification:")), ...v.errors.map((e) => `Verification: ${e}`)],
  };
  const src = { source: "Ollama registry config", sourceUrl: `https://ollama.com/library/${v.family}`, checkedAt: v.checkedAt };
  if (v.totalParamsB) next.totalParamsB = { value: +v.totalParamsB.toFixed(3), provenance: "verified", ...src };
  if (v.contextTokens) next.contextMax = { value: v.contextTokens, provenance: "verified", source: "ollama.com tag listing", sourceUrl: src.sourceUrl, checkedAt: v.checkedAt };
  else if (v.arch?.contextLength) next.contextMax = { value: v.arch.contextLength, provenance: "verified", source: "GGUF header", checkedAt: v.checkedAt };
  if (v.arch?.expertCount && v.arch.expertCount > 1) {
    next.architecture = { value: "moe", provenance: "verified", source: "GGUF header (expert_count)", checkedAt: v.checkedAt, note: `${v.arch.expertCount} experts, ${v.arch.expertUsedCount ?? "?"} used per token` };
  } else if (v.arch?.layers && !v.arch.expertCount) {
    next.architecture = { value: "dense", provenance: "verified", source: "GGUF header (no expert tensors)", checkedAt: v.checkedAt };
  }
  return next;
}

/** Build a brand-new catalog record from an Ollama family/variant (lookup flow). */
export function modelFromOllama(entry: Pick<LibraryEntry, "name" | "description" | "capabilities">, v: OllamaVerification): ModelVariant {
  const base: ModelVariant = {
    id: `${v.family}:${v.variant}`.toLowerCase(),
    family: v.family,
    variant: v.variant,
    displayName: `${v.family}:${v.variant}`,
    resolvedTag: null,
    lookupCandidate: `${v.family}:${v.variant}`,
    developer: developerFor(v.family),
    description: entry.description || v.summary || undefined,
    origin: "ollama_library",
    totalParamsB: { value: parseParamLabel(v.variant), provenance: parseParamLabel(v.variant) ? "derived" : "unknown", source: "Tag size label" },
    activeParamsB: { value: null, provenance: "unknown", note: "Not published by Ollama; verify on the model card." },
    architecture: { value: null, provenance: "unknown" },
    contextMax: { value: null, provenance: "unknown" },
    artifacts: [],
    arch: null,
    capabilities: emptyCapabilities(),
    useCases: useCasesFor(v.family, entry.capabilities.includes("vision") ? "vision+text" : entry.capabilities.includes("embedding") ? "embedding" : "text"),
    sourceUrls: [`https://ollama.com/library/${v.family}`],
    lastVerified: null,
    notes: [],
  };
  return applyVerification(base, v);
}
