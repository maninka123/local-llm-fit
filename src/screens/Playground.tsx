import { useMemo, useState } from "react";
import { ArrowRight, Boxes, Image, RotateCcw, Sparkles } from "lucide-react";
import { useStore } from "../state/store";
import { useMachine } from "../state/derived";
import { addEvidence, emptyCapabilities } from "../domain/capabilities";
import { estimate } from "../domain/estimator";
import { quantInfo } from "../domain/quant";
import type { ModelVariant, QuantId } from "../domain/types";
import { fmtBytes, fmtParams, fmtTokens } from "../lib/units";
import { AnimatedBytes, ConfidenceMeter, FitPill, Seg, TONE_VAR, SpeedLabel } from "../components/ui";
import { IsoViz } from "../components/IsoViz";
import { MachineSetupCard } from "../components/MachineSetup";
import { SimilarModels } from "../components/SimilarModels";

// Interactive "build a model" playground: drag sizes, pick precision/context/inputs,
// and watch the model's memory blocks settle into VRAM and RAM.

interface Params {
  kind: "dense" | "moe";
  totalB: number;
  activeB: number;
  quant: QuantId;
  ctx: number;
  images: number;
  sessions: number;
}

const PRESETS: { label: string; hint: string; p: Partial<Params> }[] = [
  { label: "Tiny 3B", hint: "Phones, laptops, quick tasks", p: { kind: "dense", totalB: 3 } },
  { label: "Small 8B", hint: "The popular all-rounder size", p: { kind: "dense", totalB: 8 } },
  { label: "Medium 14B", hint: "Noticeably smarter", p: { kind: "dense", totalB: 14 } },
  { label: "Large 32B", hint: "Strong, needs a big GPU", p: { kind: "dense", totalB: 32 } },
  { label: "Huge 70B", hint: "Workstation territory", p: { kind: "dense", totalB: 70 } },
  { label: "MoE 30B · 3B active", hint: "Big brain, small per-word cost", p: { kind: "moe", totalB: 30, activeB: 3 } },
  { label: "MoE 120B · 5B active", hint: "Very large Mixture-of-Experts", p: { kind: "moe", totalB: 120, activeB: 5 } },
];

const QUANTS: QuantId[] = ["F16", "Q8_0", "Q6_K", "Q5_K_M", "Q4_K_M", "Q3_K_M", "Q2_K"];
const CTX = [2048, 4096, 8192, 16384, 32768, 65536, 131072];
const SHORT_Q: Partial<Record<QuantId, string>> = { F16: "FP16", Q8_0: "Q8", Q6_K: "Q6", Q5_K_M: "Q5", Q4_K_M: "Q4", Q3_K_M: "Q3", Q2_K: "Q2" };
const MIN_B = 0.5;
const MAX_B = 700;
const toSlider = (b: number) => Math.round((Math.log(b / MIN_B) / Math.log(MAX_B / MIN_B)) * 1000);
const fromSlider = (t: number) => {
  const v = MIN_B * Math.pow(MAX_B / MIN_B, t / 1000);
  return v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
};

function customModel(p: Params): ModelVariant {
  const caps = emptyCapabilities();
  caps.inputs.text = addEvidence(caps.inputs.text, { status: "verified_supported", scope: "user", source: "Playground" });
  if (p.images > 0) caps.inputs.image = addEvidence(caps.inputs.image, { status: "verified_supported", scope: "user", source: "Playground" });
  return {
    id: "playground",
    family: "playground",
    variant: "custom",
    displayName: "Your model",
    resolvedTag: null,
    lookupCandidate: "",
    origin: "user",
    totalParamsB: { value: p.totalB, provenance: "user_entered" },
    activeParamsB: p.kind === "moe" ? { value: Math.min(p.activeB, p.totalB), provenance: "user_entered" } : { value: null, provenance: "unknown" },
    architecture: { value: p.kind, provenance: "user_entered" },
    contextMax: { value: null, provenance: "unknown" },
    artifacts: [],
    arch: null,
    capabilities: caps,
    useCases: ["general"],
    sourceUrls: [],
    lastVerified: null,
    notes: [],
  };
}

