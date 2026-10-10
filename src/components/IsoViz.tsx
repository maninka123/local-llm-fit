import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, XCircle, Zap } from "lucide-react";
import { useStore } from "../state/store";
import type { Estimate, MachineProfile } from "../domain/estimator";
import { fmtBytes, GiB } from "../lib/units";

// Isometric "memory blocks" view. One block = one fixed chunk of memory (the unit is
// chosen so everything fits on screen). The model is a cube of blocks; memory pools are
// glass containers. Placement follows the estimator's planned placement (a simulation).

type Kind = "w" | "wo" | "v" | "kv" | "rt" | "host" | "res" | "over" | "evict";
interface Block {
  key: string;
  kind: Kind;
  x: number;
  y: number;
  z: number;
  active?: boolean;
}

const U = 16; // px per block edge (same for every shape, so sizes are comparable)
const C = 0.866;
const iso = (x: number, y: number, z: number): [number, number] => [(x - y) * U * C, (x + y) * U * 0.5 - z * U];
const pts = (ps: [number, number][]) => ps.map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" ");

// unit cube faces in local coordinates
const TOP = pts([iso(0, 0, 1), iso(1, 0, 1), iso(1, 1, 1), iso(0, 1, 1)]);
const LEFT = pts([iso(0, 1, 0), iso(1, 1, 0), iso(1, 1, 1), iso(0, 1, 1)]);
const RIGHT = pts([iso(1, 0, 0), iso(1, 1, 0), iso(1, 1, 1), iso(1, 0, 1)]);

function chooseUnit(maxBytes: number): number {
  for (const u of [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64]) if (maxBytes / (u * GiB) <= 110) return u * GiB;
  return 128 * GiB;
}

function stack(counts: [Kind, number][], side: number, startIndex = 0, keyPrefix = ""): Block[] {
  const out: Block[] = [];
  let i = startIndex;
  for (const [kind, n] of counts) {
    for (let k = 0; k < n; k++, i++) {
      const z = Math.floor(i / (side * side));
      const r = i % (side * side);
      out.push({ key: `${keyPrefix}${kind}-${k}`, kind, x: r % side, y: Math.floor(r / side), z });
    }
  }
  return out;
}

function Voxel({ b, glow }: { b: Block; glow?: boolean | "fast" | "slow" }) {
  const [ox, oy] = iso(b.x, b.y, b.z);
  return (
    <g className={`vox k-${b.kind} ${glow === "slow" ? "lit-slow" : glow ? "lit" : ""}`} style={{ transform: `translate(${ox}px, ${oy}px)` }}>
      <polygon className="f-l" points={LEFT} />
      <polygon className="f-r" points={RIGHT} />
      <polygon className="f-t" points={TOP} />
    </g>
  );
}

function sortBlocks(bs: Block[]) {
  return [...bs].sort((a, b) => a.z - b.z || a.x + a.y - (b.x + b.y));
}

function Container({ side, levels, blocks, limitLevel, label, lit }: { side: number; levels: number; blocks: Block[]; limitLevel?: number | null; label: string; lit?: Map<string, "fast" | "slow"> }) {
  const h = Math.max(levels, 1);
  const top = (z: number) => pts([iso(0, 0, z), iso(side, 0, z), iso(side, side, z), iso(0, side, z)]);
  const [minX] = iso(0, side, 0);
  const [maxX] = iso(side, 0, 0);
  const overTop = Math.max(0, ...blocks.map((b) => b.z + 1)) ;
  const [, minY] = iso(0, 0, Math.max(h, overTop) + 0.6);
  const [, maxY] = iso(side, side, 0);
  const pad = 10;
  return (
    <svg
      className="iso"
      viewBox={`${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`}
      role="img"
      aria-label={label}
      style={{ width: `calc(${(maxX - minX + pad * 2).toFixed(0)}px * var(--iso-s, 1))`, height: "auto", flex: "none" }}
    >
      {/* floor + back walls (glass) */}
      <polygon className="glass-floor" points={top(0)} />
      <polygon className="glass-wall" points={pts([iso(0, 0, 0), iso(side, 0, 0), iso(side, 0, h), iso(0, 0, h)])} />
      <polygon className="glass-wall" points={pts([iso(0, 0, 0), iso(0, side, 0), iso(0, side, h), iso(0, 0, h)])} />
      {sortBlocks(blocks).map((b) => (
        <Voxel key={b.key} b={b} glow={lit?.get(b.key)} />
      ))}
      {/* front edges */}
      <polyline className="glass-edge" points={pts([iso(0, side, 0), iso(side, side, 0), iso(side, 0, 0)])} />
      <polyline className="glass-edge" points={pts([iso(0, side, 0), iso(0, side, h)])} />
      <polyline className="glass-edge" points={pts([iso(side, side, 0), iso(side, side, h)])} />
      <polyline className="glass-edge" points={pts([iso(side, 0, 0), iso(side, 0, h)])} />
      <polygon className="glass-rim" points={top(h)} />
      {limitLevel != null && limitLevel < h && <polygon className="limit-plane" points={top(limitLevel)} />}
    </svg>
  );
}

