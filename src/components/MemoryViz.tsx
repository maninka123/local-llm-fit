import type { Estimate, MachineProfile } from "../domain/estimator";
import { fmtBytes, GiB } from "../lib/units";

// The memory-architecture centerpiece. All lanes share one GiB scale so a block's width
// is directly comparable with a memory pool's width. Placement is a SIMULATION of what a
// runtime would likely do; it is labelled as such, never as observed data.

interface Seg {
  key: string;
  cls: string;
  bytes: number;
  label: string;
  tip: string;
}

function niceStep(max: number): number {
  const g = max / GiB;
  for (const s of [0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512]) if (g / s <= 8) return s * GiB;
  return 1024 * GiB;
}

/** Marks past ~55% of the width put their label on the left, so it never runs off the edge. */
const markClass = (b: number, scale: number) => `overflow-mark${b / scale > 0.55 ? " flip" : ""}`;

function pct(b: number, scale: number) {
  return `${Math.max(0, (b / scale) * 100)}%`;
}

function SegBar({ segs, scale }: { segs: Seg[]; scale: number }) {
  const total = segs.reduce((a, s) => a + s.bytes, 0);
  return (
    <div className="lane-segs" style={{ width: `calc(${pct(total, scale)} - 8px)` }}>
      {segs
        .filter((s) => s.bytes > 0)
        .map((s) => {
          const share = s.bytes / Math.max(total, 1);
          const wide = s.bytes / scale > 0.075;
          return (
            <div
              key={s.key}
              className={`segm ${s.cls}`}
              style={{ width: `${share * 100}%` }}
              tabIndex={0}
              role="img"
              aria-label={`${s.label}: ${fmtBytes(s.bytes)}. ${s.tip}`}
              title={`${s.label}: ${fmtBytes(s.bytes)} (${fmtBytes(s.bytes, "GB")})\n${s.tip}`}
            >
              {wide && (
                <span className="seg-label">
                  <span>{s.label}</span>
                  <small className="num">{fmtBytes(s.bytes)}</small>
                </span>
              )}
            </div>
          );
        })}
    </div>
  );
}

function Lane({ title, sub, capacity, scale, segs, big, children }: { title: string; sub: string; capacity: number | null; scale: number; segs: Seg[]; big?: boolean; children?: React.ReactNode }) {
  return (
    <div className="lane">
      <div className="lane-label">
        <b>{title}</b>
        <span>{sub}</span>
      </div>
      <div className={`lane-track ${big ? "big" : ""}`}>
        {capacity != null && <div className="lane-cap" style={{ width: pct(capacity, scale) }} />}
        <SegBar segs={segs} scale={scale} />
        {children}
      </div>
    </div>
  );
}

