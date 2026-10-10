import { Cpu, HardDrive, Laptop, Monitor, MemoryStick, RefreshCw, Server, CircuitBoard, Boxes } from "lucide-react";
import { useStore } from "../state/store";
import { useMachine } from "../state/derived";
import { fmtBytes } from "../lib/units";
import type { FormFactor } from "../domain/types";

export const FORM_LABEL: Record<FormFactor, string> = {
  desktop: "Desktop",
  laptop: "Laptop",
  workstation: "Workstation",
  server: "Server",
  virtual_machine: "Virtual machine",
  unknown: "Unknown",
};

export function FormIcon({ f, size = 15 }: { f: FormFactor | null | undefined; size?: number }) {
  if (f === "laptop") return <Laptop size={size} />;
  if (f === "server" || f === "workstation") return <Server size={size} />;
  if (f === "virtual_machine") return <Boxes size={size} />;
  return <Monitor size={size} />;
}

export function MachineBar() {
  const hw = useStore((s) => s.hardware);
  const status = useStore((s) => s.hardwareStatus);
  const o = useStore((s) => s.overrides);
  const rescan = useStore((s) => s.rescanHardware);
  const navigate = useStore((s) => s.navigate);
  const ol = useStore((s) => s.ollamaState);
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
  const gpu = m.gpus[0];
  return (
    <header className="machine-bar" aria-label="Your machine">
      <div className="inner">
        {hw.demo && (
          <span className="badge demo" title="This web preview cannot read your hardware. Values are from a demo machine.">
            Demo hardware
          </span>
        )}
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
            <b className="num">{fmtBytes(m.ramFree)} free</b>
            <span className="muted num opt">of {fmtBytes(m.ramTotal)}</span>
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
                <b>{m.arch === "integrated_shared" ? "Integrated GPU (shares RAM)" : "No usable GPU"}</b>
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
        <button className="chip" style={{ cursor: "pointer" }} onClick={() => navigate({ page: "settings" })} title={ol.error ?? `Ollama ${ol.version ?? ""}`}>
          <span className={`pill ${ol.status === "online" ? "tone-good" : ol.status === "checking" ? "tone-neutral" : "tone-neutral"}`} style={{ height: 20, padding: "0 8px", fontSize: 11.5 }}>
            <span className="lamp" />
            Ollama {ol.status === "online" ? `${ol.version ?? ""}` : ol.status === "checking" ? "…" : "not running"}
          </span>
        </button>
        <span className="spacer" />
        <button className="btn sm" onClick={() => void rescan()} disabled={status === "probing"} aria-label="Rescan hardware">
          <RefreshCw size={14} className={status === "probing" ? "spin" : ""} /> Rescan
        </button>
      </div>
    </header>
  );
}