function ModelCube({ blocks, activeKeys, label }: { blocks: Block[]; activeKeys: Set<string>; label: string }) {
  const side = Math.max(1, ...blocks.map((b) => Math.max(b.x, b.y) + 1));
  const levels = Math.max(1, ...blocks.map((b) => b.z + 1));
  const [minX] = iso(0, side, 0);
  const [maxX] = iso(side, 0, 0);
  const [, minY] = iso(0, 0, levels);
  const [, maxY] = iso(side, side, 0);
  const pad = 10;
  return (
    <svg className="iso" viewBox={`${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`} role="img" aria-label={label} style={{ width: `calc(${(maxX - minX + pad * 2).toFixed(0)}px * var(--iso-s, 1))`, height: "auto", flex: "none" }}>
      {sortBlocks(blocks).map((b) => (
        <Voxel key={b.key} b={b} glow={activeKeys.has(b.key)} />
      ))}
    </svg>
  );
}

function pickActive(keys: string[], n: number): Set<string> {
  if (n >= keys.length) return new Set(keys);
  const s = new Set<string>();
  while (s.size < n) s.add(keys[Math.floor(Math.random() * keys.length)]);
  return s;
}

export function IsoViz({ est, machine }: { est: Estimate; machine: MachineProfile }) {
  const p = est.pools;
  const pl = est.placement;
  const unifiedLike = p.arch !== "discrete" || machine.gpuBackendSupported === false;
  const constrained = est.classification === "memory_constrained";
  const tooBig = est.classification === "cannot_fit";
  const isUnified = p.arch === "unified";
  const W = est.weights?.mid ?? 0;
  const vision = est.visionEncoder?.mid ?? 0;
  const KV = est.kv.mid;
  const buf = est.scratch.mid + est.visionActivations.mid + est.backend.mid;
  const host = est.hostRuntime.mid;

  const unit = chooseUnit(Math.max(W + KV + buf + host, p.vramPhysical ?? 0, p.ramPhysical ?? 0));
  const n = (b: number) => (b > 0 ? Math.max(1, Math.round(b / unit)) : 0);

  // ---- model cube (weights only: the "model")
  const modelBlocksCount = n(W - vision) + n(vision);
  const cubeSide = Math.max(2, Math.ceil(Math.cbrt(modelBlocksCount)));
  const modelBlocks = stack(
    [
      ["w", n(W - vision)],
      ["v", n(vision)],
    ],
    cubeSide,
  );
  const weightKeys = modelBlocks.filter((b) => b.kind === "w").map((b) => b.key);
  const activeN = est.active ? Math.min(weightKeys.length, Math.max(1, Math.round(est.active.mid / unit))) : 0;
  const dense = !est.isMoE;

  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!est.isMoE || document.documentElement.classList.contains("reduce-motion")) return;
    const t = setInterval(() => setTick((x) => x + 1), 1400);
    return () => clearInterval(t);
  }, [est.isMoE]);
  const activeKeys = useMemo(() => (dense ? new Set<string>() : pickActive(weightKeys, activeN)), [dense, weightKeys.join(), activeN, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- containers
  const containers: { title: string; sub: string; side: number; levels: number; blocks: Block[]; limitLevel?: number | null; overflow?: number }[] = [];
  const box = (capBytes: number) => {
    const cap = Math.max(1, Math.round(capBytes / unit));
    const side = Math.min(7, Math.max(3, Math.ceil(Math.sqrt(cap / 3))));
    return { cap, side, levels: Math.ceil(cap / (side * side)) };
  };
  // Parts are given in BYTES; convert to blocks so rounding never invents an overflow:
  // only bytes beyond the real capacity become red "doesn't fit" blocks.
  let lastOverflow = 0;
  const fill = (capBytes: number, capBlocks: number, side: number, partsBytes: [Kind, number][], prefix: string) => {
    lastOverflow = 0;
    const rawTotal = partsBytes.reduce((a, [, b]) => a + b, 0);
    // Ignore rounding-level overflow (planned placement fills VRAM exactly to its edge).
    const real = rawTotal - capBytes > Math.max(unit * 0.5, 64 * 1024 * 1024);
    const totalBytes = real ? rawTotal : Math.min(rawTotal, capBytes);
    const counts: [Kind, number][] = partsBytes.map(([k, b]) => [k, n(b)]);
    let sum = counts.reduce((a, [, c]) => a + c, 0);
    const limit = totalBytes <= capBytes ? capBlocks : Math.max(capBlocks, Math.round(totalBytes / unit));
    while (sum > limit) {
      const big = counts.reduce((m, c, i) => (c[1] > counts[m][1] ? i : m), 0);
      counts[big][1]--;
      sum--;
    }
    let blocks = stack(counts, side, 0, prefix);
    if (totalBytes > capBytes) {
      for (const b of blocks.slice(capBlocks)) b.kind = constrained && b.kind === "res" ? "evict" : "over";
      // Show a short spill of red blocks, not a tower: the exact amount goes in the caption.
      const maxOver = side * side * 2;
      const overBlocks = blocks.length - capBlocks;
      if (overBlocks > maxOver) blocks = blocks.slice(0, capBlocks + maxOver);
      lastOverflow = totalBytes - capBytes;
    }
    return blocks;
  };

  if (!unifiedLike && p.vramPhysical != null) {
    const v = box(p.vramPhysical);
    const reserve = Math.max(0, p.vramPhysical - (p.vramUsable ?? p.vramPhysical));
    containers.push({
      title: "GPU memory (VRAM)",
      sub: `${fmtBytes(p.vramPhysical)} · fastest`,
      side: v.side,
      levels: v.levels,
      blocks: fill(p.vramPhysical, v.cap, v.side, [["res", reserve], ["w", pl?.gpuWeights ?? 0], ["kv", pl?.gpuKv ?? 0], ["rt", pl?.gpuOther ?? 0]], "v"),
      overflow: lastOverflow,
    });
  }
  if (p.ramPhysical != null) {
    const r = box(p.ramPhysical);
    const reserve = Math.max(0, p.ramPhysical - (p.ramUsable ?? p.ramPhysical));
    const partsRaw: [Kind, number][] = unifiedLike
      ? [["res", reserve], ["w", isUnified ? (pl?.gpuWeights ?? 0) : 0], ["wo", isUnified ? (pl?.cpuWeights ?? 0) : (pl?.cpuWeights ?? W)], ["kv", (pl?.gpuKv ?? 0) + (pl?.cpuKv ?? 0)], ["rt", pl?.gpuOther ?? 0], ["host", pl?.hostOther ?? host]]
      : [["res", reserve], ["wo", pl?.cpuWeights ?? 0], ["kv", pl?.cpuKv ?? 0], ["host", pl?.hostOther ?? host]];
    // Tight fit: draw the model inside the box and let the apps' memory be what spills out.
    const parts: [Kind, number][] = constrained ? [...partsRaw.filter(([k]) => k !== "res"), ...partsRaw.filter(([k]) => k === "res")] : partsRaw;
    const limitLevel = isUnified && p.unifiedGpuLimit != null ? (n(reserve) + n(p.unifiedGpuLimit)) / (r.side * r.side) : null;
    containers.push({
      title: isUnified ? "Unified memory" : "System RAM",
      sub: isUnified ? `${fmtBytes(p.ramPhysical)} · shared by CPU and GPU` : `${fmtBytes(p.ramPhysical)} · used for offload`,
      side: r.side,
      levels: r.levels,
      blocks: fill(p.ramPhysical, r.cap, r.side, parts, "r"),
      overflow: lastOverflow,
      limitLevel,
    });
  }

  const offload = pl ? pl.cpuWeights : 0;

  // Where each word's active work happens: GPU-resident vs RAM-resident weight blocks.
  const gpuShare = unifiedLike && !isUnified ? 0 : (pl?.gpuFraction ?? 1);
  const fastKeys = containers.flatMap((c) => c.blocks.filter((b) => b.kind === "w").map((b) => b.key));
  const slowKeys = containers.flatMap((c) => c.blocks.filter((b) => b.kind === "wo").map((b) => b.key));
  const containerLit = useMemo(() => {
    const map = new Map<string, "fast" | "slow">();
    if (dense || !est.active || activeN === 0 || tooBig) return map;
    let kFast = Math.min(fastKeys.length, Math.round(activeN * gpuShare));
    let kSlow = Math.min(slowKeys.length, activeN - kFast);
    if (gpuShare < 0.999 && slowKeys.length && kSlow === 0) {
      kSlow = 1;
      kFast = Math.max(0, kFast - 1);
    }
    for (const k of pickActive(fastKeys, kFast)) map.set(k, "fast");
    for (const k of pickActive(slowKeys, kSlow)) map.set(k, "slow");
    return map;
  }, [dense, est.active, activeN, gpuShare, fastKeys.join(), slowKeys.join(), tick, tooBig]); // eslint-disable-line react-hooks/exhaustive-deps

  const timeGpu = est.speed?.gpuTimeShare ?? null;
  const gpuLed = timeGpu != null ? timeGpu >= 0.5 : gpuShare >= 0.7;
  const status =
    gpuShare >= 0.999
      ? { text: "All on GPU", tone: "var(--good)" }
      : gpuShare <= 0.001
        ? { text: "All on CPU", tone: "var(--orange)" }
        : gpuLed
          ? { text: "Mostly GPU", tone: "var(--good)" }
          : { text: "CPU slows it down", tone: "var(--orange)" };
  const runnable = est.classification !== "cannot_fit" && est.classification !== "unknown";
  const need = est.totalNeed?.mid ?? 0;
  const machineTotal = (p.arch === "discrete" ? (p.vramPhysical ?? 0) : 0) + (p.ramPhysical ?? 0);
  const freeNeeded = containers.reduce((a, c) => a + (c.overflow ?? 0), 0);

  // Fit everything on one row: measure the space and scale all drawings by the same factor.
  const ref = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setAvail(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const drawW = (side: number) => 2 * side * U * C + 20;
  const COL_MIN = 190; // captions wrap within this width (see .iso-col max-width)
  const ARROW = 72;
  const natural =
    Math.max(drawW(cubeSide), COL_MIN) + containers.reduce((a, c) => a + Math.max(drawW(c.side), COL_MIN), 0) + ARROW * containers.length + 8 * containers.length * 2 + 8;
  const estimateScale = avail > 0 ? Math.max(0.4, Math.min(1, avail / natural)) : 1;
  // Correct the estimate against the real layout: shrink until nothing overflows.
  const rowRef = useRef<HTMLDivElement>(null);
  const [correction, setCorrection] = useState(1);
  useEffect(() => setCorrection(1), [estimateScale, natural]);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    if (row.scrollWidth > row.clientWidth + 1 && estimateScale * correction > 0.4) {
      setCorrection((c) => Math.max(0.4 / estimateScale, c * (row.clientWidth / row.scrollWidth) * 0.97));
    }
  });
  const scale = Math.max(0.4, estimateScale * correction);
  const overflow = containers.some((c) => c.blocks.some((b) => b.kind === "over"));

  return (
    <div className="isoviz" ref={ref}>
      <div
        className="iso-row"
        ref={rowRef}
        style={{ ["--iso-s" as string]: scale.toFixed(3), gridTemplateColumns: ["auto", ...containers.flatMap(() => ["minmax(48px, 1fr)", "auto"])].join(" ") }}
      >
        <div className="iso-col model">
          <div className="iso-title">The model</div>
          <ModelCube blocks={modelBlocks} activeKeys={activeKeys} label={`Model weights ${fmtBytes(W)}`} />
          <div className="iso-sub num">
            <b>{fmtBytes(W)}</b> of weights
            {est.active && !dense && (
              <>
                {" "}
                · <span style={{ color: "var(--seg-active)", fontWeight: 650 }}>{fmtBytes(est.active.mid)} active per word</span>
              </>
            )}
          </div>
          <div className="iso-hint">{dense ? "Dense: every block works on every word." : est.active ? "Glowing = experts working on this word." : "Active size unknown."}</div>
        </div>
        <div className="iso-arrow" aria-hidden>
          <span className="flow-dots">
            <i />
            <i />
            <i />
          </span>
          <span>loads into</span>
        </div>
        {containers.map((c, i) => (
          <Fragment key={c.title}>
            {i > 0 && (
              <div className={`iso-arrow ${tooBig ? "idle" : offload > 0 ? "offload" : "idle"}`} aria-hidden>
                {tooBig ? (
                  <span>too big</span>
                ) : offload > 0 ? (
                  <>
                    <span className="flow-dots both">
                      <i />
                      <i />
                      <i />
                    </span>
                    <span>offload {fmtBytes(offload)}</span>
                  </>
                ) : (
                  <span>no offload</span>
                )}
              </div>
            )}
            <div className="iso-col">
              <div className="iso-title">{c.title}</div>
              <Container side={c.side} levels={c.levels} blocks={c.blocks} limitLevel={c.limitLevel} label={`${c.title}: ${c.sub}`} lit={containerLit} />
              <div className="iso-sub">
                {c.sub}
              </div>
            </div>
          </Fragment>
        ))}
      </div>
      {tooBig && (
        <div className="work-row">
          <span className="work-pill" style={{ ["--tone" as string]: "var(--bad)" }}>
            <XCircle size={14} /> Needs {fmtBytes(need, "GiB", 0)} · has {fmtBytes(machineTotal, "GiB", 0)}
          </span>
        </div>
      )}
      {constrained && freeNeeded > 0 && (
        <div className="work-row">
          <span className="work-pill" style={{ ["--tone" as string]: "var(--orange)" }}>
            <AlertTriangle size={14} /> {p.ramFree != null ? `Close apps · free ${fmtBytes(freeNeeded)}` : `${fmtBytes(freeNeeded)} over the safe limit`}
          </span>
          {p.ramFree != null && (
            <button className="btn sm" onClick={() => useStore.getState().setSettings({ memoryBasis: "planning" })}>
              Try with apps closed
            </button>
          )}
        </div>
      )}
      {est.placement && runnable && !constrained && (
        <div className="work-row">
          <span className="work-pill" style={{ ["--tone" as string]: status.tone }}>
            <Zap size={14} /> {status.text}
          </span>
          {gpuShare > 0.001 && gpuShare < 0.999 && (
            <div className="work-bars">
              <WorkBar label="Data" gpu={gpuShare} />
              {timeGpu != null && <WorkBar label="Time" gpu={timeGpu} />}
            </div>
          )}
        </div>
      )}
      <div className="legend iso-legend">
        <span>
          <i className="sw k-w" /> Weights
        </span>
        <span>
          <i className="sw k-wo" /> Offloaded weights (CPU)
        </span>
        {vision > 0 && (
          <span>
            <i className="sw k-v" /> Vision encoder
          </span>
        )}
        <span>
          <i className="sw k-kv" /> KV cache
        </span>
        <span>
          <i className="sw k-rt" /> Buffers
        </span>
        <span>
          <i className="sw k-res" /> In use / reserved
        </span>
        {overflow && (
          <span>
            <i className="sw k-over" /> Doesn't fit
          </span>
        )}
        {!dense && est.active && (
          <span>
            <i className="sw lit-sw" /> Active per word
          </span>
        )}
        {containers.some((c) => c.blocks.some((b) => b.kind === "evict")) && (
          <span>
            <i className="sw k-evict" /> Memory to free
          </span>
        )}
        {[...containerLit.values()].includes("slow") && (
          <span>
            <i className="sw lit-slow-sw" /> Active (RAM)
          </span>
        )}
        <span className="faint">1 block ≈ {fmtBytes(unit)} · planned placement, not measured</span>
      </div>
    </div>
  );
}

function WorkBar({ label, gpu }: { label: string; gpu: number }) {
  const g = Math.round(gpu * 100);
  return (
    <div className="work-bar" data-tip={`${label} per word: ${g}% GPU · ${100 - g}% CPU`}>
      <span className="work-label">{label}</span>
      <span className="work-track">
        <span className="work-gpu" style={{ width: `${g}%` }}>{g >= 18 ? `GPU ${g}%` : ""}</span>
        <span className="work-cpu" style={{ width: `${100 - g}%` }}>{100 - g >= 18 ? `CPU ${100 - g}%` : ""}</span>
      </span>
    </div>
  );
}
