import { useState } from "react";
import { AlertTriangle, Download, Gauge, Play, Trash2 } from "lucide-react";
import { useStore } from "../state/store";
import { useMachine } from "../state/derived";
import { CLASS_META, type Estimate } from "../domain/estimator";
import type { BenchmarkRecord, ModelVariant } from "../domain/types";
import { fmtBytes } from "../lib/units";
import { ollama, sampleMemory, isTauri } from "../platform/bridge";
import { runBenchmark } from "../platform/ollamaLocal";
import { Modal } from "./ui";

const PLACEMENT: Record<string, string> = { gpu_100: "100% GPU", mixed: "Mixed CPU/GPU", cpu_100: "100% CPU", unknown: "Unknown" };

export function BenchmarkPanel({ m, est }: { m: ModelVariant; est: Estimate }) {
  const ol = useStore((s) => s.ollamaState);
  const hw = useStore((s) => s.hardware);
  const settings = useStore((s) => s.settings);
  const benches = useStore((s) => s.benchmarks);
  const addBenchmark = useStore((s) => s.addBenchmark);
  const refresh = useStore((s) => s.refreshOllama);
  const toast = useStore((s) => s.showToast);
  const machine = useMachine();
  const [consent, setConsent] = useState(false);
  const [pullOpen, setPullOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [pull, setPull] = useState<{ status: string; done: number; total: number } | null>(null);

  const name = m.installed?.name;
  const mine = benches.filter((b) => b.model === name || b.model === m.resolvedTag);
  const canPull = ol.status === "online" && !m.installed && !!(est.artifact?.tag ?? m.resolvedTag) && !m.cloudOnly;
  // The file the estimate describes is the one offered for download.
  const art = est.artifact ?? m.artifacts.find((a) => a.isDefaultTag);
  const pullTag = art?.tag ?? m.resolvedTag;
  const sample = hw?.mode === "demo";
  // The test measures the installed file; flag when the estimate above is for another quantization.
  const otherQuant = !!m.installed?.quantLabel && !!est.artifact && est.artifact.quantLabel !== m.installed.quantLabel ? est.artifact.quantLabel : null;

  const run = async () => {
    if (!name) return;
    setConsent(false);
    const meta = {
      digest: m.installed?.digest,
      quantLabel: m.installed?.quantLabel,
      parameterSize: m.installed?.parameterSize,
      ollamaVersion: ol.version,
      gpuName: machine?.gpus[0]?.name ?? (machine?.arch === "unified" ? hw?.gpus[0]?.name : undefined),
      driverVersion: hw?.gpus[0]?.driverVersion,
      osName: hw ? `${hw.os.name} ${hw.os.version}` : undefined,
      backend: hw?.gpus[0]?.backendHints.join("/"),
      powerSource: hw?.hasBattery.value ? "battery-capable device (power mode not read)" : undefined,
      // Only comparable when the estimate is for the installed file.
      predictedClass: otherQuant ? undefined : est.classification,
      predictedTotalBytes: otherQuant ? undefined : est.totalNeed?.mid,
    };
    try {
      for (const kind of ["cold", "warm"] as const) {
        setStatus(`${kind === "cold" ? "Cold" : "Warm"} run…`);
        const r = await runBenchmark(ollama(), { model: name, contextTokens: settings.contextTokens, kind, meta, sampleMemory: isTauri() ? sampleMemory : undefined, onStatus: setStatus });
        addBenchmark(r);
      }
      toast("Benchmark complete", "good");
      void refresh();
    } catch (e) {
      toast(`Benchmark failed: ${(e as Error).message}`, "bad");
    } finally {
      setStatus(null);
    }
  };

  const doPull = async () => {
    if (!pullTag) return;
    setPullOpen(false);
    setPull({ status: "starting", done: 0, total: 0 });
    try {
      await ollama().pull(pullTag, (l) => {
        if (l.error) throw new Error(String(l.error));
        setPull({ status: String(l.status ?? ""), done: Number(l.completed ?? 0), total: Number(l.total ?? 0) });
      });
      toast(`Downloaded ${pullTag}`, "good");
      await refresh();
    } catch (e) {
      toast(`Download failed: ${(e as Error).message}`, "bad");
    } finally {
      setPull(null);
    }
  };

  return (
    <section className="card" aria-labelledby="bench-title">
      <div className="card-head" style={{ flexWrap: "wrap" }}>
        <div>
          <h2 id="bench-title">Measure it on this computer</h2>
          <p>Optional. Runs only when you click, through your local Ollama. Measured numbers replace estimates for this machine only.</p>
        </div>
        <div className="row">
          {canPull && (
            <button className="btn" onClick={() => setPullOpen(true)} disabled={!!pull}>
              <Download size={15} /> Download…
            </button>
          )}
          <button className="btn primary" disabled={!name || ol.status !== "online" || !!status || sample} onClick={() => setConsent(true)} title={sample ? "Switch to your own computer to measure" : !name ? "Install this model in Ollama first" : undefined}>
            <Play size={15} /> {status ?? "Run Test"}
          </button>
        </div>
      </div>
      {sample && (
        <p className="faint" style={{ fontSize: 14.5, margin: 0 }}>
          You're viewing a sample machine. Tests run on your own computer, so switch to it to measure.
        </p>
      )}
      {otherQuant && name && !sample && (
        <p className="faint" style={{ fontSize: 14.5, margin: 0 }}>
          The estimate above is for {otherQuant}; the test measures the installed {m.installed?.quantLabel} file.
        </p>
      )}
      {ol.status !== "online" && (
        <p className="faint" style={{ fontSize: 14.5, margin: 0 }}>
          Ollama is not running. Start Ollama to see installed models and run tests. Estimates above don't need it.
        </p>
      )}
      {ol.status === "online" && !name && (
        <p className="faint" style={{ fontSize: 14.5, margin: 0 }}>
          {m.resolvedTag ? (
            <>
              Not installed. Use Download (with confirmation) or run <span className="mono">ollama pull {m.resolvedTag}</span> yourself.
            </>
          ) : (
            "Verify this model first to resolve an exact Ollama tag."
          )}
        </p>
      )}
      {pull && (
        <div className="stack" style={{ marginTop: 10, gap: 6 }}>
          <span className="faint" style={{ fontSize: 14.5 }}>
            {pull.status} {pull.total ? `${fmtBytes(pull.done, "GB")} / ${fmtBytes(pull.total, "GB")}` : ""}
          </span>
          <div className="progress">
            <div style={{ width: `${pull.total ? (pull.done / pull.total) * 100 : 5}%` }} />
          </div>
        </div>
      )}
      {mine.length > 0 && <ResultsTable rows={mine.slice(0, 6)} est={est} />}
      {consent && (
        <Modal title="Run a local benchmark?" onClose={() => setConsent(false)}>
          <div className="stack">
            <p className="muted" style={{ margin: 0 }}>
              We'll ask <span className="mono">{name}</span> to write about 160 tokens twice: a <b>cold</b> run (model unloaded first, so loading time is included) and a <b>warm</b> run. Settings: temperature 0, seed 42,{" "}
              {settings.contextTokens.toLocaleString()} context.
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-2)", fontSize: 15 }}>
              <li>Uses up to ≈ {fmtBytes(est.totalNeed?.mid ?? null)} of memory while it runs; close heavy apps for cleaner numbers.</li>
              <li>Nothing is downloaded. Nothing leaves your computer.</li>
              <li>Results are specific to this machine, driver, power mode and Ollama version.</li>
            </ul>
            {(est.classification === "memory_constrained" || est.classification === "cannot_fit") && (
              <div className="warning danger">
                <AlertTriangle size={16} />
                <span>The estimate says this may not fit. Running it could make your computer swap heavily or fail to load.</span>
              </div>
            )}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setConsent(false)}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => void run()}>
                <Play size={15} /> Run Test
              </button>
            </div>
          </div>
        </Modal>
      )}
      {pullOpen && (
        <Modal title={`Download ${pullTag}?`} onClose={() => setPullOpen(false)}>
          <div className="stack">
            <p className="muted" style={{ margin: 0 }}>
              Ollama will download this model to its local model store.
            </p>
            <div className="facts">
              <div className="fact">
                <div className="label">Download size</div>
                <div className="value">{art?.downloadBytes ? fmtBytes(art.downloadBytes, "GB", 2) : "Unknown"}</div>
              </div>
              <div className="fact">
                <div className="label">Disk needed</div>
                <div className="value">≈ {art?.downloadBytes ? fmtBytes(art.downloadBytes, "GB") : "?"}</div>
              </div>
              <div className="fact">
                <div className="label">Predicted fit</div>
                <div className="value" style={{ fontSize: 14.5 }}>{CLASS_META[est.classification].title}</div>
              </div>
            </div>
            {(est.classification === "cannot_fit" || est.classification === "memory_constrained") && (
              <div className="warning danger">
                <AlertTriangle size={16} />
                <span>This model is predicted not to fit comfortably. You may be downloading something that won't run well.</span>
              </div>
            )}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setPullOpen(false)}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => void doPull()}>
                <Download size={15} /> Download {art?.downloadBytes ? fmtBytes(art.downloadBytes, "GB") : ""}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function ResultsTable({ rows, est }: { rows: BenchmarkRecord[]; est?: Estimate }) {
  const clear = useStore((s) => s.clearBenchmarks);
  const s = (ns?: number) => (ns != null ? `${(ns / 1e9).toFixed(2)} s` : "—");
  const delta = (peak?: number, base?: number) => (peak != null && base != null ? fmtBytes(Math.max(0, peak - base)) : "—");
  return (
    <div style={{ overflowX: "auto", marginTop: 12 }}>
      <table className="table">
        <thead>
          <tr>
            <th>Run</th>
            <th className="num">Generation</th>
            <th className="num">Prompt</th>
            <th className="num">TTFT*</th>
            <th className="num">Load</th>
            <th className="num">Wall</th>
            <th className="num">RAM Δ peak</th>
            <th className="num">VRAM Δ peak</th>
            <th>Ollama placement</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.id}>
              <td>
                <b>{b.kind}</b>
                <div className="faint" style={{ fontSize: 13 }}>
                  {new Date(b.createdAt).toLocaleString()} · {b.quantLabel ?? ""} · {b.contextTokens / 1024}K
                </div>
              </td>
              <td className="num">
                <b style={{ color: "var(--good)" }}>{b.generationTokPerSec ? `${b.generationTokPerSec.toFixed(1)} tok/s` : "—"}</b>
              </td>
              <td className="num">{b.promptTokPerSec ? `${b.promptTokPerSec.toFixed(0)} tok/s` : "—"}</td>
              <td className="num">{b.ttftMs != null ? `${(b.ttftMs / 1000).toFixed(2)} s` : "—"}</td>
              <td className="num">{s(b.loadDurationNs)}</td>
              <td className="num">{(b.wallMs / 1000).toFixed(2)} s</td>
              <td className="num">{delta(b.peakRamUsedBytes, b.baselineRamUsedBytes)}</td>
              <td className="num">{delta(b.peakVramUsedBytes, b.baselineVramUsedBytes)}</td>
              <td>
                {PLACEMENT[b.placement ?? "unknown"]}
                {b.residentBytes ? <div className="faint" style={{ fontSize: 13 }}>{fmtBytes(b.residentVramBytes ?? 0)} of {fmtBytes(b.residentBytes)} in VRAM</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {est && rows[0] && (
        <div className="row" style={{ marginTop: 10, fontSize: 14.5 }}>
          <Gauge size={15} />
          <span className="muted">
            Predicted: <b>{CLASS_META[est.classification].title}</b>, ≈ {fmtBytes(est.totalNeed?.mid ?? null)} total. Ollama reported: <b>{PLACEMENT[rows[0].placement ?? "unknown"]}</b>
            {rows[0].residentBytes ? `, ${fmtBytes(rows[0].residentBytes)} resident` : ""}.
          </span>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={clear} title="Delete all stored benchmark results">
            <Trash2 size={13} /> Clear results
          </button>
        </div>
      )}
      <p className="field-hint">
        Generation = eval_count ÷ eval_duration (Ollama reports nanoseconds); this is generation throughput, not total request throughput. *TTFT = time from request to the first
        streamed token, including model load on cold runs. Memory Δ is a whole-system sample (desktop app only), not a per-process measurement.
      </p>
    </div>
  );
}
