import type { ModelVariant } from "../domain/types";
import { sanitizeModel } from "./validate";
import { importSeedCsv, type ImportReport } from "./seedImporter";
import { applyVerification, modelFromOllama, type OllamaVerification } from "./ollamaOfficial";
import type { LibraryEntry } from "./ollamaLibrary";

export interface FamilyInfo extends Pick<LibraryEntry, "name" | "description" | "capabilities" | "sizes" | "cloud"> {
  /** Total downloads shown on ollama.com (popularity signal). */
  pulls?: number | null;
  /** Position in ollama.com's "newest" ordering (0 = newest). */
  newestRank?: number;
}

export interface Snapshot {
  schema: number;
  generatedAt: string;
  families: Record<string, FamilyInfo>;
  variants: Record<string, OllamaVerification & { fromSeed: boolean }>;
}

export interface CatalogBuild {
  models: Map<string, ModelVariant>;
  report: ImportReport;
  snapshotDate: string | null;
  snapshotApplied: number;
  snapshotAdded: number;
  families: Record<string, FamilyInfo>;
}

/**
 * Layering (later layers win, provenance preserved):
 *   seed CSV → bundled official snapshot → live verifications (this device) → user-added models
 */
export function buildCatalog(seedCsv: string, snapshot: Snapshot | null, live: Record<string, OllamaVerification>, user: ModelVariant[]): CatalogBuild {
  const { models: seedModels, report } = importSeedCsv(seedCsv, "ollama_model_catalog_2026-10.csv");
  const models = new Map(seedModels.map((m) => [m.id, m]));
  let applied = 0;
  let added = 0;
  if (snapshot) {
    for (const [id, v] of Object.entries(snapshot.variants)) {
      if (!v.capabilities) continue;
      const existing = models.get(id);
      if (existing) {
        if (v.artifacts.length || v.cloudOnly) {
          models.set(id, applyVerification(existing, v));
          applied++;
        }
      } else if (v.artifacts.length && !v.cloudOnly) {
        const fam = snapshot.families[v.family] ?? { name: v.family, description: "", capabilities: [] };
        models.set(id, modelFromOllama(fam, v));
        added++;
      }
    }
  }
  for (const [id, v] of Object.entries(live)) {
    const existing = models.get(id);
    if (existing) models.set(id, applyVerification(existing, v));
    else if (v.artifacts.length && !v.cloudOnly) models.set(id, modelFromOllama({ name: v.family, description: v.summary, capabilities: [] }, v));
  }
  for (const raw of user) {
    // Saved records are checked again (older versions or imports may be malformed).
    const u = sanitizeModel(raw);
    if (!u) continue;
    const existing = models.get(u.id);
    // A saved copy must not hide a newer official verification of the same model.
    if (existing?.lastVerified && (!u.lastVerified || u.lastVerified < existing.lastVerified)) {
      if (u.origin !== "user") continue; // an older saved copy of an Ollama/Hugging Face record
      models.set(u.id, { ...u, artifacts: existing.artifacts, arch: existing.arch ?? u.arch, lastVerified: existing.lastVerified, resolvedTag: existing.resolvedTag ?? u.resolvedTag });
      continue;
    }
    models.set(u.id, u);
  }
  return { models, report, snapshotDate: snapshot?.generatedAt ?? null, snapshotApplied: applied, snapshotAdded: added, families: snapshot?.families ?? {} };
}
