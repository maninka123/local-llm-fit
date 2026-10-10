import type { UseCase } from "../domain/types";

// Developer names and use-case hints derived from the family NAME only.
// These are display/category hints, not verified model facts.
const DEVELOPERS: [RegExp, string][] = [
  [/^(llama|codellama|llama-guard)/, "Meta"],
  [/^(qwen|qwq)/, "Alibaba Qwen"],
  [/^(gemma|codegemma|shieldgemma|translategemma)/, "Google"],
  [/^(mistral|mixtral|codestral|magistral|ministral|devstral)/, "Mistral AI"],
  [/^phi/, "Microsoft"],
  [/^deepseek/, "DeepSeek"],
  [/^granite/, "IBM"],
  [/^nemotron/, "NVIDIA"],
  [/^gpt-oss/, "OpenAI"],
  [/^(command-r|aya)/, "Cohere"],
  [/^(falcon)/, "TII"],
  [/^(olmo)/, "Ai2"],
  [/^(smollm)/, "Hugging Face"],
  [/^(starcoder)/, "BigCode"],
  [/^(yi)/, "01.AI"],
  [/^(internlm)/, "Shanghai AI Lab"],
  [/^(glm)/, "Zhipu AI"],
  [/^(lfm)/, "Liquid AI"],
  [/^(minicpm)/, "OpenBMB"],
  [/^(stablelm)/, "Stability AI"],
  [/^(llava|moondream|vicuna|orca|wizard|dolphin|hermes|openthinker|cogito|deepcoder|sqlcoder)/, "Community"],
];

export function developerFor(family: string): string | undefined {
  const f = family.toLowerCase();
  return DEVELOPERS.find(([re]) => re.test(f))?.[1];
}

export function useCasesFor(family: string, modality: string): UseCase[] {
  const f = family.toLowerCase();
  const out = new Set<UseCase>();
  if (/coder|code|codestral|devstral|starcoder|sqlcoder/.test(f)) out.add("coding");
  if (/r1|qwq|reason|think|magistral|openthinker|deepcoder|cogito|gpt-oss/.test(f)) out.add("reasoning");
  if (/embed/.test(f) || modality === "embedding") out.add("embedding");
  if (/vision|vl\b|vl$|llava|moondream|minicpm-v/.test(f) || modality.includes("vision")) out.add("vision");
  if (/math/.test(f)) out.add("math");
  if (/guard|shield/.test(f)) out.add("safety");
  if (out.size === 0) out.add("general");
  return [...out];
}
