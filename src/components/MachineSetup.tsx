import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Apple, Briefcase, CheckCircle2, Cpu, Download, FlaskConical, HelpCircle, Laptop, Microchip, Monitor, Sparkles } from "lucide-react";
import { useStore } from "../state/store";
import { detectBrowser, suggestSetup, type BrowserSetup } from "../platform/browserDetect";
import { isTauri } from "../platform/bridge";
import { APPLE_CHIPS, COMMON_RAM_GB, DESKTOP_GPU_NAMES, LAPTOP_GPU_NAMES, lookupGpu } from "../platform/gpuSpecs";
import { GpuCombobox } from "./GpuCombobox";
import { Select } from "./Select";
import { Modal, Seg } from "./ui";
import { BOARD_MACHINES, type DemoMachine } from "../platform/demoHardware";
import { DEFAULT_SAMPLES, MAC_MODELS, buildSample, chipsFor, presetConfig, vramOptionsFor, type SampleConfig, type SampleKind } from "../platform/samples";
import { GiB } from "../lib/units";
import { FormIcon } from "./MachineBar";

const RELEASES = "https://github.com/maninka123/local-llm-fit/releases";

/** Form to confirm what the browser detected and fill in what it can't see. */
type GpuChoice = "card" | "apple" | "none";

function SetupForm({ onDone }: { onDone?: () => void }) {
  const webHardware = useStore((s) => s.webHardware);
  const [mode, setMode] = useState<"mine" | "sample">(webHardware === "demo" ? "sample" : "mine");
  const sig = useStore((s) => s.browserSignals);
  useEffect(() => {
    // Sample mode skips detection; detect now so "My computer" can be pre-filled.
    if (!sig && !isTauri()) void detectBrowser().then((d) => useStore.setState({ browserSignals: d }));
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
      {mode === "mine" ? isTauri() ? <DetectedForm onDone={onDone} /> : <MineForm onDone={onDone} /> : <SamplePicker onDone={onDone} />}
    </div>
  );
}

const BOARDS = BOARD_MACHINES;
/** Board whose GPU Ollama can use (Jetson Orin/Thor, DGX Spark: CUDA on shared memory). */
const boardGpuUsable = (d: DemoMachine) => d.report.memoryArchitecture.value === "unified";
const PRO_CARD = /rtx pro|\bada\b|rtx a\d|radeon pro/i;
const DESKTOP_CARDS = [...DESKTOP_GPU_NAMES.filter((n) => !PRO_CARD.test(n)), ...DESKTOP_GPU_NAMES.filter((n) => PRO_CARD.test(n))];

const KINDS: { id: SampleKind; title: string; sub: string; icon: React.ReactNode }[] = [
  { id: "desktop", title: "Desktop / workstation", sub: "Pick the graphics card", icon: <Monitor size={22} /> },
  { id: "laptop", title: "Gaming laptop", sub: "Pick the laptop GPU", icon: <Laptop size={22} /> },
  { id: "mac", title: "Mac", sub: "Pick the Mac and chip", icon: <Apple size={22} /> },
  { id: "office", title: "Office laptop", sub: "Built-in graphics", icon: <Briefcase size={22} /> },
  { id: "board", title: "Single-board & edge AI", sub: "Raspberry Pi, Jetson, DGX Spark…", icon: <Microchip size={22} /> },
];

function SamplePicker({ onDone }: { onDone?: () => void }) {
  const savedSample = useStore((s) => s.sample);
  const demoId = useStore((s) => s.demoId);
  const saved = savedSample ?? presetConfig(demoId);
  // One draft per type, so switching types keeps what you picked.
  const [drafts, setDrafts] = useState<Record<SampleKind, SampleConfig>>(() => ({ ...DEFAULT_SAMPLES, [saved.kind]: saved }));
  const [kind, setKind] = useState<SampleKind>(saved.kind);
  const cfg = drafts[kind];
  const update = (p: Partial<SampleConfig>) => setDrafts((d) => ({ ...d, [kind]: { ...d[kind], ...p } as SampleConfig }));
  const preview = useMemo(() => buildSample(cfg), [cfg]);
  const ready = (cfg.kind !== "desktop" && cfg.kind !== "laptop") || (cfg.gpu.trim() !== "" && cfg.vramGiB > 0);

  const pickCard = (name: string) => {
    const opts = vramOptionsFor(name);
    update({ gpu: name, ...(opts.length ? { vramGiB: opts[0] } : {}) } as Partial<SampleConfig>);
  };

  const apply = () => {
    const st = useStore.getState();
    st.setSample(cfg);
    st.setSetupOpen(false);
    onDone?.();
    st.showToast(`Now showing the sample: ${preview.name.split(" · ").slice(0, 2).join(" · ")}`, "info");
  };

  const cardFields = (c: Extract<SampleConfig, { kind: "desktop" | "laptop" }>) => {
    const opts = vramOptionsFor(c.gpu);
    const spec = lookupGpu(c.gpu);
    return (
      <>
        <div className="field">
          <label htmlFor="sample-gpu">{c.kind === "laptop" ? "Laptop GPU" : "Graphics card"}</label>
          <GpuCombobox id="sample-gpu" value={c.gpu} onChange={pickCard} names={c.kind === "laptop" ? LAPTOP_GPU_NAMES : DESKTOP_CARDS} placeholder="Start typing, e.g. RTX 4070" />
          <span className="field-hint">{spec?.vendor === "amd" || spec?.vendor === "intel" ? "Ollama GPU support for AMD and Intel cards varies by model." : "Type to search, or pick from the list."}</span>
        </div>
        <div className="field">
          <span>Graphics memory (VRAM)</span>
          {opts.length > 0 ? (
            <Seg label="Graphics memory" value={c.vramGiB} onChange={(v) => update({ vramGiB: v } as Partial<SampleConfig>)} options={opts.map((g) => ({ value: g, label: `${g} GB` }))} />
          ) : (
            <MemoryStepper label="Graphics memory (VRAM)" value={c.vramGiB} onChange={(v) => update({ vramGiB: v } as Partial<SampleConfig>)} hint="Not in our list: enter its memory." changed={false} />
          )}
        </div>
      </>
    );
  };

  return (
    <div className="stack appear" style={{ gap: 16 }}>
      <p className="muted" style={{ margin: 0, fontSize: 15 }}>
        Pick a type of computer, then its parts. Your own answers are kept for when you switch back.
      </p>
      <div className="sample-grid" role="radiogroup" aria-label="Sample machines">
        {KINDS.map((k) => (
          <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} className={`choice-card ${kind === k.id ? "on" : ""}`} onClick={() => setKind(k.id)}>
            <span className="choice-icon">{k.icon}</span>
            <span className="choice-title">{k.title}</span>
            <span className="choice-sub">{k.sub}</span>
            <CheckCircle2 size={18} className="choice-check" aria-hidden />
          </button>
        ))}
      </div>

      <div className="setup-step sample-edit appear" key={kind}>
        <div className="grid cols-2" style={{ gap: 16 }}>
          {cfg.kind === "desktop" && (
            <>
              {cardFields(cfg)}
              <div className="field">
                <span>How many graphics cards?</span>
                <Seg label="Number of graphics cards" value={cfg.gpuCount} onChange={(v) => update({ gpuCount: v } as Partial<SampleConfig>)} options={[{ value: 1 as const, label: "One" }, { value: 2 as const, label: "Two" }]} />
                <span className="field-hint">{cfg.gpuCount === 2 ? "Ollama spreads a model across both cards." : "Most PCs have one."}</span>
              </div>
              <MemoryStepper label="System memory (RAM)" value={cfg.ramGiB} onChange={(v) => update({ ramGiB: v })} hint="Used when a model doesn't fit in the graphics card." changed={false} />
            </>
          )}
          {cfg.kind === "laptop" && (
            <>
              {cardFields(cfg)}
              <MemoryStepper label="System memory (RAM)" value={cfg.ramGiB} onChange={(v) => update({ ramGiB: v })} hint="Used when a model doesn't fit in the GPU." changed={false} />
            </>
          )}
          {cfg.kind === "mac" && (
            <>
              <div className="field" style={{ gridColumn: "1 / -1" }}>
                <span>Which Mac?</span>
                <Seg
                  label="Mac model"
                  value={cfg.model}
                  onChange={(model) => {
                    const chips = chipsFor(model);
                    const chip = chips.find((c) => c.name === cfg.chip) ?? chips[0];
                    update({ model, chip: chip.name, ramGiB: chip.options.includes(cfg.ramGiB) ? cfg.ramGiB : chip.options[0] } as Partial<SampleConfig>);
                  }}
                  options={MAC_MODELS.map((m) => ({ value: m, label: m }))}
                />
              </div>
              <div className="field">
                <label htmlFor="sample-chip">Chip</label>
                <Select
                  id="sample-chip"
                  value={cfg.chip}
                  onChange={(name) => {
                    const chip = chipsFor(cfg.model).find((c) => c.name === name)!;
                    update({ chip: chip.name, ramGiB: chip.options.includes(cfg.ramGiB) ? cfg.ramGiB : chip.options[0] } as Partial<SampleConfig>);
                  }}
                  options={chipsFor(cfg.model).map((c) => ({ value: c.name, label: c.name, meta: `${c.options.join(" / ")} GB` }))}
                />
                <span className="field-hint">Only chips Apple put in the {cfg.model}.</span>
              </div>
              <div className="field">
                <span>Memory</span>
                <Seg label="Unified memory" value={cfg.ramGiB} onChange={(v) => update({ ramGiB: v })} options={(chipsFor(cfg.model).find((c) => c.name === cfg.chip)?.options ?? [cfg.ramGiB]).map((g) => ({ value: g, label: `${g} GB` }))} />
                <span className="field-hint">Shared by the CPU and GPU.</span>
              </div>
            </>
          )}
          {cfg.kind === "office" && (
            <>
              <div className="field">
                <span>Memory (RAM)</span>
                <Seg label="Memory" value={cfg.ramGiB} onChange={(v) => update({ ramGiB: v })} options={[8, 16, 24, 32, 64].map((g) => ({ value: g, label: `${g} GB` }))} />
              </div>
              <p className="board-gpu warn" style={{ margin: 0 }}>
                <AlertTriangle size={16} /> <span>Built-in graphics aren't used by Ollama, so models run on the CPU.</span>
              </p>
            </>
          )}
          {cfg.kind === "board" && (
            <>
              <div className="field">
                <label htmlFor="board-pick">Which board?</label>
                <Select
                  id="board-pick"
                  value={cfg.boardId}
                  onChange={(id) => update({ boardId: id, ramGiB: presetConfig(id).ramGiB } as Partial<SampleConfig>)}
                  options={[...BOARDS.filter(boardGpuUsable), ...BOARDS.filter((d) => !boardGpuUsable(d))].map((d) => ({
                    value: d.id,
                    label: d.name.split(" · ")[0],
                    meta: d.name.split(" · ")[1],
                    group: boardGpuUsable(d) ? "GPU used by Ollama (CUDA)" : "GPU Ollama can't use (runs on the CPU)",
                  }))}
                />
              </div>
              <MemoryStepper label={boardGpuUsable(preview) ? "Shared memory" : "Memory (RAM)"} value={cfg.ramGiB} onChange={(v) => update({ ramGiB: v })} hint={preview.report.cpu.brand} changed={cfg.ramGiB !== presetConfig(cfg.boardId).ramGiB} />
              <div style={{ gridColumn: "1 / -1" }}>
                {boardGpuUsable(preview) ? (
                  <p className="board-gpu ok" style={{ margin: 0 }}>
                    <CheckCircle2 size={16} /> <span><b>GPU usable:</b> {preview.report.gpus[0]?.name}. Ollama runs models on its CUDA GPU, sharing the board's memory.</span>
                  </p>
                ) : (
                  <p className="board-gpu warn" style={{ margin: 0 }}>
                    <AlertTriangle size={16} />{" "}
                    <span>
                      <b>GPU not usable:</b> it has a GPU ({preview.report.gpus[0]?.name ?? "integrated"}), but Ollama can't use it, so models run on the CPU. <span className="muted">{preview.report.formFactorEvidence[1]}.</span>
                    </span>
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="sample-summary" aria-live="polite">
        <FormIcon f={preview.report.formFactor.value} size={18} />
        <span>
          <b>{preview.name.split(" · ")[0]}</b> · {preview.name.split(" · ").slice(1).join(" · ")}
        </span>
      </div>
      <div className="row">
        <button className="btn primary" onClick={apply} disabled={!ready}>
          <CheckCircle2 size={16} /> Show this machine
        </button>
        <button className="btn ghost" onClick={() => setDrafts((d) => ({ ...d, [kind]: DEFAULT_SAMPLES[kind] }))}>
          Reset
        </button>
      </div>
    </div>
  );
}

function MemoryStepper({ label, value, onChange, hint, changed, changedText = "Changed" }: { label: string; value: number | null; onChange: (v: number) => void; hint: string; changed: boolean; changedText?: string }) {
  return (
    <label className="field">
      <span className="row" style={{ justifyContent: "space-between" }}>
        {label}
        {changed && <span className="src-tag manual">{changedText}</span>}
      </span>
      <div className="stepper">
        <button type="button" aria-label={`Less ${label}`} onClick={() => onChange(Math.max(1, (value ?? 0) - 1))}>
          −
        </button>
        <input className="input" type="number" min={1} max={1024} step={1} value={value ?? ""} onChange={(e) => onChange(Math.max(1, +e.target.value || 1))} aria-label={label} />
        <span className="unit">GB</span>
        <button type="button" aria-label={`More ${label}`} onClick={() => onChange((value ?? 0) + 1)}>
          +
        </button>
      </div>
      <span className="field-hint">{hint}</span>
    </label>
  );
}

/** Desktop: show what was detected and let the user adjust it (stored as overrides). */
function DetectedForm({ onDone }: { onDone?: () => void }) {
  const native = useStore((s) => s.nativeReport);
  const overrides = useStore((s) => s.overrides);
  const webHardware = useStore((s) => s.webHardware);
  if (!native) return <p className="muted">Reading your hardware…</p>;
  return <DetectedFormInner native={native} overrides={webHardware === "demo" ? null : overrides} onDone={onDone} />;
}

function DetectedFormInner({ native, overrides, onDone }: { native: import("../domain/types").HardwareReport; overrides: import("../domain/types").HardwareOverrides | null; onDone?: () => void }) {
  const unified = native.memoryArchitecture.value === "unified";
  const gpu = native.gpus.find((g) => g.kind === "discrete" && g.dedicatedBytes.value);
  const detVram = gpu?.dedicatedBytes.value ? Math.round(gpu.dedicatedBytes.value / GiB) : null;
  const detRam = Math.round((native.memory.totalBytes.value ?? 0) / GiB);
  const [vram, setVram] = useState<number | null>(overrides?.vramTotalGiB ?? detVram);
  const [ram, setRam] = useState<number>(overrides?.ramTotalGiB ?? detRam);
  const changed = ram !== detRam || (vram != null && vram !== detVram);
  const basis = useStore((s) => s.settings.memoryBasis);

  const apply = () => {
    const st = useStore.getState();
    const o: Partial<import("../domain/types").HardwareOverrides> = { ramTotalGiB: null, ramFreeGiB: null, vramTotalGiB: null, vramFreeGiB: null };
    if (ram !== detRam) {
      // keep what apps use today; the rest of the new total counts as free
      const used = ((native.memory.totalBytes.value ?? 0) - (native.memory.availableBytes.value ?? 0)) / GiB;
      o.ramTotalGiB = ram;
      o.ramFreeGiB = Math.max(1, Math.round((ram - used) * 10) / 10);
    }
    if (gpu && vram != null && vram !== detVram) {
      const used = ((gpu.dedicatedBytes.value ?? 0) - (gpu.freeBytes.value ?? gpu.dedicatedBytes.value ?? 0)) / GiB;
      o.vramTotalGiB = vram;
      o.vramFreeGiB = Math.max(0.5, Math.round((vram - used) * 10) / 10);
    }
    useStore.setState({ webHardware: "browser", hardware: native });
    st.setOverrides(o);
    st.setSetupOpen(false);
    onDone?.();
    st.showToast(changed ? "Showing your computer, with your changes" : "Showing your computer", "info");
  };

  return (
    <div className="stack appear" style={{ gap: 18 }}>
      <div className="setup-detected">
        <div className="eyebrow">Detected on this computer</div>
        <div className="row" style={{ gap: 18, marginTop: 6 }}>
          <span className="row" style={{ gap: 6 }}>
            <Sparkles size={15} /> <b>{native.gpus[0]?.name ?? "No graphics card"}</b>
          </span>
          <span className="row" style={{ gap: 6 }}>
            <Cpu size={15} /> {native.cpu.brand}
          </span>
          <span className="row" style={{ gap: 6 }}>
            <Monitor size={15} /> {native.os.name} {native.os.version}
          </span>
        </div>
      </div>
      <div className="setup-step">
        <div className="setup-q">
          <span className="step-num">1</span> Plan with which memory?
        </div>
        <Seg
          label="Memory figures"
          value={basis}
          onChange={(v) => useStore.getState().setSettings({ memoryBasis: v })}
          options={[
            { value: "live", label: "Live", title: "Memory free right now, with your apps open" },
            { value: "planning", label: "Normal use", title: "Normal background use: keeps about 20% of memory for the system and apps" },
          ]}
        />
      </div>
      <div className="setup-step">
        <div className="setup-q">
          <span className="step-num">2</span> Try different values (optional)
        </div>
        <div className="grid cols-2" style={{ gap: 16 }}>
          {unified ? (
            <MemoryStepper label="Unified memory" value={ram} onChange={setRam} hint={`Detected: ${detRam} GB`} changed={ram !== detRam} />
          ) : (
            <>
              {gpu && <MemoryStepper label="Graphics memory (VRAM)" value={vram} onChange={(v) => setVram(v)} hint={`Detected: ${detVram} GB`} changed={vram !== detVram} />}
              <MemoryStepper label="System memory (RAM)" value={ram} onChange={setRam} hint={`Detected: ${detRam} GB`} changed={ram !== detRam} />
            </>
          )}
        </div>
      </div>
      <div className="row">
        <button className="btn primary" onClick={apply}>
          <CheckCircle2 size={16} /> Use my computer
        </button>
        {changed && (
          <button
            className="btn ghost"
            onClick={() => {
              setRam(detRam);
              setVram(detVram);
            }}
          >
            Reset to detected
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
    { id: "none", title: "No graphics card", sub: "Built-in graphics, or not sure", icon: <Cpu size={24} /> },
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
            <Select id="setup-chip" value={chip} onChange={pickChip} options={[{ value: "", label: "Choose your chip…" }, ...APPLE_CHIPS.map((c) => ({ value: c.name, label: c.name, meta: `${c.options.join(" / ")} GB` }))]} />
            <span className="field-hint">Apple menu → About This Mac → Chip. The GPU shares memory with the CPU.</span>
          </div>
        )}
        {choice === "none" && (
          <p className="field-hint appear" style={{ marginTop: 12 }} key="none">
            Models will load into system memory and run on the processor. That's slower than a graphics card, so the estimates stay on the safe side.
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
