// Refresh the bundled catalog snapshot from official Ollama sources (metadata only).
//
//   npx tsx scripts/refresh-catalog.ts [--seed path.csv] [--out-csv path.csv] [--no-new-families] [--max-tags 5] [--csv-only]
//
// Writes:
//   src/data/verified-snapshot.json      used by the app at startup (provenance: verified + date)
//   <out-csv>                            enriched copy of the seed CSV (seed file is never modified)
//
// Politeness: small concurrency, retry with backoff, ~256 KiB GGUF header reads only.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { importSeedCsv } from "../src/catalog/seedImporter";
import { fetchLibraryIndex, fetchTags, verifyOllamaVariant, type OllamaVerification } from "../src/catalog/ollamaOfficial";
import { parsePulls } from "../src/catalog/ollamaLibrary";
import type { FamilyInfo } from "../src/catalog/buildCatalog";
import { toCsv, parseCsvObjects } from "../src/lib/csv";

const args = process.argv.slice(2);
const arg = (k: string, d?: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const seedPath = resolve(arg("--seed", "src/data/ollama_model_catalog_2026-10.csv")!);
const outCsv = arg("--out-csv");
const includeNew = !args.includes("--no-new-families");
const maxTags = Number(arg("--max-tags", "5"));
const CONCURRENCY = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(800 * (i + 1));
    }
  }
  throw last;
}
async function pool<T>(items: T[], n: number, fn: (t: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
        await sleep(150);
      }
    }),
  );
}

const csvOnly = args.includes("--csv-only");
const familiesOnly = args.includes("--families-only");
const seedText = readFileSync(seedPath, "utf8");
const existing = csvOnly ? JSON.parse(readFileSync("src/data/verified-snapshot.json", "utf8")) : null;
const now: string = existing?.generatedAt ?? new Date().toISOString();
const results: Record<string, OllamaVerification & { fromSeed: boolean }> = existing?.variants ?? {};
if (familiesOnly) await refreshFamilies(existing ?? JSON.parse(readFileSync("src/data/verified-snapshot.json", "utf8")));
else if (!csvOnly) await crawl();

/** Popularity (pulls) and recency (newest order) for every family: two page fetches. */
async function familyInfo(): Promise<Record<string, FamilyInfo>> {
  const [popular, newest] = await Promise.all([retry(() => fetchLibraryIndex()), retry(() => fetchLibraryIndex("newest"))]);
  const rank = new Map(newest.map((e, i) => [e.name, i]));
  const out: Record<string, FamilyInfo> = {};
  for (const e of popular) out[e.name] = { name: e.name, description: e.description, capabilities: e.capabilities, sizes: e.sizes, cloud: e.cloud, pulls: parsePulls(e.pulls), newestRank: rank.get(e.name) };
  return out;
}

async function refreshFamilies(snap: { families: Record<string, FamilyInfo> }) {
  snap.families = await familyInfo();
  writeFileSync("src/data/verified-snapshot.json", JSON.stringify(snap));
  console.log(`Updated popularity/recency for ${Object.keys(snap.families).length} families`);
}
writeCsv();

