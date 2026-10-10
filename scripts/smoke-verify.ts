import { verifyOllamaVariant, fetchLibraryIndex } from "../src/catalog/ollamaOfficial";
const idx = await fetchLibraryIndex();
console.log("library entries", idx.length, idx.slice(0, 3).map((e) => `${e.name}[${e.capabilities}] ${e.sizes}`));
for (const [f, v] of [["gemma3", "4b"], ["gpt-oss", "20b"], ["qwen3", "30b"], ["llama3.1", "8b"], ["nomic-embed-text", "v1.5"]]) {
  const r = await verifyOllamaVariant(f, v, { badges: idx.find((e) => e.name === f)?.capabilities, maxTags: 3 });
  console.log(f, v, r.totalParamsB, r.contextTokens, r.cloudOnly, JSON.stringify(r.arch && { ...r.arch, source: undefined, sourceUrl: undefined, checkedAt: undefined }));
  console.log("  ", r.artifacts.map((a) => `${a.tag} ${a.quantLabel} w=${a.weightBytes} proj=${a.projectorBytes ?? "-"}`).join(" | "), r.errors);
}
