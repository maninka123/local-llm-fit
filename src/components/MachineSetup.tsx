import { useMemo, useState } from "react";
import { CheckCircle2, Cpu, Download, HelpCircle, Laptop, MemoryStick, Monitor, Sparkles } from "lucide-react";
import { useStore } from "../state/store";
import { suggestSetup, type BrowserSetup } from "../platform/browserDetect";
import { COMMON_RAM_GB, KNOWN_GPU_NAMES, lookupGpu } from "../platform/gpuSpecs";
import { Modal, Seg } from "./ui";

const RELEASES = "https://github.com/maninka123/local-llm-fit/releases";

/** Form to confirm what the browser detected and fill in what it can't see. */
function SetupForm({ onDone }: { onDone?: () => void }) {
  const sig = useStore((s) => s.browserSignals);
  const saved = useStore((s) => s.browserSetup);
  const save = useStore((s) => s.saveBrowserSetup);
  const setDemo = useStore((s) => s.setDemo);
  const initial = useMemo<BrowserSetup>(() => saved ?? (sig ? suggestSetup(sig) : { confirmed: false, gpuName: null, vramGiB: null, ramGiB: null, formFactor: null }), [saved, sig]);
  const [gpuName, setGpuName] = useState(initial.gpuName ?? "");
  const [noGpu, setNoGpu] = useState(!initial.gpuName);
  const [vram, setVram] = useState<number | null>(initial.vramGiB);
  const [ram, setRam] = useState<number | null>(initial.ramGiB);
  const [ff, setFf] = useState(initial.formFactor ?? "desktop");

  const spec = noGpu ? null : lookupGpu(gpuName);
  const unified = spec?.kind === "unified";
  const integrated = spec?.kind === "integrated";
  const vramOptions = spec?.vramGiB ?? [];
  const ramOptions = unified && spec?.unifiedOptionsGB?.length ? spec.unifiedOptionsGB : COMMON_RAM_GB;
  const needsVram = !noGpu && !unified && !integrated;
  const ready = ram != null && (!needsVram || vram != null);

  const pickGpu = (name: string) => {
    setGpuName(name);
    const sp = lookupGpu(name);
    if (sp?.kind === "discrete" && sp.vramGiB?.length) setVram(sp.vramGiB[0]);
    if (sp?.kind === "unified" && sp.unifiedOptionsGB?.length && (ram == null || !sp.unifiedOptionsGB.includes(ram))) setRam(sp.unifiedOptionsGB[0]);
  };

  const submit = () => {
    save({ confirmed: true, gpuName: noGpu ? null : gpuName.trim() || null, vramGiB: needsVram ? vram : null, ramGiB: ram, formFactor: ff as BrowserSetup["formFactor"] });
    onDone?.();
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="setup-detected">
        <div className="eyebrow">Detected by your browser</div>
        <div className="row" style={{ gap: 18, marginTop: 6 }}>
          <span className="row" style={{ gap: 6 }}>
            <Sparkles size={15} /> <b>{sig?.gpuName ?? "GPU name hidden by the browser"}</b>
          </span>
          {sig?.cores && (
            <span className="row" style={{ gap: 6 }}>
              <Cpu size={15} /> {sig.cores} CPU threads
            </span>
          )}
          <span className="row" style={{ gap: 6 }}>
            <Monitor size={15} /> {sig?.os.name} {sig?.os.version}
          </span>
          {sig?.deviceMemoryGB != null && (
            <span className="row" style={{ gap: 6 }}>
              <MemoryStick size={15} /> {sig.deviceMemoryGB >= 8 ? "8 GB or more RAM" : `about ${sig.deviceMemoryGB} GB RAM`}
            </span>
          )}
        </div>
        <p className="field-hint" style={{ margin: "8px 0 0" }}>
          Browsers hide exact memory sizes, so please check the values below. Nothing you enter leaves this computer.
        </p>
      </div>

      <div className="grid cols-2" style={{ gap: 18 }}>
        <div className="field">
          <label htmlFor="setup-gpu">Graphics (GPU)</label>
          <input id="setup-gpu" className="input" list="known-gpus" value={noGpu ? "" : gpuName} disabled={noGpu} placeholder="e.g. GeForce RTX 4070" onChange={(e) => pickGpu(e.target.value)} />
          <datalist id="known-gpus">
            {KNOWN_GPU_NAMES.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <label className="switch" style={{ marginTop: 4 }}>
            <input type="checkbox" checked={noGpu} onChange={(e) => setNoGpu(e.target.checked)} />
            No separate graphics card / not sure
          </label>
          <span className="field-hint">
            {noGpu
              ? "Models will be estimated for the CPU and system RAM."
              : unified
                ? "Apple Silicon: the GPU shares one unified memory pool with the CPU."
                : integrated
                  ? "Integrated graphics shares system RAM; models are estimated on the CPU."
                  : spec?.vramGiB
                    ? `Known spec: ${spec.vramGiB.join(" or ")} GB of graphics memory.`
                    : gpuName
                      ? "Not in our table: please enter its memory below."
                      : ""}
          </span>
        </div>

        <div className="field">
          <span>{unified ? "Unified memory" : "System memory (RAM)"}</span>
          <Seg label="Memory size" value={ram ?? -1} onChange={(v) => setRam(v)} options={ramOptions.map((g) => ({ value: g, label: `${g} GB` }))} />
          <span className="field-hint">
            <HelpCircle size={12} style={{ verticalAlign: -2 }} /> {sig?.os.name === "macOS" ? "Apple menu → About This Mac → Memory" : sig?.os.name === "Windows" ? "Settings → System → About → Installed RAM" : "Run `free -h` in a terminal"}
          </span>
        </div>

        {needsVram && (
          <div className="field">
            <span>Graphics memory (VRAM)</span>
            {vramOptions.length > 0 ? (
              <Seg label="Graphics memory" value={vram ?? -1} onChange={(v) => setVram(v)} options={vramOptions.map((g) => ({ value: g, label: `${g} GB` }))} />
            ) : (
              <input className="input" type="number" min={1} max={256} placeholder="GB, e.g. 8" value={vram ?? ""} onChange={(e) => setVram(e.target.value ? Math.max(1, +e.target.value) : null)} />
            )}
            <span className="field-hint">
              <HelpCircle size={12} style={{ verticalAlign: -2 }} /> {sig?.os.name === "Windows" ? "Task Manager → Performance → GPU → Dedicated GPU memory" : "Run `nvidia-smi`, or check your GPU's specs"}
            </span>
          </div>
        )}

        <div className="field">
          <span>Device type</span>
          <Seg
            label="Device type"
            value={ff}
            onChange={(v) => setFf(v)}
            options={[
              { value: "laptop", label: <><Laptop size={14} style={{ verticalAlign: -2 }} /> Laptop</> },
              { value: "desktop", label: <><Monitor size={14} style={{ verticalAlign: -2 }} /> Desktop</> },
            ]}
          />
          <span className="field-hint">Only shown for context: device type never changes the memory math.</span>
        </div>
      </div>

      <div className="row">
        <button className="btn primary" disabled={!ready} onClick={submit}>
          <CheckCircle2 size={16} /> Use these values
        </button>
        <button className="btn ghost" onClick={() => setDemo(useStore.getState().demoId)}>
          Try a sample machine instead
        </button>
        <span className="spacer" />
        <a className="btn ghost sm" href={RELEASES} target="_blank" rel="noreferrer noopener">
          <Download size={14} /> Exact readings: desktop app
        </a>
      </div>
    </div>
  );
}

/** Inline card shown on the Overview until the user confirms their machine. */
export function MachineSetupCard() {
  return (
    <section className="card setup-card" aria-labelledby="setup-title">
      <div className="card-head">
        <div>
          <div className="eyebrow">30-second setup</div>
          <h2 id="setup-title" style={{ fontSize: 24 }}>
            Confirm your machine
          </h2>
          <p>We pre-filled what your browser could tell us. Adjust anything that's wrong, and every estimate updates instantly.</p>
        </div>
      </div>
      <SetupForm />
    </section>
  );
}

export function MachineSetupModal() {
  const open = useStore((s) => s.setupOpen);
  const setOpen = useStore((s) => s.setSetupOpen);
  if (!open) return null;
  return (
    <Modal title="Your machine" onClose={() => setOpen(false)} wide>
      <SetupForm onDone={() => setOpen(false)} />
    </Modal>
  );
}
