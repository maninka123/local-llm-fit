import { describe, expect, it } from "vitest";
import { estimate, pickArtifact } from "./estimator";
import { buildMachineProfile } from "./hardware";
import { bucketFor } from "./recommend";
import { acceptsInputs, addEvidence, emptyCapabilities } from "./capabilities";
import { EMPTY_OVERRIDES, type BenchmarkRecord } from "./types";
import { ARCH_8B, artifact, discrete, model, settings } from "./testkit";
import { GB, GiB } from "../lib/units";
import { parseManifest } from "../catalog/ollamaOfficial";
import { fetchHfTree, ggufArtifactsFromTree } from "../catalog/huggingface";
import { sanitizeArtifact, sanitizeBenchmark, sanitizeCapabilityEvidence, sanitizeModel, sanitizeVerification } from "../catalog/validate";
import { fetchTransport, nextLink, setTransport } from "../catalog/net";
import { latestBenchmark } from "../state/derived";
import { buildSample } from "../platform/samples";
import { DEMO_MACHINES } from "../platform/demoHardware";

// Regression tests for issues found in the 1.1.0 review.

describe("catalog sizes", () => {
  it("counts every weight layer, including Ollama's per-tensor format", () => {
    const m = parseManifest({
      layers: [
        { mediaType: "application/vnd.ollama.image.tensor", size: 3 * GB },
        { mediaType: "application/vnd.ollama.image.tensor", size: 2 * GB },
        { mediaType: "application/vnd.ollama.image.json", size: 1000 },
      ],
    });
    expect(m.modelBytes).toBe(5 * GB);
  });
  it("a 0-byte file is never used as a published size", () => {
    const m = model({ total: 8, dense: true, artifacts: [artifact("Q4_K_M", 0)], arch: ARCH_8B });
    expect(pickArtifact(m, "Q4_K_M")).toBeNull();
    const e = estimate(m, settings({ quant: "Q4_K_M" }), discrete(16, 15, 32, 24));
    expect(e.weights!.mid).toBeGreaterThan(1 * GB);
  });
  it("Hugging Face: a model offered as one file and as split shards is counted once", () => {
    const a = ggufArtifactsFromTree("x/y", [
      { path: "m-Q4_K_M.gguf", size: 4 * GB },
      { path: "split/m-Q4_K_M-00001-of-00002.gguf", size: 2 * GB },
      { path: "split/m-Q4_K_M-00002-of-00002.gguf", size: 2 * GB },
    ], "2026-01-01");
    expect(a).toHaveLength(1);
    expect(a[0].weightBytes).toBe(4 * GB);
  });
});

describe("memory pools", () => {
  it("free memory never exceeds the total", () => {
    // A machine with a live free-memory reading (samples have none: they always plan with Normal use).
    const r = DEMO_MACHINES.find((d) => d.id === "office-igpu")!.report;
    const p = buildMachineProfile(r, { ...EMPTY_OVERRIDES, ramTotalGiB: 8 });
    expect(p.ramFree!).toBeLessThanOrEqual(8 * GiB);
    const e = estimate(model({ total: 1, dense: true }), settings(), p);
    expect(e.pools.ramUsable!).toBeLessThan(8 * GiB);
  });
  it("a host allocation larger than physical RAM can't fit, even when the GPU part does", () => {
    const m = model({ total: 1, dense: true, arch: { ...ARCH_8B, layers: 16 } });
    // 1 GiB of RAM minus the 1.5 GiB OS floor leaves no room for the runner process at all.
    const e = estimate(m, settings(), discrete(24, 23, 1, 0.3));
    expect(e.classification).toBe("cannot_fit");
  });
  it("live RAM next to planned VRAM is labelled per pool", () => {
    const e = estimate(model({ total: 1, dense: true }), settings(), discrete(16, null, 32, 24));
    expect(e.pools.ramMode).toBe("live");
    expect(e.pools.vramMode).toBe("planning");
  });
});

