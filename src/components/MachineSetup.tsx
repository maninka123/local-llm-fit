import { useEffect, useMemo, useState } from "react";
import { Apple, CheckCircle2, Cpu, Download, FlaskConical, HelpCircle, Laptop, Monitor, Sparkles } from "lucide-react";
import { useStore } from "../state/store";
import { detectBrowser, suggestSetup, type BrowserSetup } from "../platform/browserDetect";
import { APPLE_CHIPS, COMMON_RAM_GB, lookupGpu } from "../platform/gpuSpecs";
import { GpuCombobox } from "./GpuCombobox";
import { Modal, Seg } from "./ui";
import { DEMO_MACHINES } from "../platform/demoHardware";
import { GiB } from "../lib/units";

const RELEASES = "https://github.com/maninka123/local-llm-fit/releases";

/** Form to confirm what the browser detected and fill in what it can't see. */
type GpuChoice = "card" | "apple" | "none";

function SetupForm({ onDone }: { onDone?: () => void }) {
  const webHardware = useStore((s) => s.webHardware);
  const [mode, setMode] = useState<"mine" | "sample">(webHardware === "demo" ? "sample" : "mine");
  const sig = useStore((s) => s.browserSignals);
  useEffect(() => {
    // Sample mode skips detection; detect now so "My computer" can be pre-filled.
    if (!sig) void detectBrowser().then((d) => useStore.setState({ browserSignals: d }));
  }, [sig]);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="mode-switch" role="radiogroup" aria-label="Which computer">
        <button type="button" role="radio" aria-checked={mode === "mine"} className={mode === "mine" ? "on" : ""} onClick={() => setMode("mine")}>
          <Laptop size={18} /> My computer
        </button>
        <button type="button" role="radio" aria-checked={mode === "sample"} className={mode === "sample" ? "on" : ""} onClick={() => setMode("sample")}>
          <FlaskConical size={18} /> Sample machine
        </button>
      </div>
      {mode === "mine" ? <MineForm onDone={onDone} /> : <SamplePicker onDone={onDone} />}
    </div>
  );
}

