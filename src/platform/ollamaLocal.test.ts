import { describe, expect, it } from "vitest";
import { archFromModelInfo, computeRates, modelFromInstalled, placementFromPs, runBenchmark, OllamaClient, type OllamaTransport } from "./ollamaLocal";
import { resolveInput, resolveOutput } from "../domain/capabilities";

describe("Ollama metrics", () => {
  it("converts nanosecond durations into generation and prompt throughput", () => {
    const r = computeRates({ eval_count: 120, eval_duration: 2_000_000_000, prompt_eval_count: 50, prompt_eval_duration: 250_000_000, load_duration: 3e9, total_duration: 5.5e9 });
    expect(r.generationTokPerSec).toBe(60);
    expect(r.promptTokPerSec).toBe(200);
  });
  it("derives residency only from /api/ps sizes", () => {
    expect(placementFromPs({ name: "a", model: "a", size: 10, size_vram: 10, digest: "" })).toBe("gpu_100");
    expect(placementFromPs({ name: "a", model: "a", size: 10, size_vram: 4, digest: "" })).toBe("mixed");
    expect(placementFromPs({ name: "a", model: "a", size: 10, size_vram: 0, digest: "" })).toBe("cpu_100");
    expect(placementFromPs(undefined)).toBe("unknown");
  });
  it("maps /api/show model_info to architecture metadata", () => {
    const a = archFromModelInfo({ "general.architecture": "qwen3moe", "qwen3moe.block_count": 48, "qwen3moe.attention.head_count": 32, "qwen3moe.attention.head_count_kv": 4, "qwen3moe.attention.key_length": 128, "qwen3moe.expert_count": 128, "qwen3moe.expert_used_count": 8 }, "t")!;
    expect(a).toMatchObject({ layers: 48, kvHeads: 4, keyDim: 128, expertCount: 128, expertUsedCount: 8 });
  });
  it("builds an installed model with local evidence (embedding model → no chat output)", () => {
    const m = modelFromInstalled(
      { name: "nomic-embed-text:latest", model: "nomic-embed-text:latest", size: 274302450, digest: "0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f", details: { parameter_size: "137M", quantization_level: "F16" } },
      { capabilities: ["embedding"] },
      undefined,
      "2026-10-10",
    );
    expect(m.installed?.name).toBe("nomic-embed-text:latest");
    expect(resolveOutput(m.capabilities, "text").status).toBe("verified_unsupported");
    expect(resolveInput(m.capabilities, "image").status).toBe("verified_unsupported");
    expect(m.totalParamsB.value).toBe(0.137);
  });
});

describe("benchmark runner (mock Ollama)", () => {
  it("runs sequentially, measures TTFT from the stream and reads placement", async () => {
    const calls: string[] = [];
    const t: OllamaTransport = {
      async request(_m, path, body) {
        calls.push(path + ((body as { keep_alive?: number })?.keep_alive === 0 ? ":unload" : ""));
        if (path === "/api/ps") return { models: [{ name: "m:1", model: "m:1", size: 100, size_vram: 100, digest: "d" }] } as never;
        return {} as never;
      },
      async stream(path, _body, onLine) {
        calls.push(path);
        onLine({ response: "" });
        onLine({ response: "Hello" });
        onLine({ done: true, eval_count: 100, eval_duration: 1e9, prompt_eval_count: 20, prompt_eval_duration: 1e8, load_duration: 5e8, total_duration: 1.7e9 });
      },
    };
    const r = await runBenchmark(new OllamaClient(t), { model: "m:1", contextTokens: 4096, kind: "cold", meta: {} });
    expect(calls).toEqual(["/api/generate:unload", "/api/generate", "/api/ps"]);
    expect(r.generationTokPerSec).toBe(100);
    expect(r.promptTokPerSec).toBe(200);
    expect(r.ttftMs).toBeDefined();
    expect(r.placement).toBe("gpu_100");
    expect(r.temperature).toBe(0);
  });
});