describe("verdicts", () => {
  it("a GPU with unconfirmed Ollama support never gets high confidence", () => {
    const p = { ...discrete(16, 15, 32, 24), gpuBackendSupported: null };
    const e = estimate(model({ total: 1, dense: true, artifacts: [artifact("Q4_K_M", 0.8 * GB)], arch: ARCH_8B }), settings(), p);
    expect(e.classification).toBe("full_gpu");
    expect(e.confidence).not.toBe("high");
  });
  it("speed slows down as the conversation fills a long context", () => {
    const m = model({ total: 8, dense: true, artifacts: [artifact("Q4_K_M", 4.9 * GB)], arch: ARCH_8B });
    const p = { ...discrete(80, 78, 128, 100), gpuBandwidthGBs: 1000 };
    const short = estimate(m, settings({ contextTokens: 4096 }), p).speed!.range;
    const long = estimate(m, settings({ contextTokens: 131072 }), p).speed!.range;
    expect(long.low).toBeLessThan(short.low * 0.5);
  });
  it("a full-GPU fit that replies very slowly is not 'Runs well'", () => {
    expect(bucketFor({ classification: "full_gpu", speed: { range: { low: 2, mid: 3, high: 4 }, gbPerToken: 1, gpuBandwidthGBs: 25, cpuShare: 0, gpuTimeShare: 1 } })).toBe("runs_slower");
    expect(bucketFor({ classification: "full_gpu", speed: null })).toBe("runs_well");
  });
});

describe("data you enter or import", () => {
  it("'Only verified' ignores capabilities you entered yourself", () => {
    let c = emptyCapabilities();
    c.inputs.text = addEvidence(c.inputs.text, { status: "verified_supported", scope: "ollama_tag", source: "test" });
    c.inputs.image = addEvidence(c.inputs.image, { status: "verified_supported", scope: "user", source: "Confirmed by you" });
    expect(acceptsInputs(c, { image: true }, false)).toBe(true);
    expect(acceptsInputs(c, { image: true }, true)).toBe(false);
  });
  it("imported records are repaired or rejected", () => {
    expect(sanitizeModel({ id: "x" })).toBeNull();
    const m = sanitizeModel({ id: "x:1b", displayName: "X", totalParamsB: { value: 1, provenance: "user_entered" }, activeParamsB: { value: 5, provenance: "user_entered" } })!;
    expect(m.artifacts).toEqual([]);
    expect(m.activeParamsB.value).toBeNull(); // more than the total
    expect(m.capabilities.inputs.text.evidence).toEqual([]);
  });
  it("a benchmark of a different file (digest or quantization) is not shown for the installed model", () => {
    const m = { ...model({ total: 8, dense: true }), id: "a:8b", resolvedTag: "a:8b", installed: { name: "a:8b", digest: "new", sizeBytes: 1, quantLabel: "Q4_K_M" } };
    const b = (digest: string, quantLabel: string): BenchmarkRecord => ({ id: digest + quantLabel, createdAt: "2026-01-01", model: "a:8b", digest, quantLabel, contextTokens: 4096, temperature: 0, kind: "warm", wallMs: 1, notes: [] });
    expect(latestBenchmark([b("old", "Q4_K_M")], m)).toBeUndefined();
    expect(latestBenchmark([b("new", "Q8_0")], m)).toBeUndefined();
    expect(latestBenchmark([b("new", "Q4_K_M")], m)).toBeDefined();
  });
});

describe("second review", () => {
  it("imported evidence with a numeric date is dropped, not a crash later", () => {
    const m = sanitizeModel({
      id: "x:1b",
      displayName: "X",
      capabilities: { inputs: { image: { evidence: [{ status: "verified_supported", scope: "user", source: "me", checkedAt: 123 }, { status: "nonsense", scope: "user" }] } } },
    })!;
    expect(m.capabilities.inputs.image.evidence).toHaveLength(1);
    expect(m.capabilities.inputs.image.evidence[0].checkedAt).toBeUndefined();
    expect(() => estimate(m, settings(), discrete(16, 15, 32, 24))).not.toThrow();
  });
  it("imported verifications and benchmarks are validated", () => {
    expect(sanitizeVerification({ family: "a", variant: "1b", artifacts: [], checkedAt: 5 })).toBeNull();
    expect(sanitizeVerification({ family: "a", variant: "1b", artifacts: [{ quant: "Q4_K_M", weightBytes: "big" }], checkedAt: "2026-01-01" })!.artifacts).toEqual([]);
    expect(sanitizeBenchmark({ id: "b", model: "a", kind: "warm", createdAt: "2026-01-01", contextTokens: "8k" })).toBeNull();
    expect(sanitizeCapabilityEvidence({ "a:1b": [{ key: "image", ev: { status: "verified_supported", scope: "user", source: "x" } }, { key: "smell", ev: {} }] })["a:1b"]).toHaveLength(1);
  });
  it("Hugging Face: a single file next to its own shards in one folder counts once", () => {
    const a = ggufArtifactsFromTree("x/y", [
      { path: "m-Q4_K_M.gguf", size: 4 * GB },
      { path: "m-Q4_K_M-00001-of-00002.gguf", size: 2 * GB },
      { path: "m-Q4_K_M-00002-of-00002.gguf", size: 2 * GB },
    ], "2026-01-01");
    expect(a).toHaveLength(1);
    expect(a[0].weightBytes).toBe(4 * GB);
    expect(a[0].provenance).toBe("verified");
  });
  it("Hugging Face: a shard set with parts missing is scaled up and marked estimated", () => {
    const a = ggufArtifactsFromTree("x/y", [{ path: "big-Q8_0-00001-of-00002.gguf", size: 5 * GB }], "2026-01-01");
    expect(a[0].provenance).toBe("estimated");
    expect(a[0].weightBytes).toBe(10 * GB);
  });
  it("a measurement is only shown for the same quantization, context, GPU, and never if imported", () => {
    const m = { ...model({ total: 8, dense: true }), id: "a:8b", resolvedTag: "a:8b", installed: { name: "a:8b", digest: "d", sizeBytes: 1, quantLabel: "Q4_K_M" } };
    const b: BenchmarkRecord = { id: "1", createdAt: "2026-01-01", model: "a:8b", digest: "d", quantLabel: "Q4_K_M", contextTokens: 8192, temperature: 0, kind: "warm", wallMs: 1, gpuName: "RTX 4070", notes: [] };
    const ctx = { quant: "Q4_K_M" as const, contextTokens: 8192, gpuName: "RTX 4070" };
    expect(latestBenchmark([b], m, ctx)).toBeDefined();
    expect(latestBenchmark([b], m, { ...ctx, quant: "Q8_0" })).toBeUndefined();
    expect(latestBenchmark([b], m, { ...ctx, contextTokens: 32768 })).toBeUndefined();
    expect(latestBenchmark([b], m, { ...ctx, gpuName: "RTX 3060" })).toBeUndefined();
    expect(latestBenchmark([{ ...b, importedFrom: "backup.json" }], m, ctx)).toBeUndefined();
  });
});