async function crawl() {
// The committed snapshot is the fallback: a model that fails to refresh keeps its last good data.
const previous: Record<string, OllamaVerification & { fromSeed: boolean }> = (() => {
  try {
    return JSON.parse(readFileSync("src/data/verified-snapshot.json", "utf8")).variants ?? {};
  } catch {
    return {};
  }
})();
let kept = 0;
const seed = importSeedCsv(seedText, seedPath, now);
console.log(`Seed: ${seed.report.imported} variants / ${seed.report.families} families`);

const library = await retry(() => fetchLibraryIndex());
const libByName = new Map(library.map((e) => [e.name, e]));
console.log(`ollama.com/library: ${library.length} families`);

interface Job {
  family: string;
  variant: string;
  fromSeed: boolean;
}
const jobs: Job[] = seed.models.map((m) => ({ family: m.family, variant: m.variant, fromSeed: true }));
const seedFamilies = new Set(seed.models.map((m) => m.family));
if (includeNew) {
  for (const e of library) {
    if (seedFamilies.has(e.name)) continue;
    const variants = e.sizes.length ? e.sizes : ["latest"];
    for (const v of variants) jobs.push({ family: e.name, variant: v, fromSeed: false });
  }
}
console.log(`Verifying ${jobs.length} variants (max ${maxTags} tags each)…`);

const tagsCache = new Map<string, Promise<Awaited<ReturnType<typeof fetchTags>>>>();
let done = 0;
let failed = 0;
await pool(jobs, CONCURRENCY, async (job) => {
  const id = `${job.family}:${job.variant}`.toLowerCase();
  try {
    if (!tagsCache.has(job.family)) tagsCache.set(job.family, retry(() => fetchTags(job.family)));
    const tags = await tagsCache.get(job.family)!;
    const v = await retry(() =>
      verifyOllamaVariant(job.family, job.variant, { badges: libByName.get(job.family)?.capabilities ?? [], maxTags, now, tagsCache: tags }),
    );
    if (!v.artifacts.length && !v.cloudOnly && previous[id]?.artifacts.length) {
      results[id] = previous[id]; // came back empty: keep what we had
      kept++;
      failed++;
    } else {
      results[id] = { ...v, fromSeed: job.fromSeed };
      if (!v.artifacts.length) failed++;
    }
  } catch (e) {
    failed++;
    if (previous[id]) {
      results[id] = previous[id];
      kept++;
    } else results[id] = {
      family: job.family,
      variant: job.variant,
      defaultTag: null,
      artifacts: [],
      arch: null,
      totalParamsB: null,
      contextTokens: null,
      capabilities: undefined as never,
      summary: "",
      cloudOnly: false,
      checkedAt: now,
      errors: [String((e as Error).message ?? e)],
      fromSeed: job.fromSeed,
    };
  }
  done++;
  if (done % 25 === 0) console.log(`  ${done}/${jobs.length} (${failed} without local artifacts)`);
});

// Too many failures means ollama.com was unreachable or changed: don't publish a degraded catalog.
const hadData = jobs.filter((j) => previous[`${j.family}:${j.variant}`.toLowerCase()]?.artifacts.length).length;
if (hadData > 20 && kept / hadData > 0.2) {
  console.error(`Refresh aborted: ${kept} of ${hadData} previously verified variants failed to refresh. The committed snapshot is unchanged.`);
  process.exit(1);
}

const families = await familyInfo();

const snapshot = {
  schema: 1,
  generatedAt: now,
  sources: ["https://ollama.com/library", "https://ollama.com/library/<family>/tags", "https://registry.ollama.ai (manifests, config blobs, GGUF header ranges)"],
  note: "Metadata snapshot. Sizes are exact registry blob sizes at generation time; tags can change, so the app shows this date and warns when stale.",
  families,
  variants: results,
};
writeFileSync("src/data/verified-snapshot.json", JSON.stringify(snapshot));
const ok = Object.values(results).filter((r) => r.artifacts.length).length;
console.log(`Wrote src/data/verified-snapshot.json: ${ok}/${jobs.length} variants with verified artifacts, ${failed} without (${kept} kept from the previous snapshot).`);
}

function writeCsv() {
if (outCsv) {
  const { header, records } = parseCsvObjects(seedText);
  const extra = [
    "verified_default_tag",
    "verified_total_parameters_b",
    "verified_weights_gb",
    "verified_projector_gb",
    "verified_download_gb",
    "verified_quantizations",
    "verified_context_tokens",
    "verified_architecture",
    "verified_layers",
    "verified_kv_heads",
    "verified_head_dim",
    "verified_expert_count",
    "verified_experts_used",
    "verified_inputs",
    "cloud_only",
    "verified_at",
    "verification_errors",
  ];
  const rows = records.map((r) => {
    const v = results[(r.suggested_lookup || `${r.family}:${r.listed_variant}`).toLowerCase()];
    const def = v?.artifacts.find((a) => a.isDefaultTag);
    const gb = (b?: number) => (b ? (b / 1e9).toFixed(3) : "");
    return {
      ...r,
      verified_default_tag: def?.tag ?? "",
      verified_total_parameters_b: v?.totalParamsB ?? "",
      verified_weights_gb: gb(def?.weightBytes),
      verified_projector_gb: gb(def?.projectorBytes),
      verified_download_gb: gb(def?.downloadBytes),
      verified_quantizations: v ? [...new Set(v.artifacts.map((a) => a.quantLabel))].join(" ") : "",
      verified_context_tokens: v?.contextTokens ?? "",
      verified_architecture: v?.arch ? (v.arch.expertCount && v.arch.expertCount > 1 ? "MoE" : "dense") : "",
      verified_layers: v?.arch?.layers ?? "",
      verified_kv_heads: v?.arch?.kvHeads != null ? +v.arch.kvHeads.toFixed(2) : "",
      verified_head_dim: v?.arch?.keyDim ?? "",
      verified_expert_count: v?.arch?.expertCount ?? "",
      verified_experts_used: v?.arch?.expertUsedCount ?? "",
      verified_inputs: v?.defaultTag?.inputs.join("+") ?? "",
      cloud_only: v?.cloudOnly ? "yes" : "",
      verified_at: v?.artifacts.length ? now : "",
      verification_errors: v?.errors.join("; ") ?? "not checked",
    };
  });
  writeFileSync(outCsv, toCsv([...header, ...extra], rows));
  console.log(`Wrote ${outCsv}`);
}
}