function SamplePicker({ onDone }: { onDone?: () => void }) {
  const webHardware = useStore((s) => s.webHardware);
  const demoId = useStore((s) => s.demoId);
  const overrides = useStore((s) => s.overrides);
  const [sel, setSel] = useState(demoId);
  const sample = DEMO_MACHINES.find((d) => d.id === sel) ?? DEMO_MACHINES[0];
  const unified = sample.report.memoryArchitecture.value === "unified";
  const gpu = sample.report.gpus.find((g) => g.kind === "discrete");
  const baseVram = gpu?.dedicatedBytes.value ? Math.round(gpu.dedicatedBytes.value / GiB) : null;
  const baseRam = Math.round((sample.report.memory.totalBytes.value ?? 0) / GiB);
  const keepEdits = webHardware === "demo" && demoId === sel;
  const [vram, setVram] = useState<number | null>(keepEdits ? (overrides.vramTotalGiB ?? baseVram) : baseVram);
  const [ram, setRam] = useState<number>(keepEdits ? (overrides.ramTotalGiB ?? baseRam) : baseRam);

  const pick = (id: string) => {
    setSel(id);
    const d = DEMO_MACHINES.find((x) => x.id === id)!;
    const g = d.report.gpus.find((x) => x.kind === "discrete");
    setVram(g?.dedicatedBytes.value ? Math.round(g.dedicatedBytes.value / GiB) : null);
    setRam(Math.round((d.report.memory.totalBytes.value ?? 0) / GiB));
  };

  const apply = () => {
    const st = useStore.getState();
    st.setDemo(sel); // resets overrides, then we apply only what the user changed
    const o: Partial<typeof overrides> = {};
    if (ram !== baseRam) {
      o.ramTotalGiB = ram;
      o.ramFreeGiB = Math.round(ram * 0.7 * 10) / 10; // assume a typical 30% already in use
    }
    if (!unified && vram != null && vram !== baseVram) {
      o.vramTotalGiB = vram;
      o.vramFreeGiB = Math.round(vram * 0.95 * 10) / 10;
    }
    if (Object.keys(o).length) st.setOverrides(o);
    st.setSetupOpen(false);
    onDone?.();
    st.showToast(`Now showing the sample: ${sample.name.split(" · ")[0]}${Object.keys(o).length ? " (with your changes)" : ""}`, "info");
  };

  const numberField = (label: string, value: number | null, set: (v: number) => void, hint: string, changed: boolean) => (
    <label className="field">
      <span className="row" style={{ justifyContent: "space-between" }}>
        {label}
        {changed && <span className="src-tag manual">Changed</span>}
      </span>
      <div className="stepper">
        <button type="button" aria-label={`Less ${label}`} onClick={() => set(Math.max(2, (value ?? 0) - 2))}>
          −
        </button>
        <input className="input" type="number" min={1} max={1024} step={2} value={value ?? ""} onChange={(e) => set(Math.max(1, +e.target.value || 1))} aria-label={label} />
        <span className="unit">GB</span>
        <button type="button" aria-label={`More ${label}`} onClick={() => set((value ?? 0) + 2)}>
          +
        </button>
      </div>
      <span className="field-hint">{hint}</span>
    </label>
  );

  return (
    <div className="stack appear" style={{ gap: 16 }}>
      <p className="muted" style={{ margin: 0, fontSize: 15 }}>
        Pick a ready-made computer, then adjust it if you like. Your own answers are kept for when you switch back.
      </p>
      <div className="sample-grid" role="radiogroup" aria-label="Sample machines">
        {DEMO_MACHINES.map((d) => {
          const ff = d.report.formFactor.value;
          return (
            <button key={d.id} type="button" role="radio" aria-checked={sel === d.id} className={`choice-card ${sel === d.id ? "on" : ""}`} onClick={() => pick(d.id)}>
              <span className="choice-icon">{ff === "laptop" ? <Laptop size={22} /> : <Monitor size={22} />}</span>
              <span className="choice-title">{d.name.split(" · ")[0]}</span>
              <span className="choice-sub">{d.name.split(" · ").slice(1).join(" · ")}</span>
              <CheckCircle2 size={18} className="choice-check" aria-hidden />
            </button>
          );
        })}
      </div>
      <div className="setup-step sample-edit appear" key={sel}>
        <div className="setup-q">
          <span className="step-num">✎</span> Adjust this sample (optional)
        </div>
        <div className="grid cols-2" style={{ gap: 16 }}>
          {unified
            ? numberField("Unified memory", ram, setRam, "Shared by the CPU and GPU.", ram !== baseRam)
            : (
              <>
                {gpu && numberField("Graphics memory (VRAM)", vram, (v) => setVram(v), gpu.name, vram !== baseVram)}
                {numberField("System memory (RAM)", ram, setRam, sample.report.cpu.brand, ram !== baseRam)}
              </>
            )}
        </div>
      </div>
      <div className="row">
        <button className="btn primary" onClick={apply}>
          <CheckCircle2 size={16} /> Show this machine
        </button>
        {(ram !== baseRam || vram !== baseVram) && (
          <button className="btn ghost" onClick={() => pick(sel)}>
            Reset values
          </button>
        )}
      </div>
    </div>
  );
}

