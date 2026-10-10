import { useRef, useState } from "react";
import { Download, FileUp, Lock, RefreshCw, RotateCcw, Square } from "lucide-react";
import { useStore } from "../state/store";
import { useMachine } from "../state/derived";
import { computeGpus } from "../domain/hardware";
import { DEFAULT_RESERVES } from "../domain/estimator";
import type { Field, FormFactor, MemoryArchitecture, ModelVariant } from "../domain/types";
import { fmtBytes } from "../lib/units";
import { toCsv } from "../lib/csv";
import { importSeedCsv } from "../catalog/seedImporter";
import { verifyOllamaVariant } from "../catalog/ollamaOfficial";
import { modalityLabel } from "../domain/capabilities";
import { DEMO_MACHINES } from "../platform/demoHardware";
import { canReachOllamaCom, exportFile, isTauri } from "../platform/bridge";
import { Seg, Switch } from "../components/ui";
import { checkForUpdates, useUpdater } from "../components/Updater";
import { ThemeSwitch } from "../components/ThemeSwitch";
import { ReserveControls } from "./ModelDetail";

function FieldRow({ label, f, fmt }: { label: string; f: Field<unknown>; fmt?: (v: unknown) => string }) {
  return (
    <tr>
      <td>{label}</td>
      <td>
        <b>{f.value == null ? "Unknown" : fmt ? fmt(f.value) : String(f.value)}</b>
      </td>
      <td className="faint">{f.source}</td>
      <td>
        <span className={`badge ${f.confidence === "high" ? "verified" : f.confidence === "none" ? "" : "estimated"}`}>{f.confidence}</span>
      </td>
      <td className="faint" style={{ fontSize: 13.5 }}>
        {f.error ?? ""}
      </td>
    </tr>
  );
}

function NumOverride({ label, detected, value, onChange }: { label: string; detected: number | null; value: number | null; onChange: (v: number | null) => void }) {
  return (
    <label className="field">
      <span className="row" style={{ justifyContent: "space-between" }}>
        {label}
        <span className={`src-tag ${value != null ? "manual" : ""}`}>{value != null ? "Manually entered" : "Detected"}</span>
      </span>
      <input className="input" type="number" min="0" step="0.5" placeholder={detected != null ? `${(detected / 2 ** 30).toFixed(1)} (detected)` : "Unknown: enter GiB"} value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Math.max(0, +e.target.value))} />
    </label>
  );
}

