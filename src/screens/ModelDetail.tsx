import { useEffect, useMemo, useState } from "react";
import { Select } from "../components/Select";
import { AlertTriangle, ArrowLeft, BadgeCheck, ChevronDown, Columns3, Download, ExternalLink, FlaskConical, Info, Layers, RefreshCw, ShieldAlert, Sparkles, OctagonAlert } from "lucide-react";
import { useStore } from "../state/store";
import { ageText, isStale, latestBenchmark, useMeasuredBenchmarks, useBenchContext, quantFor, useMachine } from "../state/derived";
import { estimate, publishedQuants, CLASS_META, type Estimate, type EstimatorSettings } from "../domain/estimator";
import { QUANT_SELECTOR, quantInfo } from "../domain/quant";
import { resolveInput } from "../domain/capabilities";
import type { ModelVariant, QuantId } from "../domain/types";
import { fmtBytes, fmtKiB, fmtParams, fmtRange, fmtTokens } from "../lib/units";
import { AnimatedBytes, Avatar, ConfidenceMeter, FitPill, Modal, Prov, Seg, Switch, TONE_VAR, Empty, SpeedLabel } from "../components/ui";
import { CapabilityPanel, CapabilityStrip } from "../components/Capabilities";
import { MemoryViz } from "../components/MemoryViz";
import { BenchmarkPanel } from "../components/BenchmarkPanel";
import { verifyOllamaVariant } from "../catalog/ollamaOfficial";
import { canReachOllamaCom, ollama } from "../platform/bridge";
import { smokeTest } from "../platform/ollamaLocal";

const CONTEXTS = [2048, 4096, 8192, 16384, 32768, 65536, 131072];

export function ModelDetail({ id }: { id: string }) {
  const model = useStore((s) => s.catalog.get(id));
  const catalogSize = useStore((s) => s.catalog.size);
  const navigate = useStore((s) => s.navigate);
  if (!model) {
    return (
      <div className="card" style={{ marginTop: 24 }}>
        <Empty icon={<Layers size={34} />} title={catalogSize ? "Model not found" : "Loading catalog…"}>
          {catalogSize > 0 && (
            <button className="btn" onClick={() => navigate({ page: "explore" })}>
              Back to Explorer
            </button>
          )}
        </Empty>
      </div>
    );
  }
  return <Detail m={model} />;
}