function MineForm({ onDone }: { onDone?: () => void }) {
  const sig = useStore((s) => s.browserSignals);
  const saved = useStore((s) => s.browserSetup);
  const save = useStore((s) => s.saveBrowserSetup);
  const initial = useMemo<BrowserSetup>(() => saved ?? (sig ? suggestSetup(sig) : { confirmed: false, gpuName: null, vramGiB: null, ramGiB: null, formFactor: null }), [saved, sig]);
  const initialSpec = lookupGpu(initial.gpuName);
  const [choice, setChoice] = useState<GpuChoice>(initialSpec?.kind === "unified" ? "apple" : initialSpec?.kind === "discrete" || (initial.gpuName && initial.vramGiB) ? "card" : "none");
  const [cardName, setCardName] = useState(initialSpec?.kind === "discrete" ? (initial.gpuName ?? "") : "");
  const [chip, setChip] = useState(initialSpec?.kind === "unified" ? (APPLE_CHIPS.find((c) => c.name === initialSpec.name)?.name ?? "") : "");
  const [vram, setVram] = useState<number | null>(initial.vramGiB);
  const [ram, setRam] = useState<number | null>(initial.ramGiB);
  const [ff, setFf] = useState(initial.formFactor ?? (sig?.os.name === "macOS" ? "laptop" : "desktop"));

  const cardSpec = choice === "card" ? lookupGpu(cardName) : null;
  const vramOptions = cardSpec?.vramGiB ?? [];
  const chipInfo = APPLE_CHIPS.find((c) => c.name === chip);
  const ramOptions = choice === "apple" && chipInfo ? chipInfo.options : COMMON_RAM_GB;
  const ready = ram != null && (choice !== "card" || (cardName.trim() !== "" && vram != null));

  const pickCard = (name: string) => {
    setCardName(name);
    const sp = lookupGpu(name);
    if (sp?.kind === "discrete" && sp.vramGiB?.length) setVram(sp.vramGiB[0]);
  };
  const pickChip = (name: string) => {
    setChip(name);
    const opts = APPLE_CHIPS.find((c) => c.name === name)?.options;
    if (opts?.length && (ram == null || !opts.includes(ram))) setRam(opts[0]);
  };

  const submit = () => {
    save({
      confirmed: true,
      gpuName: choice === "card" ? cardName.trim() : choice === "apple" ? chip || "Apple Silicon GPU" : null,
      vramGiB: choice === "card" ? vram : null,
      ramGiB: ram,
      formFactor: ff as BrowserSetup["formFactor"],
    });
    onDone?.();
  };

  const CHOICES: { id: GpuChoice; title: string; sub: string; icon: React.ReactNode }[] = [
    { id: "card", title: "Graphics card", sub: "NVIDIA, AMD Radeon or Intel Arc", icon: <Monitor size={24} /> },
    { id: "apple", title: "Apple Silicon", sub: "Mac with an M1–M5 chip", icon: <Apple size={24} /> },
    { id: "none", title: "Built-in / not sure", sub: "Models run on the CPU", icon: <Cpu size={24} /> },
  ];

  return (
    <div className="stack appear" style={{ gap: 20 }}>
      <div className="setup-detected">
        <div className="eyebrow">Detected by your browser</div>
        <div className="row" style={{ gap: 18, marginTop: 6 }}>
          <span className="row" style={{ gap: 6 }}>
            <Sparkles size={15} /> <b>{sig?.gpuName ?? "Graphics name hidden"}</b>
          </span>
          {sig?.cores && (
            <span className="row" style={{ gap: 6 }}>
              <Cpu size={15} /> {sig.cores} CPU threads
            </span>
          )}
          <span className="row" style={{ gap: 6 }}>
            <Monitor size={15} /> {sig?.os.name} {sig?.os.version}
          </span>
        </div>
        <p className="field-hint" style={{ margin: "8px 0 0" }}>
          Browsers hide exact memory sizes, so please check the answers below. Nothing you enter leaves this computer.
        </p>
      </div>

      <div className="setup-step">
        <div className="setup-q">
          <span className="step-num">1</span> What graphics does this computer have?
        </div>
        <div className="choice-grid" role="radiogroup" aria-label="Graphics type">
          {CHOICES.map((c) => (
            <button key={c.id} type="button" role="radio" aria-checked={choice === c.id} className={`choice-card ${choice === c.id ? "on" : ""}`} onClick={() => setChoice(c.id)}>
              <span className="choice-icon">{c.icon}</span>
              <span className="choice-title">{c.title}</span>
              <span className="choice-sub">{c.sub}</span>
              <CheckCircle2 size={18} className="choice-check" aria-hidden />
            </button>
          ))}
        </div>

        {choice === "card" && (
          <div className="grid cols-2 appear" style={{ gap: 16, marginTop: 14 }} key="card">
            <div className="field">
              <label htmlFor="setup-gpu">Which graphics card?</label>
              <GpuCombobox id="setup-gpu" value={cardName} onChange={pickCard} placeholder="Start typing, e.g. RTX 4070" />
              <span className="field-hint">
                {cardSpec?.vramGiB ? `Known spec: ${cardSpec.vramGiB.join(" or ")} GB of graphics memory.` : cardName ? "Not in our list: enter its memory on the right." : sig?.os.name === "Windows" ? "Find it in Task Manager → Performance → GPU." : ""}
              </span>
            </div>
            <div className="field">
              <span>Graphics memory (VRAM)</span>
              {vramOptions.length > 0 ? (
                <Seg label="Graphics memory" value={vram ?? -1} onChange={(v) => setVram(v)} options={vramOptions.map((g) => ({ value: g, label: `${g} GB` }))} />
              ) : (
                <input className="input" type="number" min={1} max={256} placeholder="GB, e.g. 8" aria-label="Graphics memory in GB" value={vram ?? ""} onChange={(e) => setVram(e.target.value ? Math.max(1, +e.target.value) : null)} />
              )}
              <span className="field-hint">Task Manager → Performance → GPU → “Dedicated GPU memory”.</span>
            </div>
          </div>
        )}
        {choice === "apple" && (
          <div className="field appear" style={{ marginTop: 14, maxWidth: 420 }} key="apple">
            <label htmlFor="setup-chip">Which chip?</label>
            <select id="setup-chip" className="select" value={chip} onChange={(e) => pickChip(e.target.value)}>
              <option value="">Choose your chip…</option>
              {APPLE_CHIPS.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <span className="field-hint">Apple menu → About This Mac → Chip. The GPU shares memory with the CPU.</span>
          </div>
        )}
        {choice === "none" && (
          <p className="field-hint appear" style={{ marginTop: 12 }} key="none">
            No problem: we'll estimate how models run on the processor using system memory.
          </p>
        )}
      </div>

      <div className="setup-step">
        <div className="setup-q">
          <span className="step-num">2</span> How much {choice === "apple" ? "memory does the Mac" : "memory (RAM) does it"} have?
        </div>
        <Seg label="Memory size" value={ram ?? -1} onChange={(v) => setRam(v)} options={ramOptions.map((g) => ({ value: g, label: `${g} GB` }))} />
        <span className="field-hint" style={{ display: "block", marginTop: 8 }}>
          <HelpCircle size={13} style={{ verticalAlign: -2 }} />{" "}
          {sig?.os.name === "macOS" ? "Apple menu → About This Mac → Memory." : sig?.os.name === "Windows" ? "Settings → System → About → Installed RAM." : "Run `free -h` in a terminal."}
        </span>
      </div>

      <div className="setup-step">
        <div className="setup-q">
          <span className="step-num">3</span> Is it a laptop or a desktop?
          <span className="faint" style={{ fontWeight: 400, fontSize: 14 }}>
            (just for context)
          </span>
        </div>
        <Seg
          label="Device type"
          value={ff}
          onChange={(v) => setFf(v)}
          options={[
            { value: "laptop", label: <><Laptop size={14} style={{ verticalAlign: -2 }} /> Laptop</> },
            { value: "desktop", label: <><Monitor size={14} style={{ verticalAlign: -2 }} /> Desktop</> },
          ]}
        />
      </div>

      <div className="row">
        <button className="btn primary" disabled={!ready} onClick={submit}>
          <CheckCircle2 size={16} /> Use my computer
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