export function Settings() {
  const s = useStore();
  const hw = s.hardware;
  const machine = useMachine();
  const fileRef = useRef<HTMLInputElement>(null);
  const [bulk, setBulk] = useState<{ done: number; total: number; ok: number } | null>(null);
  const cancelRef = useRef(false);
  if (!hw) return null;
  const o = s.overrides;
  const gpus = computeGpus(hw);
  const selected = o.selectedGpuIds ?? (machine?.gpus.map((g) => g.id) ?? []);

  const exportCatalog = async (kind: "json" | "csv") => {
    const models = [...s.catalog.values()];
    if (kind === "json") {
      const payload = { app: "model-fit-explorer", schema: 1, exportedAt: new Date().toISOString(), userModels: s.userModels, liveVerifications: s.liveVerifications, benchmarks: s.benchmarks };
      const p = await exportFile("model-fit-explorer-catalog.json", JSON.stringify(payload, null, 2), "application/json");
      s.showToast(`Saved ${p}`, "good");
    } else {
      const header = ["id", "display_name", "origin", "resolved_tag", "total_params_b", "total_params_provenance", "active_params_b", "active_params_provenance", "architecture", "architecture_provenance", "context_max", "default_quant", "default_weights_bytes", "default_download_bytes", "modalities", "modalities_verified", "last_verified", "source_urls"];
      const rows = models.map((m: ModelVariant) => {
        const a = m.artifacts.find((x) => x.isDefaultTag) ?? m.artifacts[0];
        const ml = modalityLabel(m.capabilities);
        return {
          id: m.id,
          display_name: m.displayName,
          origin: m.origin,
          resolved_tag: m.resolvedTag ?? "",
          total_params_b: m.totalParamsB.value ?? "",
          total_params_provenance: m.totalParamsB.provenance,
          active_params_b: m.activeParamsB.value ?? "",
          active_params_provenance: m.activeParamsB.provenance,
          architecture: m.architecture.value ?? "unknown",
          architecture_provenance: m.architecture.provenance,
          context_max: m.contextMax.value ?? "",
          default_quant: a?.quantLabel ?? "",
          default_weights_bytes: a?.weightBytes ?? "",
          default_download_bytes: a?.downloadBytes ?? "",
          modalities: ml.label,
          modalities_verified: ml.verified,
          last_verified: m.lastVerified ?? "",
          source_urls: m.sourceUrls.join(" "),
        };
      });
      const p = await exportFile("model-fit-explorer-catalog.csv", toCsv(header, rows), "text/csv");
      s.showToast(`Saved ${p}`, "good");
    }
  };

  const importFile = async (f: File) => {
    const text = await f.text();
    try {
      if (f.name.endsWith(".json")) {
        const j = JSON.parse(text);
        const list: ModelVariant[] = Array.isArray(j) ? j : j.userModels ?? [];
        const valid = list.filter((m) => m && typeof m.id === "string" && typeof m.displayName === "string" && m.totalParamsB && m.capabilities?.inputs);
        valid.forEach((m) => s.addUserModel({ ...m, origin: m.origin ?? "user" }));
        if (j.liveVerifications) for (const v of Object.values(j.liveVerifications)) s.saveVerification(v as never);
        s.showToast(`Imported ${valid.length} model(s)${list.length - valid.length ? `, skipped ${list.length - valid.length} invalid` : ""}`, valid.length ? "good" : "warn");
      } else {
        const r = importSeedCsv(text, f.name);
        r.models.forEach((m) => s.addUserModel({ ...m, origin: "user", id: m.id, notes: [...m.notes, `Imported from ${f.name}`] }));
        s.showToast(`CSV: ${r.report.imported} imported, ${r.report.duplicates} duplicates, ${r.report.issues.filter((i) => i.level === "error").length} errors`, r.report.imported ? "good" : "warn");
      }
    } catch (e) {
      s.showToast(`Import failed: ${(e as Error).message}`, "bad");
    }
  };

  const bulkVerify = async () => {
    const list = [...s.catalog.values()].filter((m) => m.origin === "seed_csv" || m.origin === "ollama_library");
    cancelRef.current = false;
    setBulk({ done: 0, total: list.length, ok: 0 });
    let ok = 0;
    for (let i = 0; i < list.length; i++) {
      if (cancelRef.current) break;
      try {
        const v = await verifyOllamaVariant(list[i].family, list[i].variant, { maxTags: 4 });
        if (v.artifacts.length) ok++;
        useStore.setState({ liveVerifications: { ...useStore.getState().liveVerifications, [`${v.family}:${v.variant}`.toLowerCase()]: v } });
      } catch {
        /* keep cached data */
      }
      setBulk({ done: i + 1, total: list.length, ok });
    }
    await s.rebuildCatalog();
    setBulk(null);
    s.showToast(`Catalog updated: ${ok} variants verified`, "good");
  };

  const rep = s.importReport;
  return (
    <div className="grid" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow">Settings & diagnostics</div>
          <h1>Hardware, data and privacy</h1>
          <p>See exactly what was detected and from where, correct anything that's wrong, and manage the model catalog.</p>
        </div>
        <button className="btn primary" onClick={() => void s.rescanHardware()} disabled={s.hardwareStatus === "probing"}>
          <RefreshCw size={15} className={s.hardwareStatus === "probing" ? "spin" : ""} /> Rescan hardware
        </button>
      </div>

      {!isTauri() && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Which computer?</h2>
              <p>
                In the browser we estimate your machine from what the browser exposes (GPU name, CPU threads) plus known GPU specs and your answers. The{" "}
                <a href="https://github.com/maninka123/local-llm-fit/releases" target="_blank" rel="noreferrer noopener">
                  desktop app
                </a>{" "}
                reads exact and live values.
              </p>
            </div>
          </div>
          <div className="row">
            <button className={`btn ${s.webHardware === "browser" ? "primary" : ""}`} onClick={() => (s.webHardware === "browser" ? s.setSetupOpen(true) : s.useBrowserHardware())}>
              {s.webHardware === "browser" ? "Edit my machine" : "Use my computer"}
            </button>
            <span className="faint" style={{ fontSize: 14.5 }}>or try a sample machine:</span>
            <Seg label="Sample machine" value={s.webHardware === "demo" ? s.demoId : ""} onChange={s.setDemo} options={DEMO_MACHINES.map((d) => ({ value: d.id, label: d.name }))} />
          </div>
        </section>
      )}

      <section className="card" style={{ overflowX: "auto" }}>
        <div className="card-head">
          <div>
            <h2>Detected hardware</h2>
            <p>
              Probe {hw.probeVersion} · {new Date(hw.detectedAt).toLocaleString()} {hw.demo && <span className="badge demo">Demo hardware</span>}
            </p>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Value</th>
              <th>Source</th>
              <th>Confidence</th>
              <th>Why unknown</th>
            </tr>
          </thead>
          <tbody>
            <FieldRow label="Form factor" f={hw.formFactor} />
            <FieldRow label="Battery" f={hw.hasBattery} fmt={(v) => (v ? "Present" : "None")} />
            <FieldRow label="Virtual machine" f={hw.isVirtualMachine} fmt={(v) => (v ? "Yes" : "No")} />
            <FieldRow label="Memory architecture" f={hw.memoryArchitecture} />
            <FieldRow label="RAM total" f={hw.memory.totalBytes} fmt={(v) => fmtBytes(v as number)} />
            <FieldRow label="RAM available (live)" f={hw.memory.availableBytes} fmt={(v) => fmtBytes(v as number)} />
            <FieldRow label="GPU working-set limit" f={hw.unifiedGpuWorkingSetBytes} fmt={(v) => fmtBytes(v as number)} />
            {hw.gpus.map((g) => (
              <FieldRow key={g.id + "d"} label={`${g.name} · dedicated`} f={g.dedicatedBytes} fmt={(v) => fmtBytes(v as number)} />
            ))}
            {hw.gpus.map((g) => (
              <FieldRow key={g.id + "f"} label={`${g.name} · free`} f={g.freeBytes} fmt={(v) => fmtBytes(v as number)} />
            ))}
            {hw.gpus
              .filter((g) => g.sharedBytes.value != null)
              .map((g) => (
                <FieldRow key={g.id + "s"} label={`${g.name} · shared (NOT VRAM)`} f={g.sharedBytes} fmt={(v) => fmtBytes(v as number)} />
              ))}
          </tbody>
        </table>
        <p className="field-hint">
          CPU: {hw.cpu.brand} · {hw.cpu.physicalCores ?? "?"} physical / {hw.cpu.logicalCores ?? "?"} logical cores · OS: {hw.os.name} {hw.os.version} ({hw.os.arch}){hw.os.kernel ? ` · kernel ${hw.os.kernel}` : ""}
        </p>
        {hw.errors.map((e, i) => (
          <div key={i} className="warning warn" style={{ marginTop: 6 }}>
            {e}
          </div>
        ))}
        {hw.notes.map((n, i) => (
          <p key={i} className="field-hint">
            {n}
          </p>
        ))}
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Manual overrides</h2>
            <p>Leave blank to use detected values. Overrides are labelled "Manually entered" everywhere.</p>
          </div>
          <button className="btn" onClick={s.resetOverrides}>
            <RotateCcw size={15} /> Reset overrides
          </button>
        </div>
        <div className="grid cols-3">
          <label className="field">
            <span className="row" style={{ justifyContent: "space-between" }}>
              Hardware class <span className={`src-tag ${o.formFactor ? "manual" : ""}`}>{o.formFactor ? "Manually entered" : "Detected"}</span>
            </span>
            <select className="select" value={o.formFactor ?? ""} onChange={(e) => s.setOverrides({ formFactor: (e.target.value || null) as FormFactor | null })}>
              <option value="">Detected ({hw.formFactor.value ?? "unknown"})</option>
              <option value="laptop">Laptop</option>
              <option value="desktop">Desktop</option>
              <option value="workstation">Workstation</option>
              <option value="server">Server</option>
              <option value="virtual_machine">Virtual machine</option>
            </select>
            <span className="field-hint">Form factor never changes the memory math; power limits affect speed, not capacity.</span>
          </label>
          <label className="field">
            <span className="row" style={{ justifyContent: "space-between" }}>
              Memory architecture <span className={`src-tag ${o.memoryArchitecture ? "manual" : ""}`}>{o.memoryArchitecture ? "Manually entered" : "Detected"}</span>
            </span>
            <select className="select" value={o.memoryArchitecture ?? ""} onChange={(e) => s.setOverrides({ memoryArchitecture: (e.target.value || null) as MemoryArchitecture | null })}>
              <option value="">Detected ({hw.memoryArchitecture.value ?? "unknown"})</option>
              <option value="discrete">Discrete GPU (dedicated VRAM)</option>
              <option value="unified">Unified memory (Apple Silicon)</option>
              <option value="integrated_shared">Integrated GPU (shares RAM)</option>
              <option value="cpu_only">CPU only</option>
            </select>
          </label>
          <NumOverride label="RAM total (GiB)" detected={hw.memory.totalBytes.value} value={o.ramTotalGiB} onChange={(v) => s.setOverrides({ ramTotalGiB: v })} />
          <NumOverride label="RAM available now (GiB)" detected={hw.memory.availableBytes.value} value={o.ramFreeGiB} onChange={(v) => s.setOverrides({ ramFreeGiB: v })} />
          {(machine?.arch ?? "discrete") === "discrete" && (
            <>
              <NumOverride label="VRAM total (GiB)" detected={gpus[0]?.dedicatedBytes.value ?? null} value={o.vramTotalGiB} onChange={(v) => s.setOverrides({ vramTotalGiB: v })} />
              <NumOverride label="VRAM free now (GiB)" detected={gpus[0]?.freeBytes.value ?? null} value={o.vramFreeGiB} onChange={(v) => s.setOverrides({ vramFreeGiB: v })} />
            </>
          )}
          {machine?.arch === "unified" && (
            <NumOverride label="GPU working-set limit (GiB)" detected={hw.unifiedGpuWorkingSetBytes.value} value={o.unifiedGpuLimitGiB} onChange={(v) => s.setOverrides({ unifiedGpuLimitGiB: v })} />
          )}
        </div>
        {gpus.length > 1 && (
          <>
            <div className="divider" />
            <b>GPUs used for estimates</b>
            <div className="row" style={{ marginTop: 8 }}>
              {gpus.map((g) => (
                <label key={g.id} className="switch">
                  <input
                    type="checkbox"
                    checked={selected.includes(g.id)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...selected, g.id] : selected.filter((x) => x !== g.id);
                      s.setOverrides({ selectedGpuIds: next.length ? next : null });
                    }}
                  />
                  {g.name} · {fmtBytes(g.dedicatedBytes.value)}
                </label>
              ))}
            </div>
            <div style={{ marginTop: 10 }}>
              <Switch checked={o.combineGpus} onChange={(v) => s.setOverrides({ combineGpus: v })} label="Combine selected GPUs (only if your runtime is verified to split a model across them)" />
              <p className="field-hint">Off by default: VRAM on different cards is never simply added. Splitting adds overhead and needs runtime support.</p>
            </div>
          </>
        )}
      </section>

      <div className="grid cols-2">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Memory reserves</h2>
              <p>Live mode subtracts these from measured free memory. Planning mode (no live reading) uses percentages.</p>
            </div>
            <button className="btn sm" onClick={() => s.setSettings({ reserves: DEFAULT_RESERVES })}>
              Defaults
            </button>
          </div>
          <div className="stack">
            <ReserveControls settings={s.settings} setSettings={s.setSettings} mode="live" />
            <ReserveControls settings={s.settings} setSettings={s.setSettings} mode="planning" />
          </div>
        </section>
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Appearance & accessibility</h2>
            </div>
          </div>
          <div className="stack">
            <div className="control-label" style={{ margin: 0 }}>
              Theme
            </div>
            <ThemeSwitch showLabel />
            <div className="control-label" style={{ margin: 0 }}>
              Motion
            </div>
            <Seg
              label="Motion"
              value={s.motion}
              onChange={s.setMotion}
              options={[
                { value: "system", label: "Follow system" },
                { value: "reduce", label: "Reduced" },
                { value: "full", label: "Full" },
              ]}
            />
            <p className="field-hint">Everything is keyboard accessible: Tab to move, Enter/Space to activate, Esc to close dialogs.</p>
          </div>
        </section>
      </div>

      {isTauri() && <UpdatesCard />}

      <section className="card" style={{ overflowX: "auto" }}>
        <div className="card-head">
          <div>
            <h2>Local Ollama</h2>
            <p>
              {s.ollamaState.status === "online"
                ? `Connected · version ${s.ollamaState.version}`
                : `Not connected${s.ollamaState.error ? ` (${s.ollamaState.error.slice(0, 120)})` : ""}. Estimates work without Ollama.`}
            </p>
          </div>
          <button className="btn" onClick={() => void s.refreshOllama()}>
            <RefreshCw size={15} className={s.ollamaState.status === "checking" ? "spin" : ""} /> Check again
          </button>
        </div>
        {!isTauri() && s.ollamaState.status !== "online" && (
          <div className="warning" style={{ marginBottom: 12 }}>
            <span>
              To let this website talk to Ollama on your computer, allow its address once and restart Ollama:
              <br />
              macOS: <span className="mono">launchctl setenv OLLAMA_ORIGINS "{location.origin}"</span>
              <br />
              Windows: <span className="mono">setx OLLAMA_ORIGINS "{location.origin}"</span>
              <br />
              Linux: add <span className="mono">Environment="OLLAMA_ORIGINS={location.origin}"</span> to the Ollama service. Your browser may also ask permission to access local network devices.
            </span>
          </div>
        )}
        {s.ollamaState.installed.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Installed model</th>
                <th>Params</th>
                <th>Quantization</th>
                <th className="num">Size</th>
                <th>Loaded now</th>
              </tr>
            </thead>
            <tbody>
              {s.ollamaState.installed.map((t) => {
                const ps = s.ollamaState.running.find((r) => r.name === t.name);
                return (
                  <tr key={t.name}>
                    <td>
                      <a href={`#/model/${encodeURIComponent(t.name.toLowerCase().replace(/:latest$/, ""))}`} className="mono">
                        {t.name}
                      </a>
                    </td>
                    <td>{t.details?.parameter_size ?? "?"}</td>
                    <td>{t.details?.quantization_level ?? "?"}</td>
                    <td className="num">{fmtBytes(t.size, "GB")}</td>
                    <td>{ps ? `${fmtBytes(ps.size_vram)} of ${fmtBytes(ps.size)} in VRAM` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <div className="card-head" style={{ flexWrap: "wrap" }}>
          <div>
            <h2>Model catalog</h2>
            <p>
              {s.catalog.size} variants · bundled official snapshot {s.snapshotDate ? new Date(s.snapshotDate).toLocaleDateString() : "not available"} ({s.snapshotStats.applied} seed rows verified, {s.snapshotStats.added} added from the
              live library) · {Object.keys(s.liveVerifications).length} verified on this device.
            </p>
          </div>
          <div className="row">
            {bulk ? (
              <button className="btn" onClick={() => (cancelRef.current = true)}>
                <Square size={14} /> Stop ({bulk.done}/{bulk.total})
              </button>
            ) : (
              <button className="btn primary" disabled={!canReachOllamaCom()} onClick={() => void bulkVerify()} title="Re-fetch metadata (not weights) for every Ollama model from ollama.com">
                <RefreshCw size={15} /> Update catalog
              </button>
            )}
            <button className="btn" onClick={() => void exportCatalog("json")}>
              <Download size={15} /> Export JSON
            </button>
            <button className="btn" onClick={() => void exportCatalog("csv")}>
              <Download size={15} /> Export CSV
            </button>
            <button className="btn" onClick={() => fileRef.current?.click()}>
              <FileUp size={15} /> Import CSV/JSON
            </button>
            <input ref={fileRef} type="file" accept=".csv,.json" hidden onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
          </div>
        </div>
        {bulk && (
          <div className="progress" style={{ marginBottom: 12 }}>
            <div style={{ width: `${(bulk.done / bulk.total) * 100}%` }} />
          </div>
        )}
        <p className="field-hint">Updating fetches metadata only (pages, manifests, ~256 KiB GGUF headers). It never downloads model weights.</p>
        {rep && (
          <details className="drawer" style={{ marginTop: 10 }}>
            <summary>
              Seed import report: {rep.totalRows} rows → {rep.imported} variants from {rep.families} families · {rep.duplicates} duplicates · {rep.conflicts} conflicts · {rep.issues.length} issue(s)
            </summary>
            <div>
              {rep.issues.length === 0 ? (
                <p className="faint">No issues.</p>
              ) : (
                <table className="table">
                  <tbody>
                    {rep.issues.map((i, k) => (
                      <tr key={k}>
                        <td>
                          <span className={`badge ${i.level === "error" ? "" : "estimated"}`}>{i.level}</span>
                        </td>
                        <td className="num">row {i.row}</td>
                        <td className="mono">{i.id}</td>
                        <td>{i.field}</td>
                        <td>{i.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="field-hint">Seed values are never silently promoted to "verified": heuristic sizes stay heuristic until an official source replaces them.</p>
            </div>
          </details>
        )}
      </section>

      {s.userModels.length > 0 && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Your added models</h2>
              <p>Saved on this computer only.</p>
            </div>
            <button className="btn sm" onClick={() => s.setTryOpen(true)}>
              Try another model
            </button>
          </div>
          <table className="table">
            <tbody>
              {s.userModels.map((u) => (
                <tr key={u.id}>
                  <td>
                    <a href={`#/model/${encodeURIComponent(u.id)}`}>{u.displayName}</a>
                  </td>
                  <td className="faint">{u.origin.replace("_", " ")}</td>
                  <td className="faint">{u.lastVerified ? `verified ${u.lastVerified.slice(0, 10)}` : "unverified"}</td>
                  <td style={{ textAlign: "right" }}>
                    <button className="btn ghost sm danger" onClick={() => s.removeUserModel(u.id)} aria-label={`Remove ${u.displayName}`}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <div>
            <h2>
              <Lock size={16} style={{ verticalAlign: -2 }} /> Privacy
            </h2>
          </div>
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-2)", display: "grid", gap: 6, fontSize: 15.5 }}>
          <li>No telemetry, no accounts, no cloud services required.</li>
          <li>Your hardware details stay on this computer. They are never sent anywhere.</li>
          <li>Online lookups send only the model name you typed, to ollama.com, registry.ollama.ai and huggingface.co.</li>
          <li>Ollama is contacted only on this computer (127.0.0.1). Tests and downloads run only after you confirm.</li>
          <li>Text from model cards is shown as plain data and never executed.</li>
        </ul>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn danger sm" onClick={() => {
            if (confirm("Delete saved benchmarks, user models and verifications from this device?")) {
              useStore.setState({ benchmarks: [], userModels: [], liveVerifications: {}, capabilityEvidence: {} });
              void s.rebuildCatalog();
            }
          }}>
            Delete all local data
          </button>
        </div>
      </section>
    </div>
  );
}

function UpdatesCard() {
  const auto = useStore((s) => s.autoUpdate);
  const setAuto = useStore((s) => s.setAutoUpdate);
  const u = useUpdater();
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Updates</h2>
          <p>New versions are downloaded from GitHub Releases and verified with a signature before installing.{u.current ? ` You have version ${u.current}.` : ""}</p>
        </div>
        <button className="btn primary" onClick={() => void checkForUpdates(true)} disabled={u.phase === "checking"}>
          <RefreshCw size={15} className={u.phase === "checking" ? "spin" : ""} /> Check for updates
        </button>
      </div>
      <Switch checked={auto} onChange={setAuto} label="Check automatically when the app starts" />
    </section>
  );
}
