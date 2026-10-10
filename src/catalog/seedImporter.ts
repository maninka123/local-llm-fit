import { parseCsvObjects } from "../lib/csv";
import { addEvidence, emptyCapabilities } from "../domain/capabilities";
import type { ArchitectureKind, Capabilities, CapEvidence, ModelVariant, Sourced } from "../domain/types";
import { developerFor, useCasesFor } from "./families";

// Importer for the seed catalog CSV (ollama_model_catalog_*.csv).
// The seed is a STARTER: sizes are heuristics, tags are lookup candidates, modalities are
// family-level hints. Nothing here is promoted to "verified".

export const SEED_REQUIRED_COLUMNS = [
  "family",
  "listed_variant",
  "suggested_lookup",
  "total_parameters_b",
  "active_parameters_b",
  "active_parameters_confidence",
  "architecture",
  "modality_family_level",
  "approx_q4_weights_gb",
  "q4_size_status",
  "source_url",
  "source_snapshot_date",
] as const;

export const SEED_OPTIONAL_COLUMNS = [
  "tag_verified",
  "local_download_status",
  "notes",
  "input_text",
  "input_image",
  "input_audio",
  "input_video",
  "input_pdf_native",
  "output_text",
  "output_image",
  "output_audio",
  "tool_calling",
  "input_modality_confidence",
  "input_modality_verification",
  "modality_notes",
] as const;

export type IssueLevel = "error" | "warning";
export interface ImportIssue {
  level: IssueLevel;
  row: number; // 1-based line number in the file (header = 1)
  id?: string;
  field?: string;
  message: string;
}

export interface ImportReport {
  fileName: string;
  totalRows: number;
  imported: number;
  families: number;
  duplicates: number;
  conflicts: number;
  issues: ImportIssue[];
  importedAt: string;
}

export interface ImportResult {
  models: ModelVariant[];
  report: ImportReport;
}

const SEED_SOURCE = "Seed CSV (starter data, not verified)";

