import { describe, expect, it } from "vitest";
import { acceptsInputs, addEvidence, capabilitiesFromOllamaList, emptyCapabilities, matchesCapFilter, mergeCapabilities, modalityLabel, resolveInput, resolveOutput } from "./capabilities";
import { seedCapabilities } from "../catalog/seedImporter";
import { capabilitiesFromTagInputs } from "../catalog/ollamaOfficial";

const seedRow = (image: string, family = "text") => ({
  input_text: "yes",
  input_image: image,
  input_audio: "unknown",
  input_video: "unknown",
  input_pdf_native: "unknown",
  output_text: "yes",
  output_image: "unknown",
  output_audio: "unknown",
  tool_calling: "unknown",
  modality_family_level: family,
  source_url: "https://ollama.com/library/x",
  source_snapshot_date: "2026-10-10",
});

describe("capability evidence", () => {
  it("family suggests vision but this exact tag does not → verified unsupported, no checkmark", () => {
    let c = seedCapabilities(seedRow("family_claim_only", "vision+text"));
    expect(resolveInput(c, "image").status).toBe("family_suggests");
    c = mergeCapabilities(c, capabilitiesFromTagInputs({ tag: "x:1b", name: "1b", sizeBytes: 1, contextTokens: 32768, inputs: ["text"], cloud: false }, [], "2026-10-10"));
    expect(resolveInput(c, "image").status).toBe("verified_unsupported");
  });

  it("family-only claims never count as verified", () => {
    const c = seedCapabilities(seedRow("family_claim_only", "vision+text"));
    expect(modalityLabel(c)).toEqual({ label: "Text + Images", verified: false });
    expect(acceptsInputs(c, { image: true }, true)).toBe(false);
    expect(acceptsInputs(c, { image: true }, false)).toBe(true);
  });

  it("image understanding is not image generation", () => {
    let c = emptyCapabilities();
    c.inputs.image = addEvidence(c.inputs.image, { status: "verified_supported", scope: "ollama_tag", source: "t" });
    expect(resolveOutput(c, "image").status).toBe("unknown");
    expect(matchesCapFilter(c, "image", true)).toBe(true);
  });

  it("OCR/extraction pipeline is not native PDF input", () => {
    const c = seedCapabilities(seedRow("no_expected"));
    expect(resolveInput(c, "pdf").status).toBe("unknown");
    // Documents are accepted via text extraction (app-mediated) for any text model
    expect(acceptsInputs(c, { pdf: true }, false)).toBe(true);
  });

  it("embedding model has no chat output", () => {
    const c = capabilitiesFromOllamaList(["embedding"], "ollama_local", "api/show", "2026-10-10");
    expect(resolveOutput(c, "text").status).toBe("verified_unsupported");
    expect(resolveOutput(c, "embeddings").status).toBe("verified_supported");
    expect(modalityLabel(c).label).toBe("Embeddings only");
  });

  it("audio/video stay unknown unless explicitly evidenced (never inferred from vision)", () => {
    const c = capabilitiesFromTagInputs({ tag: "g:4b", name: "4b", sizeBytes: 1, contextTokens: 1, inputs: ["text", "image"], cloud: false }, ["vision"], "2026-10-10");
    expect(resolveInput(c, "image").status).toBe("verified_supported");
    expect(resolveInput(c, "audio").status).toBe("unknown");
    expect(resolveInput(c, "video").status).toBe("unknown");
    const local = capabilitiesFromOllamaList(["completion", "vision"], "ollama_local", "api/show", "2026-10-10");
    expect(resolveInput(local, "audio").status).toBe("unknown");
  });

  it("registry/runtime metadata that conflicts with the model card is surfaced", () => {
    let c = emptyCapabilities();
    c.inputs.image = addEvidence(c.inputs.image, { status: "verified_supported", scope: "model_card", source: "HF card" });
    c.inputs.image = addEvidence(c.inputs.image, { status: "verified_unsupported", scope: "ollama_tag", source: "ollama tag" });
    const r = resolveInput(c, "image");
    expect(r.status).toBe("verified_unsupported"); // runtime wins for "can I use it here"
    expect(r.model).toBe("verified_supported");
    expect(r.runtimeModelMismatch).toBe(true);
  });

  it("same-scope disagreement is flagged as a conflict", () => {
    let c = emptyCapabilities();
    c.inputs.image = addEvidence(c.inputs.image, { status: "verified_supported", scope: "ollama_tag", source: "listing", checkedAt: "2026-10-01" });
    c.inputs.image = addEvidence(c.inputs.image, { status: "verified_unsupported", scope: "ollama_local", source: "api/show", checkedAt: "2026-10-09" });
    expect(resolveInput(c, "image").conflict).toBe(true);
    expect(resolveInput(c, "image").status).toBe("verified_unsupported"); // local install outranks listing
  });

  it("offline seed state preserves uncertainty", () => {
    const c = seedCapabilities(seedRow("no_expected"));
    expect(resolveInput(c, "image").status).toBe("unknown"); // "no_expected" is not proof
    expect(resolveInput(c, "text").status).toBe("family_suggests");
    expect(modalityLabel(c).verified).toBe(false);
    expect(resolveOutput(c, "tools").status).toBe("unknown");
  });

  it("text-only filter requires known-absent other inputs when verified-only", () => {
    const c = capabilitiesFromTagInputs({ tag: "l:8b", name: "8b", sizeBytes: 1, contextTokens: 1, inputs: ["text"], cloud: false }, [], "2026-10-10");
    expect(modalityLabel(c).label).toBe("Text only");
    expect(matchesCapFilter(c, "text_only", false)).toBe(true);
  });
});