export function Playground() {
  const hw = useStore((s) => s.hardware);
  const settings = useStore((s) => s.settings);
  const navigate = useStore((s) => s.navigate);
  const machine = useMachine();
  const [p, setP] = useState<Params>({ kind: "dense", totalB: 8, activeB: 3, quant: "Q4_K_M", ctx: 8192, images: 0, sessions: 1 });
  const set = (q: Partial<Params>) => setP((cur) => ({ ...cur, ...q, activeB: Math.min(q.activeB ?? cur.activeB, q.totalB ?? cur.totalB) }));

  const runSettings = useMemo(() => ({ ...settings, contextTokens: p.ctx, parallel: p.sessions, imageCount: p.images, imageResolution: 896 }), [settings, p.ctx, p.sessions, p.images]);
  const est = useMemo(() => {
    if (!machine) return null;
    return estimate(customModel(p), { ...runSettings, quant: p.quant }, machine);
  }, [p, runSettings, machine]);

  if (!hw || !machine || !est) return <div className="card" style={{ marginTop: 24 }}>Detecting hardware…</div>;


  return (
    <div className="grid" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow">Playground</div>
          <h1>Build a model. See where it fits.</h1>
          <p>Drag the size, choose precision and context, and watch the model's memory blocks settle into your graphics memory and RAM.</p>
        </div>
        <button className="btn primary" onClick={() => navigate({ page: "run" })}>
          What can I run? <ArrowRight size={16} />
        </button>
      </div>

      {hw.mode === "browser" && !hw.browserConfirmed && <MachineSetupCard />}

      <section className="card" aria-label="Quick presets">
        <div className="row" style={{ gap: 8 }}>
          <span className="eyebrow" style={{ marginRight: 6 }}>
            Start from
          </span>
          {PRESETS.map((pr) => (
            <button key={pr.label} className="fchip" data-tip={pr.hint} onClick={() => set({ activeB: 3, ...pr.p })}>
              {pr.label}
            </button>
          ))}
        </div>
      </section>

      <div className="playground">
        <section className="card pg-controls" aria-label="Model settings">
          <div className="pg-control">
            <div className="control-label">
              <span>Model type</span>
            </div>
            <Seg
              label="Model type"
              value={p.kind}
              onChange={(v) => set({ kind: v })}
              options={[
                { value: "dense", label: "Dense", title: "Every weight works on every word" },
                { value: "moe", label: "Mixture of Experts", title: "Only a few experts work on each word" },
              ]}
            />
          </div>

          <div className="pg-control">
            <div className="control-label">
              <span>Total parameters</span>
              <b className="pg-value num">{fmtParams(p.totalB)}</b>
            </div>
            <input type="range" min={0} max={1000} value={toSlider(p.totalB)} onChange={(e) => set({ totalB: fromSlider(+e.target.value) })} aria-label="Total parameters" />
            <div className="pg-scale">
              <span>0.5B</span>
              <span>8B</span>
              <span>70B</span>
              <span>700B</span>
            </div>
          </div>

          {p.kind === "moe" && (
            <div className="pg-control appear">
              <div className="control-label">
                <span>Active per word</span>
                <b className="pg-value num" style={{ color: "var(--seg-active)" }}>
                  {fmtParams(Math.min(p.activeB, p.totalB))}
                </b>
              </div>
              <input
                type="range"
                min={0}
                max={1000}
                value={toSlider(Math.min(p.activeB, p.totalB))}
                onChange={(e) => set({ activeB: Math.min(fromSlider(+e.target.value), p.totalB) })}
                aria-label="Active parameters"
              />
              <span className="field-hint">All experts are stored in memory; only these do the work for each word.</span>
            </div>
          )}

          <div className="pg-control">
            <div className="control-label">
              <span>Precision (quantization)</span>
              <span className="faint">{quantInfo(p.quant).bitsPerWeight} bits</span>
            </div>
            <Seg label="Quantization" value={p.quant} onChange={(v) => set({ quant: v })} options={QUANTS.map((q) => ({ value: q, label: SHORT_Q[q] ?? q, title: quantInfo(q).blurb }))} />
            <span className="field-hint">{quantInfo(p.quant).blurb}</span>
          </div>

          <div className="pg-control">
            <div className="control-label">
              <span>Conversation length (context)</span>
              <b className="pg-value num">{fmtTokens(p.ctx)}</b>
            </div>
            <Seg label="Context length" value={p.ctx} onChange={(v) => set({ ctx: v })} options={CTX.map((c) => ({ value: c, label: fmtTokens(c) }))} />
          </div>

          <div className="pg-row">
            <div className="pg-control">
              <div className="control-label">
                <span>
                  <Image size={14} style={{ verticalAlign: -2 }} /> Images per message
                </span>
              </div>
              <Seg label="Images" value={p.images} onChange={(v) => set({ images: v })} options={[0, 1, 2, 4].map((n) => ({ value: n, label: n === 0 ? "None" : String(n) }))} />
            </div>
            <div className="pg-control">
              <div className="control-label">
                <span>People chatting at once</span>
              </div>
              <Seg label="Sessions" value={p.sessions} onChange={(v) => set({ sessions: v })} options={[1, 2, 4].map((n) => ({ value: n, label: String(n) }))} />
            </div>
          </div>

          <button className="btn ghost sm" onClick={() => setP({ kind: "dense", totalB: 8, activeB: 3, quant: "Q4_K_M", ctx: 8192, images: 0, sessions: 1 })}>
            <RotateCcw size={14} /> Reset
          </button>
        </section>

        <div className="grid" style={{ gap: 18, alignContent: "start" }}>
          <section className="verdict pop-on-change" key={est.classification} style={{ ["--vc" as string]: TONE_VAR[est.classification] }} aria-live="polite">
            <div className="row">
              <FitPill cls={est.classification} />
              <ConfidenceMeter c={est.confidence} />
            </div>
            <h2>{est.headline}.</h2>
            <p>{est.summary}</p>
            <div className="row" style={{ marginTop: 14, gap: 26 }}>
              <div>
                <div className="eyebrow">Needs</div>
                <div className="pg-big">
                  <AnimatedBytes bytes={est.totalNeed?.mid ?? null} />
                </div>
              </div>
              <div>
                <div className="eyebrow">{machine.arch === "discrete" ? "GPU memory free" : machine.arch === "unified" ? "GPU can use" : "RAM free"}</div>
                <div className="pg-big">
                  <AnimatedBytes bytes={machine.arch === "discrete" ? est.pools.vramUsable : machine.arch === "unified" ? Math.min(est.pools.unifiedGpuLimit ?? Infinity, est.pools.ramUsable ?? Infinity) : est.pools.ramUsable} />
                </div>
              </div>
              {est.speed && (
                <div>
                  <div className="eyebrow">Speed (guess)</div>
                  <div className="pg-big">
                    <SpeedLabel est={est} large />
                  </div>
                </div>
              )}
              {est.placement && est.placement.gpuFraction > 0 && est.placement.gpuFraction < 1 && (
                <div>
                  <div className="eyebrow">On the GPU</div>
                  <div className="pg-big num">{Math.round(est.placement.gpuFraction * 100)}%</div>
                </div>
              )}
            </div>
          </section>

          <section className="card" aria-labelledby="iso-title">
            <div className="card-head">
              <div>
                <h2 id="iso-title">
                  <Boxes size={19} style={{ verticalAlign: -3, marginRight: 6 }} />
                  Where the blocks go
                </h2>
                <p>
                  {fmtParams(p.totalB)} {p.kind === "moe" ? `MoE (${fmtParams(Math.min(p.activeB, p.totalB))} active)` : "dense"} · {quantInfo(p.quant).label} · {fmtTokens(p.ctx)} context
                  {p.images ? ` · ${p.images} image${p.images > 1 ? "s" : ""}` : ""}
                </p>
              </div>
            </div>
            <IsoViz est={est} machine={machine} />
          </section>

          <SimilarModels shape={{ kind: p.kind, totalB: p.totalB, activeB: Math.min(p.activeB, p.totalB), quant: p.quant, images: p.images }} settings={runSettings} />
          <p className="faint" style={{ fontSize: 13.5, margin: "-4px 4px 0" }}>
            <Sparkles size={13} style={{ verticalAlign: -2 }} /> The blocks above are estimates for a typical model of this shape ({fmtBytes(est.weights?.mid ?? 0, "GB")} of weights). Real models vary; their cards use real file sizes.
          </p>
        </div>
      </div>
    </div>
  );
}
