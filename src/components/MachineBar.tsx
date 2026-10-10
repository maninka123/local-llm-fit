import { ArrowLeft, Cpu, HardDrive, Laptop, Monitor, MemoryStick, RefreshCw, Download, Server, CircuitBoard, Boxes, Microchip } from "lucide-react";
import { useStore } from "../state/store";
import { useMachine } from "../state/derived";
import type { MachineProfile } from "../domain/estimator";
import { useUpdater } from "./Updater";
import { DEMO_MACHINES } from "../platform/demoHardware";
import { fmtBytes } from "../lib/units";
import { isTauri } from "../platform/bridge";
import { DesktopCta } from "./DesktopCta";
import type { FormFactor, HardwareReport } from "../domain/types";

export const FORM_LABEL: Record<FormFactor, string> = {
  desktop: "Desktop",
  laptop: "Laptop",
  workstation: "Workstation",
  server: "Server",
  virtual_machine: "Virtual machine",
  embedded: "Single-board computer",
  unknown: "Unknown",
};

export function FormIcon({ f, size = 15 }: { f: FormFactor | null | undefined; size?: number }) {
  if (f === "laptop") return <Laptop size={size} />;
  if (f === "server" || f === "workstation") return <Server size={size} />;
  if (f === "virtual_machine") return <Boxes size={size} />;
  if (f === "embedded") return <Microchip size={size} />;
  return <Monitor size={size} />;
}

/** OS, device type, processor and memory chips for one machine. */
function HardwareChips({ hw, m, ff, ffConf }: { hw: HardwareReport; m: MachineProfile; ff: FormFactor | null; ffConf: string }) {
  const gpu = m.gpus[0];
  return (
    <>
      <span className="chip" title={`${hw.os.name} ${hw.os.version}`}>
        <HardDrive size={15} />
        <b>{hw.os.name}</b>
        <span className="muted opt">{hw.os.version}</span>
      </span>
      <span className="chip" title={hw.formFactorEvidence.join(" · ") || "No evidence"}>
        <FormIcon f={ff} />
        <b>{ff && ff !== "unknown" ? (ffConf === "low" || ffConf === "medium" ? `Likely ${FORM_LABEL[ff].toLowerCase()}` : FORM_LABEL[ff]) : "Form factor unknown"}</b>
      </span>
      <span className="chip" title={`${hw.cpu.physicalCores ?? "?"} physical / ${hw.cpu.logicalCores ?? "?"} logical cores`}>
        <Cpu size={15} />
        <b>{hw.cpu.brand}</b>
      </span>
      {m.arch === "unified" ? (
        <span className="chip" title="CPU and GPU share one unified memory pool">
          <CircuitBoard size={15} />
          <span className="k">Unified</span>
          {/* Browsers can't read free memory: show the size only. */}
          <b className="num">{m.ramFree != null ? `${fmtBytes(m.ramFree)} free` : fmtBytes(m.ramTotal)}</b>
          {m.ramFree != null && <span className="muted num opt">of {fmtBytes(m.ramTotal)}</span>}
        </span>
      ) : (
        <>
          {m.arch === "discrete" && gpu && (
            <span className="chip" title={`${gpu.name}${m.gpus.length > 1 ? ` (+${m.gpus.length - 1} more selected)` : ""}`}>
              <CircuitBoard size={15} />
              <span className="k">VRAM</span>
              <b className="num">{gpu.vramFree != null ? `${fmtBytes(gpu.vramFree)} free` : fmtBytes(gpu.vramTotal)}</b>
              {gpu.vramFree != null && <span className="muted num opt">of {fmtBytes(gpu.vramTotal)}</span>}
            </span>
          )}
          {m.arch !== "discrete" && (
            <span className="chip">
              <CircuitBoard size={15} />
              <b>{m.arch === "integrated_shared" ? "GPU not used by Ollama (shares RAM)" : "No usable GPU"}</b>
            </span>
          )}
          <span className="chip">
            <MemoryStick size={15} />
            <span className="k">RAM</span>
            <b className="num">{m.ramFree != null ? `${fmtBytes(m.ramFree)} free` : fmtBytes(m.ramTotal)}</b>
            {m.ramFree != null && <span className="muted num opt">of {fmtBytes(m.ramTotal)}</span>}
          </span>
        </>
      )}
    </>
  );
}