function Detail({ m }: { m: ModelVariant }) {
  const navigate = useStore((s) => s.navigate);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const choice = useStore((s) => s.quantChoice);
  const per = useStore((s) => s.perModelQuant);
  const setModelQuant = useStore((s) => s.setModelQuant);
  const compare = useStore((s) => s.compare);
  const toggleCompare = useStore((s) => s.toggleCompare);
  const benches = useMeasuredBenchmarks();
  const machine = useMachine();
  const [showActive, setShowActive] = useState(true);
  const [moeOpen, setMoeOpen] = useState(false);
  const [imagesOn, setImagesOn] = useState(settings.imageCount > 0);

  const quant = quantFor(m, choice, per);
  const est: Estimate | null = useMemo(() => (machine ? estimate(m, { ...settings, quant }, machine) : null), [m, settings, quant, machine]);
  const published = publishedQuants(m);
  const benchCtx = useBenchContext();
  const bench = latestBenchmark(benches, m, { ...benchCtx, quant: est?.quant });
  const hw = useStore((s) => s.hardware);
  const running = useStore((s) => s.ollamaState.running);
  const loadedNow = !!m.installed && running.some((r) => r.name === m.installed!.name || r.digest === m.installed!.digest);
  const ctxMax = m.contextMax.value ?? m.arch?.contextLength ?? null;
  const imgStatus = resolveInput(m.capabilities, "image").status;

  useEffect(() => {
    if (!imagesOn && settings.imageCount > 0) setSettings({ imageCount: 0 });
  }, [imagesOn, settings.imageCount, setSettings]);

  if (!machine || !est) return null;
  const vc = TONE_VAR[est.classification];
  const stale = isStale(m.lastVerified);

  return (
    <div>
      <div className="page-head">
        <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
          <button className="btn ghost icon-btn" onClick={() => history.length > 1 ? history.back() : navigate({ page: "explore" })} aria-label="Back">
            <ArrowLeft size={18} />
          </button>
          <Avatar name={m.family} developer={m.developer} large />
          <div style={{ minWidth: 0 }}>
            <div className="eyebrow">{m.developer ?? "Model"} · {m.origin.replace("_", " ")}</div>
            <h1 style={{ wordBreak: "break-word" }}>{m.displayName}</h1>
            <div className="row" style={{ marginTop: 8, gap: 8 }}>
              {m.resolvedTag ? (
                <span className="badge verified">
                  <BadgeCheck size={12} /> Ollama tag <span className="mono">{m.resolvedTag}</span>
                </span>
              ) : (
                <span className="badge" title="suggested_lookup from the seed: a lookup candidate, not a verified runnable command">
                  Lookup candidate <span className="mono">{m.lookupCandidate}</span> · not verified
                </span>
              )}
              <span className={`badge ${m.lastVerified ? (stale ? "estimated" : "verified") : ""}`}>
                {m.lastVerified ? `Last verified ${ageText(m.lastVerified)}` : "Never verified"}
              </span>
              {m.installed && (
                <span className="badge">
                  <Download size={12} /> Installed · {fmtBytes(m.installed.sizeBytes, "GB")}
                </span>
              )}
              {m.cloudOnly && <span className="badge estimated">Cloud-only tag (not local)</span>}
            </div>
            {m.description && <p style={{ marginTop: 10 }}>{m.description}</p>}
          </div>
        </div>
        <div className="row">
          <VerifyButton m={m} />
          <button className={`btn ${compare.includes(m.id) ? "" : ""}`} aria-pressed={compare.includes(m.id)} onClick={() => toggleCompare(m.id)}>
            <Columns3 size={15} /> {compare.includes(m.id) ? "In Compare" : "Compare"}
          </button>
        </div>
      </div>

      {stale && (
        <div className="warning warn" style={{ marginBottom: 14 }}>
          <AlertTriangle size={16} />
          <span>This record was last verified {ageText(m.lastVerified)}. Tags and file sizes can change; re-verify before relying on it.</span>
        </div>
      )}

      <div className="detail-grid">
        <div className="grid" style={{ gap: 18 }}>
          <section className="verdict" style={{ ["--vc" as string]: vc }} aria-live="polite">
            <div className="row">
              <FitPill cls={est.classification} cloud={m.cloudOnly} />
              <ConfidenceMeter c={est.confidence} />
              <SpeedLabel est={est} measured={bench?.generationTokPerSec} />
              {est.quantSource !== "published" && <span className="badge estimated">Hypothetical {quantInfo(quant).label} size</span>}
            </div>
            <h2>Can this model fit? {est.headline}.</h2>
            <p>{m.cloudOnly ? "Only cloud tags exist for this variant on ollama.com, so it is not a downloadable local model. The estimate below is hypothetical." : est.summary}</p>
            {bench?.generationTokPerSec != null ? (
              <p style={{ marginTop: 10 }}>
                <b style={{ color: "var(--good)" }}>Measured {bench.generationTokPerSec.toFixed(1)} tok/s on this computer</b>{" "}
                <span className="faint">
                  ({bench.kind} run, {fmtTokens(bench.contextTokens)} context, {new Date(bench.createdAt).toLocaleDateString()}). Measurements are specific to this machine and settings.
                </span>
              </p>
            ) : (
              <p className="faint" style={{ marginTop: 10, fontSize: 14.5 }}>
                No speed measurement yet. The tok/s figure is a rough guess from memory speed; run a local test to measure the real speed.
              </p>
            )}
            <div className="row" style={{ marginTop: 14, gap: 22 }}>
              <Stat label="Total need" value={<AnimatedBytes bytes={est.totalNeed?.mid ?? null} />} sub={est.totalNeed ? fmtRange(est.totalNeed) : undefined} />
              {machine.arch === "discrete" && <Stat label="Usable VRAM" value={<AnimatedBytes bytes={est.pools.vramUsable} />} sub={est.pools.vramMode === "live" ? "live" : "planning"} />}
              {machine.arch === "unified" && <Stat label="GPU working set" value={<AnimatedBytes bytes={est.pools.unifiedGpuLimit} />} sub={machine.unifiedGpuLimitSource} />}
              <Stat label={machine.arch === "unified" ? "Usable unified" : "Usable RAM"} value={<AnimatedBytes bytes={est.pools.ramUsable} />} sub={est.pools.ramFree != null ? "live" : "planning"} />
              {est.classification !== "cannot_fit" && est.placement && est.placement.gpuFraction < 1 && est.placement.gpuFraction > 0 && (
                <Stat label="Planned on GPU" value={<span className="num">{Math.round(est.placement.gpuFraction * 100)}%</span>} sub="simulation" />
              )}
            </div>
          </section>

          <section className="card" aria-labelledby="viz-title">
            <div className="card-head" style={{ flexWrap: "wrap" }}>
              <div>
                <h2 id="viz-title">Where this model would live</h2>
                <p>Same scale for every bar. Hover any block for exact values. Placement is a planned simulation, not observed.</p>
              </div>
              <div className="row">
                {est.active && <Switch checked={showActive} onChange={setShowActive} label="Show active per token" />}
                {est.isMoE && (
                  <button className="btn sm" onClick={() => setMoeOpen(true)}>
                    <Sparkles size={14} /> Why MoE is special?
                  </button>
                )}
              </div>
            </div>
            <MemoryViz est={est} machine={machine} showActive={showActive} />
          </section>

          {(est.warnings.length > 0 || loadedNow) && (
            <section className="warnings" aria-label="Warnings">
              {loadedNow && hw?.mode === "native" && (
                <div className="warning info">
                  <Info size={16} color="var(--accent)" />
                  <span>This model is loaded in Ollama right now, so its memory already counts as used. The estimate may look tighter than it really is; unload it (ollama stop) and rescan for a clean reading.</span>
                </div>
              )}
              {est.warnings.map((w, i) => (
                <div key={i} className={`warning ${w.level}`}>
                  {w.level === "danger" ? <OctagonAlert size={16} color="var(--bad)" /> : w.level === "warn" ? <AlertTriangle size={16} color="var(--warn)" /> : <Info size={16} color="var(--accent)" />}
                  <span>{w.text}</span>
                </div>
              ))}
            </section>
          )}

          <details className="drawer">
            <summary>
              <Info size={16} /> Why this result? Equations, sources and assumptions <ChevronDown size={16} className="chev" />
            </summary>
            <div>
              <table className="eq-table">
                <tbody>
                  {est.equations.map((l, i) => (
                    <tr key={i}>
                      <td>
                        <b>{l.label}</b>
                        {l.detail && <div className="detail">{l.detail}</div>}
                      </td>
                      <td className="num">{l.value}</td>
                      <td style={{ width: 90 }}>
                        <Prov p={l.provenance} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="stack" style={{ marginTop: 12, gap: 6 }}>
                <b style={{ fontSize: 14.5 }}>Classification at the uncertainty bounds</b>
                <span className="faint" style={{ fontSize: 14 }}>
                  Low: {CLASS_META[est.classAtLevels.low].title} · Mid: {CLASS_META[est.classAtLevels.mid].title} · High: {CLASS_META[est.classAtLevels.high].title}
                </span>
                <b style={{ fontSize: 14.5, marginTop: 6 }}>Assumptions</b>
                <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-2)", fontSize: 14.5 }}>
                  {est.assumptions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                  <li>Speed is never derived from parameter counts alone. Only a local test measures tokens per second.</li>
                </ul>
              </div>
            </div>
          </details>

          <section className="card" aria-labelledby="facts-title">
            <div className="card-head">
              <div>
                <h2 id="facts-title">Model facts</h2>
                <p>Each value shows where it came from.</p>
              </div>
            </div>
            <div className="facts">
              <Fact label="Total parameters" value={fmtParams(m.totalParamsB.value)} prov={m.totalParamsB.provenance} title={m.totalParamsB.source} />
              <Fact
                label="Active parameters"
                value={m.activeParamsB.value != null ? fmtParams(m.activeParamsB.value) : m.architecture.value === "dense" ? "All (dense)" : "Unknown"}
                prov={m.activeParamsB.value != null ? m.activeParamsB.provenance : m.architecture.value === "dense" ? "derived" : "unknown"}
                title={m.activeParamsB.note ?? m.activeParamsB.source}
              />
              <Fact label="Architecture" value={m.architecture.value === "moe" ? "Mixture of Experts" : m.architecture.value === "dense" ? "Dense" : "Unknown"} prov={m.architecture.provenance} title={m.architecture.note ?? m.architecture.source} />
              {m.arch?.expertCount ? <Fact label="Experts" value={`${m.arch.expertUsedCount ?? "?"} of ${m.arch.expertCount} per token`} prov={m.arch.provenance} title={m.arch.source} /> : null}
              <Fact label="Layers · KV heads" value={m.arch?.layers ? `${m.arch.layers} · ${m.arch.kvHeads != null ? +m.arch.kvHeads.toFixed(2) : "?"}` : "Unknown"} prov={m.arch?.provenance ?? "unknown"} title={m.arch?.source} />
              <Fact label="Max context" value={ctxMax ? fmtTokens(ctxMax) : "Unknown"} prov={m.contextMax.provenance !== "unknown" ? m.contextMax.provenance : m.arch?.contextLength ? "verified" : "unknown"} title={m.contextMax.source} />
              <Fact label={`Weights (${est.artifact?.quantLabel ?? quantInfo(quant).label})`} value={est.weights ? fmtRange(est.weights, "GB") : "Unknown"} prov={est.weightsProvenance} title={est.equations[0]?.detail} />
              <Fact label="Download size" value={est.artifact?.downloadBytes ? fmtBytes(est.artifact.downloadBytes, "GB", 2) : "Not a known file"} prov={est.artifact ? est.artifact.provenance : "unknown"} title={est.artifact?.source} />
              <Fact label="KV cache / token" value={fmtKiB(est.kvPerToken)} prov={est.kvMethod === "metadata" ? "derived" : "heuristic"} />
            </div>
            <div className="divider" />
            <div className="row" style={{ fontSize: 14.5 }}>
              <span className="faint">Sources:</span>
              {m.sourceUrls.map((u) => (
                <a key={u} href={u} target="_blank" rel="noreferrer noopener">
                  {u.replace("https://", "")} <ExternalLink size={12} />
                </a>
              ))}
              {m.seedSnapshotDate && <span className="faint">· seed snapshot {m.seedSnapshotDate}</span>}
            </div>
            {m.notes.length > 0 && (
              <ul style={{ margin: "10px 0 0", paddingLeft: 18, fontSize: 14, color: "var(--text-3)" }}>
                {m.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="caps-title">
            <div className="card-head">
              <div>
                <h2 id="caps-title">What it accepts and produces</h2>
                <p>Per exact tag where verified. Ollama runtime support is shown separately from the model's own capability.</p>
              </div>
              <CapabilityStrip caps={m.capabilities} />
            </div>
            <CapabilityPanel caps={m.capabilities} />
            <SmokeTests m={m} />
          </section>

          <BenchmarkPanel m={m} est={est} />
        </div>

        <aside className="controls" aria-label="Estimate settings">
          <section className="card">
            <div className="control-label">
              <span>Quantization</span>
              <span className="faint">{est.quantSource === "published" ? "Published file" : "Hypothetical estimate"}</span>
            </div>
            <Seg
              label="Quantization"
              value={quant}
              onChange={(q: QuantId) => setModelQuant(m.id, q)}
              options={[...new Set<QuantId>([...QUANT_SELECTOR, ...published.filter((q) => q !== "OTHER")])].map((q) => ({
                value: q,
                label: quantInfo(q).label,
                dot: published.includes(q),
                className: published.includes(q) ? "" : "hypo",
                title: published.includes(q) ? "A published file exists for this quantization" : "No published file known: hypothetical size estimate",
              }))}
            />
            <p className="field-hint" style={{ margin: "8px 0 0" }}>
              <span style={{ color: "var(--good)" }}>●</span> published file exists · <i>italic</i> = hypothetical. {quantInfo(quant).blurb}
            </p>

            {machine.ramFree != null && (<><div className="divider" />
            <div className="control-label">
              <span>Memory to plan for</span>
            </div>
            <Seg
              label="Memory to plan for"
              value={settings.memoryBasis}
              onChange={(v) => setSettings({ memoryBasis: v })}
              options={[
                { value: "live", label: "Live" },
                { value: "planning", label: "Normal use" },
              ]}
            /></>)}

            <div className="divider" />
            <div className="control-label">
              <span>Context length</span>
              <span className="faint">{ctxMax ? `model max ${fmtTokens(ctxMax)}` : "max unknown"}</span>
            </div>
            <Seg
              label="Context length"
              value={settings.contextTokens}
              onChange={(v) => setSettings({ contextTokens: v })}
              options={CONTEXTS.map((c) => ({ value: c, label: fmtTokens(c), className: ctxMax && c > ctxMax ? "warn-opt" : "", title: ctxMax && c > ctxMax ? "Exceeds this model's maximum context" : undefined }))}
            />

            <div className="divider" />
            <div className="control-label">
              <span>Concurrent sessions</span>
              <span className="faint">each gets its own KV cache</span>
            </div>
            <Seg label="Concurrent sessions" value={settings.parallel} onChange={(v) => setSettings({ parallel: v })} options={[1, 2, 4, 8].map((n) => ({ value: n, label: n === 1 ? "1 (you)" : String(n) }))} />

            <div className="divider" />
            <div className="control-label">
              <span>Input</span>
              <span className="faint">{imgStatus === "verified_supported" ? "images verified" : imgStatus === "family_suggests" ? "images unverified" : imgStatus === "verified_unsupported" ? "text only" : "image support unknown"}</span>
            </div>
            <Seg
              label="Input type"
              value={imagesOn ? "img" : "text"}
              onChange={(v) => {
                setImagesOn(v === "img");
                setSettings({ imageCount: v === "img" ? Math.max(1, settings.imageCount) : 0 });
              }}
              options={[
                { value: "text", label: "Text only" },
                { value: "img", label: "Text + images", className: imgStatus === "verified_unsupported" || imgStatus === "unknown" ? "warn-opt" : "" },
              ]}
            />
            {imagesOn && (
              <div className="stack" style={{ marginTop: 10, gap: 8 }}>
                <label className="field">
                  <span className="row" style={{ justifyContent: "space-between" }}>
                    Images per request <b className="num">{settings.imageCount}</b>
                  </span>
                  <input type="range" min={1} max={8} value={settings.imageCount} onChange={(e) => setSettings({ imageCount: +e.target.value })} />
                </label>
                <label className="field">
                  Image size
                  <Select
                    label="Image size"
                    value={settings.imageResolution}
                    onChange={(v) => setSettings({ imageResolution: v })}
                    options={[
                      { value: 448, label: "Small (~448 px)" },
                      { value: 896, label: "Medium (~896 px)" },
                      { value: 1344, label: "Large (~1344 px)" },
                      { value: 2048, label: "Very large (~2048 px)" },
                    ]}
                  />
                </label>
              </div>
            )}

            <div className="divider" />
            <details>
              <summary style={{ cursor: "pointer", fontWeight: 650, fontSize: 14.5 }}>Advanced</summary>
              <div className="stack" style={{ marginTop: 12 }}>
                <div className="control-label" style={{ margin: 0 }}>
                  <span>KV cache precision</span>
                </div>
                <Seg
                  label="KV cache precision"
                  value={settings.kvCacheType}
                  onChange={(v) => setSettings({ kvCacheType: v })}
                  options={[
                    { value: "f16", label: "f16 (default)" },
                    { value: "q8_0", label: "q8_0" },
                    { value: "q4_0", label: "q4_0" },
                  ]}
                />
                <ReserveControls settings={settings} setSettings={setSettings} ramMode={est.pools.ramMode} vramMode={est.pools.vramMode} />
                <label className="field">
                  Effective bits per weight (hypothetical sizes)
                  <input
                    className="input"
                    type="number"
                    step="0.05"
                    min="1"
                    max="32"
                    placeholder={`${quantInfo(quant).bitsPerWeight} (default for ${quantInfo(quant).label})`}
                    value={settings.customBitsPerWeight ?? ""}
                    onChange={(e) => setSettings({ customBitsPerWeight: e.target.value ? +e.target.value : null })}
                  />
                </label>
                <label className="field">
                  Format overhead on estimates (%)
                  <input className="input" type="number" min="0" max="30" value={settings.formatOverheadPct} onChange={(e) => setSettings({ formatOverheadPct: +e.target.value })} />
                </label>
                <label className="field">
                  Compute scratch allowance (GiB, blank = heuristic)
                  <input
                    className="input"
                    type="number"
                    step="0.1"
                    min="0"
                    value={settings.scratchOverrideGiB ?? ""}
                    onChange={(e) => setSettings({ scratchOverrideGiB: e.target.value ? +e.target.value : null })}
                  />
                </label>
              </div>
            </details>
          </section>
          <section className="card tight">
            <div className="row" style={{ gap: 8, fontSize: 14 }}>
              <ShieldAlert size={15} color="var(--text-3)" />
              <span className="faint">
                Estimates use {est.pools.mode === "live" ? "live free-memory readings" : "planning reserves"}. Settings here apply to every model; quantization is remembered per model.
              </span>
            </div>
          </section>
        </aside>
      </div>
      {moeOpen && <MoeExplainer onClose={() => setMoeOpen(false)} m={m} est={est} />}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div>
      <div className="eyebrow" style={{ fontSize: 12.5 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 750, letterSpacing: "-0.01em" }}>{value}</div>
      {sub && <div className="faint" style={{ fontSize: 13 }}>{sub}</div>}
    </div>
  );
}

function Fact({ label, value, prov, title }: { label: string; value: React.ReactNode; prov: Parameters<typeof Prov>[0]["p"]; title?: string }) {
  return (
    <div className="fact" title={title}>
      <div className="label">{label}</div>
      <div className="value num">{value}</div>
      <div className="prov">
        <Prov p={prov} />
      </div>
    </div>
  );
}

export function ReserveControls({ settings, setSettings, ramMode, vramMode }: { settings: EstimatorSettings; setSettings: (p: Partial<EstimatorSettings>) => void; ramMode: "live" | "planning"; vramMode: "live" | "planning" | null }) {
  const r = settings.reserves;
  const upd = (p: Partial<typeof r>) => setSettings({ reserves: { ...r, ...p } });
  // Each pool shows the reserve that is actually applied to it (live margin or planning %).
  return (
    <>
      {vramMode === "live" && (
        <label className="field">
          <span className="row" style={{ justifyContent: "space-between" }}>
            GPU safety margin <b className="num">{r.liveVramSafetyGiB} GiB</b>
          </span>
          <input type="range" min={0} max={4} step={0.25} value={r.liveVramSafetyGiB} onChange={(e) => upd({ liveVramSafetyGiB: +e.target.value })} />
        </label>
      )}
      {vramMode === "planning" && (
        <label className="field">
          <span className="row" style={{ justifyContent: "space-between" }}>
            VRAM reserve (planning) <b className="num">{r.planningVramReservePct}%</b>
          </span>
          <input type="range" min={0} max={40} step={1} value={r.planningVramReservePct} onChange={(e) => upd({ planningVramReservePct: +e.target.value })} />
        </label>
      )}
      {ramMode === "live" ? (
        <label className="field">
          <span className="row" style={{ justifyContent: "space-between" }}>
            RAM kept for OS &amp; apps <b className="num">{r.liveRamReserveGiB} GiB</b>
          </span>
          <input type="range" min={0} max={16} step={0.5} value={r.liveRamReserveGiB} onChange={(e) => upd({ liveRamReserveGiB: +e.target.value })} />
        </label>
      ) : (
        <label className="field">
          <span className="row" style={{ justifyContent: "space-between" }}>
            RAM reserve (planning) <b className="num">{r.planningRamReservePct}%</b>
          </span>
          <input type="range" min={0} max={50} step={1} value={r.planningRamReservePct} onChange={(e) => upd({ planningRamReservePct: +e.target.value })} />
        </label>
      )}
    </>
  );
}

function VerifyButton({ m }: { m: ModelVariant }) {
  const save = useStore((s) => s.saveVerification);
  const toast = useStore((s) => s.showToast);
  const [busy, setBusy] = useState<string | null>(null);
  const isOllama = m.origin !== "huggingface" && m.origin !== "user";
  if (!isOllama) return null;
  const run = async () => {
    if (!canReachOllamaCom()) {
      toast("Live verification needs the desktop app or the local dev preview (browsers block cross-site requests).", "warn");
      return;
    }
    setBusy("Starting…");
    try {
      const v = await verifyOllamaVariant(m.family, m.variant, { progress: setBusy });
      if (!v.artifacts.length) toast(v.errors[0] ?? "No local tags found for this variant.", "warn");
      else toast(`Verified ${v.artifacts.length} published file(s) from Ollama`, "good");
      save(v);
    } catch (e) {
      toast(`Verification failed: ${(e as Error).message}. Your cached data is unchanged.`, "bad");
    } finally {
      setBusy(null);
    }
  };
  return (
    <button className="btn primary" onClick={() => void run()} disabled={!!busy} title="Fetch exact tags, file sizes and architecture metadata from ollama.com (metadata only, no download)">
      <RefreshCw size={15} className={busy ? "spin" : ""} /> {busy ? busy.slice(0, 34) : m.lastVerified ? "Re-verify from Ollama" : "Verify from Ollama"}
    </button>
  );
}

function SmokeTests({ m }: { m: ModelVariant }) {
  const ol = useStore((s) => s.ollamaState);
  const add = useStore((s) => s.addCapabilityEvidence);
  const toast = useStore((s) => s.showToast);
  const [confirm, setConfirm] = useState<"text" | "image" | null>(null);
  const [busy, setBusy] = useState(false);
  if (ol.status !== "online" || !m.installed) {
    return (
      <p className="field-hint" style={{ marginTop: 12 }}>
        <FlaskConical size={13} style={{ verticalAlign: -2 }} /> Optional smoke tests become available when this model is installed in a running Ollama.
      </p>
    );
  }
  const imgStatus = resolveInput(m.capabilities, "image").status;
  const run = async (kind: "text" | "image") => {
    setConfirm(null);
    setBusy(true);
    try {
      const ev = await smokeTest(ollama(), m.installed!.name, kind);
      add(m.id, kind, ev);
      toast(`${kind === "text" ? "Text" : "Image"} test: ${ev.status.replace("_", " ")}`, ev.status === "verified_supported" ? "good" : "warn");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="row" style={{ marginTop: 14 }}>
      <span className="faint" style={{ fontSize: 14.5 }}>Smoke tests (run locally, on request):</span>
      <button className="btn sm" disabled={busy} onClick={() => setConfirm("text")}>
        <FlaskConical size={14} /> Test text
      </button>
      <button className="btn sm" disabled={busy} onClick={() => setConfirm("image")}>
        <FlaskConical size={14} /> Test image input
      </button>
      {confirm && (
        <Modal title={`Run a ${confirm} smoke test?`} onClose={() => setConfirm(null)}>
          <div className="stack">
            <p className="muted" style={{ margin: 0 }}>
              This sends one tiny {confirm === "image" ? "image (a 64×64 red square) with a short question" : "prompt"} to <span className="mono">{m.installed!.name}</span> in your local Ollama. The model will be loaded into
              memory if it isn't already. Nothing is downloaded and nothing leaves your computer.
            </p>
            {confirm === "image" && imgStatus !== "verified_supported" && imgStatus !== "family_suggests" && (
              <div className="warning warn">
                <AlertTriangle size={16} />
                <span>This model is not known to read images. For scanned documents with a text-only model, use an OCR → text pipeline or pick a vision model instead.</span>
              </div>
            )}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => void run(confirm)}>
                Run test
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function MoeExplainer({ onClose, m, est }: { onClose: () => void; m: ModelVariant; est: Estimate }) {
  const E = m.arch?.expertCount ?? 16;
  const K = m.arch?.expertUsedCount ?? 2;
  const n = Math.min(E, 64);
  const [picked, setPicked] = useState<number[]>(() => pick(n, Math.min(K, n)));
  useEffect(() => {
    if (document.documentElement.classList.contains("reduce-motion")) return;
    const t = setInterval(() => setPicked(pick(n, Math.min(K, n))), 1400);
    return () => clearInterval(t);
  }, [n, K]);
  return (
    <Modal title="Why Mixture-of-Experts is special" onClose={onClose} wide>
      <div className="grid cols-2">
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>
            An MoE model has many "expert" sub-networks. For each word (token), a router picks a few experts to do the work. Four different ideas get mixed up a lot:
          </p>
          <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 8, fontSize: 15.5 }}>
            <li>
              <b>Total weights</b> — every expert must be stored somewhere. Here: <b>{est.weights ? fmtBytes(est.weights.mid) : "unknown"}</b>.
            </li>
            <li>
              <b>Active weights</b> — the part used for one token ({K} of {m.arch?.expertCount ?? "?"} experts plus shared layers): about <b>{est.active ? fmtBytes(est.active.mid) : "unknown"}</b>. It
              changes every token.
            </li>
            <li>
              <b>Weight placement</b> — where the bytes live (VRAM or RAM). Fitting the <i>active</i> size in VRAM does <i>not</i> mean the right experts are there.
            </li>
            <li>
              <b>Execution location</b> — which processor does the math. Experts kept in RAM are usually computed by the CPU, which is slower but only touches a small part per token.
            </li>
          </ol>
          <p className="field-hint">That is why an MoE model that overflows VRAM can still be usable, while a dense model of the same size slows down a lot. Only a local test tells you the real speed.</p>
        </div>
        <div className="stack">
          <div className="eyebrow">Example routing (illustrative, not real)</div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.ceil(Math.sqrt(n))}, 1fr)`, gap: 5 }} aria-hidden>
            {Array.from({ length: n }, (_, i) => (
              <div
                key={i}
                style={{
                  aspectRatio: "1",
                  borderRadius: 6,
                  background: picked.includes(i) ? "var(--seg-active)" : "color-mix(in srgb, var(--seg-weights) 35%, transparent)",
                  boxShadow: picked.includes(i) ? "0 0 12px var(--seg-active)" : "none",
                  transition: "background 300ms, box-shadow 300ms",
                }}
              />
            ))}
          </div>
          <p className="field-hint">
            {n < E ? `Showing ${n} of ${E} experts. ` : ""}Highlighted squares are a random example of experts chosen for one token; real routing depends on the text.
          </p>
        </div>
      </div>
    </Modal>
  );
}

function pick(n: number, k: number): number[] {
  const s = new Set<number>();
  while (s.size < k) s.add(Math.floor(Math.random() * n));
  return [...s];
}
