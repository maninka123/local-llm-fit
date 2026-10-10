import { useMemo, useState } from "react";
import { Apple, CheckCircle2, Cpu, Download, HelpCircle, Laptop, Monitor, Sparkles } from "lucide-react";
import { useStore } from "../state/store";
import { suggestSetup, type BrowserSetup } from "../platform/browserDetect";
import { APPLE_CHIPS, CARD_NAMES, COMMON_RAM_GB, lookupGpu } from "../platform/gpuSpecs";
import { Modal, Seg } from "./ui";

const RELEASES = "https://github.com/maninka123/local-llm-fit/releases";

/** Form to confirm what the browser detected and fill in what it can't see. */
type GpuChoice = "card" | "apple" | "none";

function SetupForm({ onDone }: { onDone?: () => void }) {
  const sig = useStore((s) => s.browserSignals);
  const saved = useStore((s) => s.browserSetup);
  const save = useStore((s) => s.saveBrowserSetup);
  const setDemo = useStore((s) => s.setDemo);
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
    <div className="stack" style={{ gap: 20 }}>
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
              <input id="setup-gpu" className="input" list="known-cards" value={cardName} placeholder="Start typing, e.g. RTX 4070" onChange={(e) => pickCard(e.target.value)} />
              <datalist id="known-cards">
                {CARD_NAMES.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
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
          <CheckCircle2 size={16} /> Use these answers
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
