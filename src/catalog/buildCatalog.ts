import type { ModelVariant } from "../domain/types";
import { importSeedCsv, type ImportReport } from "./seedImporter";
import { applyVerification, modelFromOllama, type OllamaVerification } from "./ollamaOfficial";
import type { LibraryEntry } from "./ollamaLibrary";

export interface Snapshot {
  schema: number;
  generatedAt: string;
  families: Record<string, Pick<LibraryEntry, "name" | "description" | "capabilities" | "sizes" | "cloud">>;
  variants: Record<string, OllamaVerification & { fromSeed: boolean }>;
}

export interface CatalogBuild {
  models: Map<string, ModelVariant>;
  report: ImportReport;
  snapshotDate: string | null;
  snapshotApplied: number;
  snapshotAdded: number;
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
  for (const u of user) models.set(u.id, u);
  return { models, report, snapshotDate: snapshot?.generatedAt ?? null, snapshotApplied: applied, snapshotAdded: added };
}