export function MachineBar() {
  const hw = useStore((s) => s.hardware);
  const status = useStore((s) => s.hardwareStatus);
  const o = useStore((s) => s.overrides);
  const rescan = useStore((s) => s.rescanHardware);
  const demoName = useStore((s) => DEMO_MACHINES.find((d) => d.id === s.demoId)?.name.split(" · ")[0] ?? "sample");
  const setSetupOpen = useStore((s) => s.setSetupOpen);
  const basis = useStore((s) => s.settings.memoryBasis);
  const browserSetup = useStore((s) => s.browserSetup);
  const updPhase = useUpdater((u) => u.phase);
  const updVersion = useUpdater((u) => u.update?.version);
  const m = useMachine();
  if (!hw || !m) {
    return (
      <div className="machine-bar">
        <div className="inner">
          <span className="chip">
            <RefreshCw size={15} className="spin" /> Detecting your hardware…
          </span>
        </div>
      </div>
    );
  }
  const ff = o.formFactor ?? hw.formFactor.value;
  const ffConf = o.formFactor ? "manual" : hw.formFactor.confidence;
  const isSample = hw.mode === "demo" || (hw.demo && hw.mode == null);
  const useMine = () => {
    const st = useStore.getState();
    st.useBrowserHardware();
    if (!isTauri() && !browserSetup) st.setSetupOpen(true); // web: confirm the browser's guesses first
  };
  return (
    <header className="machine-bar" aria-label="Your machine">
      <div className="inner">
        {/* The machine every result on the page is calculated for, ringed so it's clear what's active. */}
        <div className={`bar-chips active-machine ${isSample ? "is-sample" : ""}`} aria-label={isSample ? "Results are for this sample machine" : "Results are for your computer"}>
          {isSample ? (
            <button className="badge demo" style={{ cursor: "pointer" }} onClick={() => setSetupOpen(true)} data-tip="Choose another sample or adjust it" data-tip-pos="below">
              Sample: {demoName} · change
            </button>
          ) : hw.mode === "browser" ? (
            <button
              className={`badge ${hw.browserConfirmed ? "demo" : "estimated pulse"}`}
              style={{ cursor: "pointer" }}
              onClick={() => setSetupOpen(true)}
              data-tip="Estimated in your browser from your answers. Click to review."
              data-tip-pos="below"
            >
              {hw.browserConfirmed ? "My computer · edit" : "Set up my computer"}
            </button>
          ) : (
            <button
              className="badge demo"
              style={{ cursor: "pointer" }}
              onClick={() => setSetupOpen(true)}
              data-tip={basis === "live" ? "Live: memory free right now, with your apps open. Click to change." : "Normal use: keeps about 20% of memory for the system and apps. Click to change."}
              data-tip-pos="below"
            >
              My computer · {basis === "live" ? "Live" : "Normal use"}
            </button>
          )}
          <HardwareChips hw={hw} m={m} ff={ff} ffConf={ffConf} />
        </div>
        <div className="bar-actions">
        {!isSample && (
          <button className="btn icon-btn round" onClick={() => void rescan()} disabled={status === "probing"} aria-label="Rescan hardware" data-tip="Rescan hardware" data-tip-pos="below" data-tip-align="end">
            <RefreshCw size={16} className={status === "probing" ? "spin" : ""} />
          </button>
        )}
        {isSample && (
          <button className="btn primary sm back-mine" onClick={useMine} data-tip="Show results for your own computer" data-tip-pos="below" data-tip-align="end">
            <ArrowLeft size={15} /> {isTauri() || browserSetup ? "Back to my computer" : "Set up my computer"}
          </button>
        )}
        {!isTauri() && <DesktopCta />}
        {(updPhase === "available" || updPhase === "downloading" || updPhase === "installing") && (
          <button className="btn primary sm update-btn" onClick={() => useUpdater.getState().set({ open: true })} data-tip={updVersion ? `Version ${updVersion} is ready` : "Update ready"} data-tip-pos="below" data-tip-align="end">
            <Download size={15} /> {updPhase === "available" ? "Update" : "Updating…"}
          </button>
        )}
        </div>
      </div>
    </header>
  );
}