function num(v: string): number | null {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function familyEvidence(source: string, sourceUrl: string, date: string, note?: string): CapEvidence {
  return { status: "family_suggests", scope: "family", source, sourceUrl, checkedAt: date, note };
}

/** Map seed modality columns to capability evidence. Only "suggests" — never verified. */
export function seedCapabilities(r: Record<string, string>): Capabilities {
  let c = emptyCapabilities();
  const url = r.source_url;
  const date = r.source_snapshot_date;
  const yes = (v: string | undefined) => v === "yes" || v === "family_claim_only";
  const ev = (note?: string) => familyEvidence(SEED_SOURCE, url, date, note);
  if (yes(r.input_text)) c.inputs.text = addEvidence(c.inputs.text, ev("Family listing implies text input."));
  if (yes(r.input_image)) c.inputs.image = addEvidence(c.inputs.image, ev("Family is listed with a vision tag; this exact tag is unverified."));
  if (yes(r.input_audio)) c.inputs.audio = addEvidence(c.inputs.audio, ev());
  if (yes(r.input_video)) c.inputs.video = addEvidence(c.inputs.video, ev());
  if (yes(r.output_text)) c.outputs.text = addEvidence(c.outputs.text, ev());
  if (yes(r.output_image)) c.outputs.image = addEvidence(c.outputs.image, ev());
  if (yes(r.output_audio)) c.outputs.audio = addEvidence(c.outputs.audio, ev());
  if (yes(r.tool_calling)) c.outputs.tools = addEvidence(c.outputs.tools, ev());
  if (r.modality_family_level === "embedding") {
    c.outputs.embeddings = addEvidence(c.outputs.embeddings, ev("Family is listed as an embedding model."));
  }
  // input_pdf_native is intentionally never mapped to support from family data.
  return c;
}

function architectureFrom(r: Record<string, string>): Sourced<ArchitectureKind> {
  const a = (r.architecture || "").toLowerCase();
  if (a === "moe")
    return { value: "moe", provenance: "estimated", source: SEED_SOURCE, sourceUrl: r.source_url, checkedAt: r.source_snapshot_date, note: "Curated hint; verify." };
  if (a === "dense")
    return { value: "dense", provenance: "estimated", source: SEED_SOURCE, sourceUrl: r.source_url, checkedAt: r.source_snapshot_date };
  return { value: null, provenance: "unknown", source: SEED_SOURCE, note: `Seed says "${r.architecture || "blank"}".` };
}

export function importSeedCsv(text: string, fileName = "seed.csv", now = new Date().toISOString()): ImportResult {
  const { header, records, widthErrors } = parseCsvObjects(text);
  const issues: ImportIssue[] = [];
  const missing = SEED_REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    issues.push({ level: "error", row: 1, message: `Missing required column(s): ${missing.join(", ")}` });
    return {
      models: [],
      report: { fileName, totalRows: records.length, imported: 0, families: 0, duplicates: 0, conflicts: 0, issues, importedAt: now },
    };
  }
  for (const line of widthErrors) issues.push({ level: "warning", row: line, message: "Row has a different number of fields than the header." });

  const byId = new Map<string, ModelVariant>();
  let duplicates = 0;
  let conflicts = 0;

  records.forEach((r, idx) => {
    const line = idx + 2;
    const family = r.family?.trim();
    const variant = r.listed_variant?.trim();
    if (!family || !variant) {
      issues.push({ level: "error", row: line, message: "Missing family or listed_variant; row skipped." });
      return;
    }
    const id = (r.suggested_lookup || `${family}:${variant}`).trim().toLowerCase();

    let total = num(r.total_parameters_b);
    let active = num(r.active_parameters_b);
    const approxQ4 = num(r.approx_q4_weights_gb);
    if (Number.isNaN(total)) {
      issues.push({ level: "error", row: line, id, field: "total_parameters_b", message: `Not a number: "${r.total_parameters_b}"` });
      total = null;
    }
    if (Number.isNaN(active)) {
      issues.push({ level: "error", row: line, id, field: "active_parameters_b", message: `Not a number: "${r.active_parameters_b}"` });
      active = null;
    }
    if (Number.isNaN(approxQ4)) issues.push({ level: "warning", row: line, id, field: "approx_q4_weights_gb", message: "Not a number; ignored." });
    if (total != null && total < 0.01) {
      issues.push({
        level: "warning",
        row: line,
        id,
        field: "total_parameters_b",
        message: `Implausible total of ${total}B parameters (label "${variant}" may describe context length, not size). Treated as Unknown.`,
      });
      total = null;
    }
    if (active != null && total != null && active > total) {
      issues.push({ level: "warning", row: line, id, field: "active_parameters_b", message: "Active parameters exceed total; active treated as Unknown." });
      active = null;
    }

    const arch = architectureFrom(r);
    const model: ModelVariant = {
      id,
      family,
      variant,
      displayName: `${family}:${variant}`,
      resolvedTag: null,
      lookupCandidate: r.suggested_lookup,
      developer: developerFor(family),
      origin: "seed_csv",
      totalParamsB:
        total != null
          ? {
              value: total,
              provenance: "derived",
              source: "Seed CSV, derived from the registry size label",
              sourceUrl: r.source_url,
              checkedAt: r.source_snapshot_date,
              note: "Size label from the family listing; the exact tag's parameter count is not verified.",
            }
          : { value: null, provenance: "unknown", source: SEED_SOURCE },
      activeParamsB:
        active != null
          ? {
              value: active,
              provenance: "estimated",
              source: "Seed CSV curated estimate",
              sourceUrl: r.source_url,
              checkedAt: r.source_snapshot_date,
              note: `Confidence: ${r.active_parameters_confidence || "unspecified"}. Verify before relying on it.`,
            }
          : { value: null, provenance: "unknown", source: SEED_SOURCE, note: "Active parameters not verified." },
      architecture: arch,
      contextMax: { value: null, provenance: "unknown", source: SEED_SOURCE },
      artifacts: [],
      arch: null,
      capabilities: seedCapabilities(r),
      useCases: useCasesFor(family, r.modality_family_level || ""),
      sourceUrls: r.source_url ? [r.source_url] : [],
      lastVerified: null,
      seedSnapshotDate: r.source_snapshot_date,
      raw: { ...r },
      notes: [],
    };
    if (approxQ4 != null && !Number.isNaN(approxQ4) && approxQ4 > 0) {
      model.notes.push(`Seed heuristic Q4 size ≈ ${approxQ4} GB (${r.q4_size_status || "heuristic"}); not an actual Ollama file size.`);
    }

    const prev = byId.get(id);
    if (prev) {
      duplicates++;
      const differs = JSON.stringify(prev.raw) !== JSON.stringify(model.raw);
      if (differs) conflicts++;
      issues.push({
        level: "warning",
        row: line,
        id,
        message: differs ? "Duplicate key with different values; first occurrence kept." : "Exact duplicate row; skipped.",
      });
      return;
    }
    byId.set(id, model);
  });

  const models = [...byId.values()];
  return {
    models,
    report: {
      fileName,
      totalRows: records.length,
      imported: models.length,
      families: new Set(models.map((m) => m.family)).size,
      duplicates,
      conflicts,
      issues,
      importedAt: now,
    },
  };
}