export function MemoryViz({ est, machine, showActive }: { est: Estimate; machine: MachineProfile; showActive: boolean }) {
  const p = est.pools;
  const pl = est.placement;
  const W = est.weights?.mid ?? 0;
  const vision = est.visionEncoder?.mid ?? 0;
  const textW = Math.max(0, W - vision);
  const KV = est.kv.mid;
  const gpuBuf = est.scratch.mid + est.visionActivations.mid + est.backend.mid;
  const host = est.hostRuntime.mid;
  const unknownSize = est.weights == null;

  const needSegs: Seg[] = unknownSize
    ? [{ key: "unk", cls: "unknown", bytes: 4 * GiB, label: "Weights: size unknown", tip: "No published file size or parameter count. Verify the exact tag to see the real size." }]
    : [
        {
          key: "w",
          cls: "weights",
          bytes: textW,
          label: est.isMoE ? "Weights (all experts)" : "Model weights",
          tip: est.isMoE ? "Every expert must be stored in memory even though only a few run per token." : "Quantized transformer weights.",
        },
        {
          key: "v",
          cls: `vision ${est.visionEncoderKnown ? "" : "unknownsize"}`,
          bytes: vision,
          label: "Vision encoder",
          tip: est.visionEncoderKnown ? "Projector size from the published manifest." : "Estimated: the encoder size is not published separately.",
        },
      ];
  needSegs.push(
    { key: "kv", cls: "kv", bytes: KV, label: "KV cache", tip: `Grows with context length and parallel sessions (${est.kvMethod === "metadata" ? "from model metadata" : "heuristic range"}).` },
    { key: "rt", cls: "runtime", bytes: gpuBuf, label: "Runtime buffers", tip: "Compute scratch, image activations and backend context (heuristic)." },
    { key: "h", cls: "host", bytes: host, label: "Host process", tip: "Runner process and staging buffers in system RAM." },
  );
  const need = needSegs.reduce((a, s) => a + s.bytes, 0);

  const isDiscrete = p.arch === "discrete" && machine.gpuBackendSupported !== false;
  const isUnified = p.arch === "unified";
  const ramCap = p.ramPhysical ?? 0;
  const vramCap = p.vramPhysical ?? 0;
  const scale = Math.max(need, ramCap, vramCap, 1 * GiB) * 1.06;
  const step = niceStep(scale);
  const ticks: number[] = [];
  for (let t = 0; t <= scale; t += step) ticks.push(t);

  const active = est.active?.mid ?? null;

  // ---- pool lanes
  let lanes: React.ReactNode = null;
  const offloaded = pl ? pl.cpuWeights : 0;
  if (isDiscrete) {
    const vReserve = p.vramPhysical != null && p.vramUsable != null ? Math.max(0, p.vramPhysical - p.vramUsable) : 0;
    const vSegs: Seg[] = [
      { key: "res", cls: "reserve", bytes: vReserve, label: "In use / reserved", tip: p.vramMode === "live" ? "Already used by display, other apps, plus safety margin (live)." : "Planning reserve for display and driver." },
      ...(pl
        ? [
            { key: "gw", cls: "weights", bytes: pl.gpuWeights, label: "Weights on GPU", tip: "Planned placement (simulation)." },
            { key: "gkv", cls: "kv", bytes: pl.gpuKv, label: "KV", tip: "KV cache for GPU-resident layers." },
            { key: "gbuf", cls: "runtime", bytes: pl.gpuOther, label: "Buffers", tip: "Scratch, image activations, backend context." },
          ]
        : []),
    ];
    const rReserve = p.ramPhysical != null && p.ramUsable != null ? Math.max(0, p.ramPhysical - p.ramUsable) : 0;
    const rSegs: Seg[] = [
      { key: "os", cls: "reserve", bytes: rReserve, label: "OS & apps", tip: p.ramFree != null ? "Memory in use now plus your reserve (live)." : "Planning reserve for the OS and apps." },
      ...(pl
        ? [
            { key: "cw", cls: "weights offload", bytes: pl.cpuWeights, label: "Offloaded weights", tip: "Planned offload to system RAM (simulation). These layers run on the CPU." },
            { key: "ckv", cls: "kv", bytes: pl.cpuKv, label: "KV", tip: "KV cache for CPU-resident layers." },
            { key: "host", cls: "host", bytes: pl.hostOther, label: "Host", tip: "Runner process and buffers." },
          ]
        : []),
    ];
    const vUsed = vSegs.reduce((a, s) => a + s.bytes, 0);
    lanes = (
      <>
        <Lane title="GPU memory (VRAM)" sub={`${fmtBytes(p.vramPhysical)} physical · ${fmtBytes(p.vramUsable)} usable`} capacity={p.vramPhysical} scale={scale} segs={vSegs}>
          {vUsed > vramCap * 1.001 && vramCap > 0 && (
            <div className={markClass(vramCap, scale)} style={{ left: pct(vramCap, scale) }}>
              <span>Over capacity</span>
            </div>
          )}
        </Lane>
        {offloaded > 0 && (
          <div className="transfer" aria-label="Conceptual data path between system RAM and GPU VRAM">
            <div />
            <div className="transfer-line">
              <div className="transfer-pipe" aria-hidden>
                <i />
                <i />
                <i />
              </div>
              <span>
                <b style={{ color: "var(--text-2)" }}>Planned offload: {fmtBytes(offloaded)}</b> of weights in RAM · CPU RAM ↔ GPU VRAM data path (conceptual, not
                measured traffic)
              </span>
            </div>
          </div>
        )}
        <Lane title="System RAM" sub={`${fmtBytes(p.ramPhysical)} physical · ${fmtBytes(p.ramUsable)} usable`} capacity={p.ramPhysical} scale={scale} segs={rSegs}>
          {rSegs.reduce((a, s) => a + s.bytes, 0) > ramCap * 1.001 && ramCap > 0 && (
            <div className={markClass(ramCap, scale)} style={{ left: pct(ramCap, scale) }}>
              <span>Over capacity</span>
            </div>
          )}
        </Lane>
      </>
    );
  } else {
    // unified or CPU-only: ONE pool
    const reserve = p.ramPhysical != null && p.ramUsable != null ? Math.max(0, p.ramPhysical - p.ramUsable) : 0;
    const segs: Seg[] = [{ key: "os", cls: "reserve", bytes: reserve, label: "OS & apps", tip: p.ramFree != null ? "Memory in use now plus your reserve (live)." : "Planning reserve." }];
    if (pl) {
      if (isUnified) {
        segs.push(
          { key: "gw", cls: "weights", bytes: pl.gpuWeights, label: "Weights (GPU-usable)", tip: "Inside the GPU working-set limit (simulation)." },
          { key: "cw", cls: "weights offload", bytes: pl.cpuWeights, label: "Weights (CPU)", tip: "Beyond the GPU working-set limit: these layers would run on the CPU (same memory, slower compute)." },
        );
      } else {
        segs.push({ key: "cw", cls: "weights offload", bytes: pl.cpuWeights, label: "Weights (CPU)", tip: "Runs on the CPU from system RAM." });
      }
      segs.push(
        { key: "kv", cls: "kv", bytes: pl.gpuKv + pl.cpuKv, label: "KV", tip: "KV cache." },
        { key: "buf", cls: "runtime", bytes: pl.gpuOther, label: "Buffers", tip: "Scratch and image activations." },
        { key: "host", cls: "host", bytes: pl.hostOther, label: "Host", tip: "Runner process." },
      );
    }
    const used = segs.reduce((a, s) => a + s.bytes, 0);
    // The working-set limit only matters if it falls inside physical memory after other apps.
    const limitBinding = isUnified && p.unifiedGpuLimit != null ? reserve + p.unifiedGpuLimit < ramCap : null;
    lanes = (
      <Lane
        title={isUnified ? "Unified memory" : "System RAM"}
        sub={`${fmtBytes(p.ramPhysical)} total · one shared pool${isUnified ? " (CPU + GPU)" : ""}${limitBinding === false ? ` · GPU limit ${fmtBytes(p.unifiedGpuLimit)} not reached: free memory runs out first` : ""}`}
        capacity={p.ramPhysical}
        scale={scale}
        segs={segs}
        big
      >
        {isUnified && p.unifiedGpuLimit != null && limitBinding && (
          <div className="limit-mark" style={{ left: pct(reserve + p.unifiedGpuLimit, scale) }} title="GPU working-set limit, measured from the start of model allocations">
            <span>GPU limit {fmtBytes(p.unifiedGpuLimit)}</span>
          </div>
        )}
        {used > ramCap * 1.001 && ramCap > 0 && (
          <div className={markClass(ramCap, scale)} style={{ left: pct(ramCap, scale) }}>
            <span>Over capacity</span>
          </div>
        )}
      </Lane>
    );
  }

  return (
    <div className="memviz" aria-label="Memory placement visualization">
      <Lane title="This model needs" sub={est.totalNeed ? `≈ ${fmtBytes(est.totalNeed.mid)} in total` : "Size unknown"} capacity={null} scale={scale} segs={needSegs} big>
        {showActive && active != null && !unknownSize && (
          <div
            className="active-overlay"
            style={{ left: 4, width: `calc(${pct(Math.min(active, textW), scale)} - 4px)` }}
            role="img"
            aria-label={`Active per token about ${fmtBytes(active)}. Compute footprint, changes every token, not a placement.`}
          >
            <span>
              Active per token ≈ {fmtBytes(active)}
              <span className="ao-more"> · changes every token</span>
            </span>
          </div>
        )}
      </Lane>
      {lanes}
      <div className="axis" aria-hidden>
        {ticks.map((t) => (
          <span key={t} style={{ left: pct(t, scale) }} className="num">
            {Math.round(t / GiB)}
          </span>
        ))}
        <span style={{ left: "100%", transform: "translateX(-100%)" }}>GiB</span>
      </div>
      <div className="legend">
        <span>
          <i style={{ background: "var(--seg-weights)" }} />
          Weights
        </span>
        <span>
          <i style={{ background: "repeating-linear-gradient(135deg, var(--seg-weights) 0 3px, transparent 3px 6px)" }} />
          Planned offload
        </span>
        <span>
          <i style={{ background: "var(--seg-vision)" }} />
          Vision encoder
        </span>
        <span>
          <i style={{ background: "var(--seg-kv)" }} />
          KV cache
        </span>
        <span>
          <i style={{ background: "var(--seg-runtime)" }} />
          Runtime buffers
        </span>
        <span>
          <i style={{ background: "var(--seg-host)" }} />
          Host process
        </span>
        <span>
          <i style={{ background: "repeating-linear-gradient(135deg, var(--seg-reserve) 0 3px, transparent 3px 6px)", border: "1px solid var(--border)" }} />
          In use / reserved
        </span>
        {showActive && active != null && (
          <span>
            <i style={{ border: "2px solid var(--seg-active)" }} />
            Active per token (compute, not placement)
          </span>
        )}
      </div>
    </div>
  );
}
