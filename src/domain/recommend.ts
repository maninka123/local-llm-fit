import { resolveCap, resolveInput, resolveOutput } from "./capabilities";
import type { Estimate, FitClass } from "./estimator";
import type { ModelVariant } from "./types";
import { clamp, GiB } from "../lib/units";

// Plain-language fit groups and a transparent "recommended" order.
//
// The ranking is NOT a benchmark of answer quality. It combines visible, checkable factors:
// size (bigger usually more capable, when it fits), popularity (ollama.com pulls), recency
// (ollama.com "newest" order), features (tools, thinking, vision), fit confidence and
// spare memory. Every card shows the reasons behind its position.

export type Bucket = "runs_well" | "runs_slower" | "tight" | "wont_run";

export interface BucketMeta {
  id: Bucket;
  title: string;
  blurb: string;
  tone: string; // CSS colour variable
  classes: FitClass[];
}

export const BUCKETS: BucketMeta[] = [
  { id: "runs_well", title: "Runs well", blurb: "Fits entirely in fast GPU memory.", tone: "var(--good)", classes: ["full_gpu"] },
  { id: "runs_slower", title: "Runs, but slower", blurb: "Part or all of it runs on the CPU. MoE models usually cope best.", tone: "var(--warn)", classes: ["promising_moe", "cpu_only", "hybrid_slow"] },
  { id: "tight", title: "Tight fit", blurb: "Only fits if you close other apps.", tone: "var(--orange)", classes: ["memory_constrained"] },
  { id: "wont_run", title: "Won't run", blurb: "Too big for this machine, or its size still needs checking. Closest to fitting first.", tone: "var(--bad)", classes: ["cannot_fit", "unknown"] },
];

export const bucketOf = (c: FitClass): Bucket => BUCKETS.find((b) => b.classes.includes(c))!.id;

/** Ollama.com popularity and recency for a family (from the bundled snapshot). */
export interface FamilySignals {
  pulls?: number | null;
  newestRank?: number;
}

export interface Recommendation {
  score: number;
  reasons: string[];
}

const fmtPulls = (n: number) => (n >= 1e6 ? `${Math.round(n / 1e6)}M` : `${Math.round(n / 1e3)}K`);
const TOTAL_FAMILIES = 250;

export function recommend(m: ModelVariant, e: Estimate, fam: FamilySignals | undefined, opts: { wantEmbeddings?: boolean } = {}): Recommendation {
  const reasons: string[] = [];
  let score = 0;

  // Size: log scale, 1B → low, ~120B → full marks.
  const p = m.totalParamsB.value ?? (e.weights ? e.weights.mid / 0.6e9 : null);
  if (p != null) {
    score += 30 * clamp(Math.log10(p + 1) / Math.log10(121), 0, 1);
    if (p >= 7) reasons.push(`Larger model (${p >= 10 ? Math.round(p) : p.toFixed(1)}B)`);
  } else score -= 10;

  // Popularity: 100K pulls → 0, 100M → full marks.
  if (fam?.pulls) {
    score += 20 * clamp((Math.log10(fam.pulls) - 5) / 3, 0, 1);
    if (fam.pulls >= 5e6) reasons.push(`Popular (${fmtPulls(fam.pulls)} downloads)`);
  }

  // Recency: position in ollama.com's newest-first list.
  if (fam?.newestRank != null) {
    score += 15 * clamp(1 - fam.newestRank / TOTAL_FAMILIES, 0, 1);
    if (fam.newestRank < 45) reasons.push("Recent release");
  }

  // Features.
  const has = (s: string) => s === "verified_supported" || s === "family_suggests";
  if (has(resolveOutput(m.capabilities, "tools").status)) {
    score += 6;
    reasons.push("Tool calling");
  }
  if (has(resolveCap(m.capabilities.thinking).status)) {
    score += 6;
    reasons.push("Thinking mode");
  }
  if (has(resolveInput(m.capabilities, "image").status)) {
    score += 5;
    reasons.push("Reads images");
  }
  if (m.lastVerified) score += 3;

  // Fit quality.
  score += e.confidence === "high" ? 10 : e.confidence === "medium" ? 6 : 2;
  const margin = e.classification === "full_gpu" ? e.gpuMargin : e.memoryMargin;
  if (margin != null && margin > 0) {
    score += 5 * clamp(margin / (4 * GiB), 0, 1);
    if (margin >= 3 * GiB && e.classification === "full_gpu") reasons.push("Room for long chats");
  }
  // Within "runs slower", MoE hybrids are usually the most usable.
  if (e.classification === "promising_moe") {
    score += 14;
    reasons.push("MoE: only a small part works per word");
  } else if (e.classification === "cpu_only") score += 3;

  // Not a chat model, or not runnable locally.
  const embeddingOnly = has(resolveOutput(m.capabilities, "embeddings").status) || m.useCases.includes("embedding");
  if (embeddingOnly && !opts.wantEmbeddings) score -= 25;
  if (m.useCases.includes("safety")) score -= 20;
  if (m.cloudOnly) score -= 50;

  return { score: Math.round(score * 10) / 10, reasons };
}