describe("third review", () => {
  it("restoring a file keeps its saved quantization even when the label has a file name", () => {
    const a = sanitizeArtifact({ quant: "Q4_K_M", quantLabel: "Q4_K_M (small-Q4_K_M.gguf)", weightBytes: 4 * GB, provenance: "verified", source: "x" })!;
    expect(a.quant).toBe("Q4_K_M");
    expect(a.quantLabel).toBe("Q4_K_M (small-Q4_K_M.gguf)");
  });
  it("reads the next page from a Link header", () => {
    expect(nextLink('<https://huggingface.co/api/models/a/b/tree/main?cursor=xyz>; rel="next"')).toBe("https://huggingface.co/api/models/a/b/tree/main?cursor=xyz");
    expect(nextLink(undefined)).toBeNull();
  });
  it("the fallback file listing follows every page, and says when it couldn't finish", async () => {
    const pages: Record<string, { text: string; link?: string }> = {
      "https://huggingface.co/api/models/a/b/tree/main?recursive=true": { text: JSON.stringify([{ path: "m-Q4_K_M-00001-of-00002.gguf", size: 2 }]), link: '<https://huggingface.co/api/models/a/b/tree/main?cursor=2>; rel="next"' },
      "https://huggingface.co/api/models/a/b/tree/main?cursor=2": { text: JSON.stringify([{ path: "m-Q4_K_M-00002-of-00002.gguf", size: 2 }]) },
    };
    setTransport(async (req) => (pages[req.url] ? { status: 200, ...pages[req.url] } : { status: 500 }));
    try {
      const full = await fetchHfTree("a/b");
      expect(full.files).toHaveLength(2);
      expect(full.complete).toBe(true);
      delete pages["https://huggingface.co/api/models/a/b/tree/main?cursor=2"];
      const cut = await fetchHfTree("a/b");
      expect(cut.complete).toBe(false);
    } finally {
      setTransport(fetchTransport());
    }
  });
});

describe("Live / Normal use on samples", () => {
  it("a sample starts on Normal use, and Live stays available", async () => {
    const { useStore } = await import("../state/store");
    useStore.getState().setSettings({ memoryBasis: "live" });
    useStore.getState().setSample({ kind: "desktop", gpu: "GeForce RTX 4090", vramGiB: 24, gpuCount: 1, ramGiB: 64 });
    expect(useStore.getState().settings.memoryBasis).toBe("planning");
    const m = buildMachineProfile(buildSample({ kind: "desktop", gpu: "GeForce RTX 4090", vramGiB: 24, gpuCount: 1, ramGiB: 64 }).report, EMPTY_OVERRIDES);
    expect(m.ramFree).not.toBeNull(); // so the Live choice can be shown and used
    expect(estimate(model({ total: 8, dense: true }), settings({ memoryBasis: "live" }), m).pools.ramMode).toBe("live");
  });
});
