import { useEffect } from "react";
import { create } from "zustand";
import { CheckCircle2, Download, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { isTauri } from "../platform/bridge";
import { useStore } from "../state/store";
import { fmtBytes } from "../lib/units";
import { Modal } from "./ui";

// Signed auto-updates from GitHub Releases (Tauri updater plugin). Desktop only.
// Flow: check on launch (if enabled) → themed dialog → download with progress → install → restart.

type Phase = "idle" | "checking" | "available" | "downloading" | "installing" | "restarting" | "uptodate" | "error";

interface UpdateHandle {
  version: string;
  body?: string;
  date?: string;
  downloadAndInstall: (cb: (e: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void) => Promise<void>;
}

interface UpdaterState {
  phase: Phase;
  current: string | null;
  update: UpdateHandle | null;
  done: number;
  total: number | null;
  error: string | null;
  open: boolean;
  set(p: Partial<UpdaterState>): void;
}

export const useUpdater = create<UpdaterState>((set) => ({
  phase: "idle",
  current: null,
  update: null,
  done: 0,
  total: null,
  error: null,
  open: false,
  set: (p) => set(p),
}));

if (import.meta.env.DEV && typeof window !== "undefined") (window as unknown as { __updater: typeof useUpdater }).__updater = useUpdater;

export async function checkForUpdates(manual: boolean) {
  if (!isTauri()) return;
  const u = useUpdater.getState();
  if (u.phase === "checking" || u.phase === "downloading" || u.phase === "installing") return;
  u.set({ phase: "checking", error: null, open: manual });
  try {
    const [{ check }, { getVersion }] = await Promise.all([import("@tauri-apps/plugin-updater"), import("@tauri-apps/api/app")]);
    const current = await getVersion();
    const update = (await check()) as UpdateHandle | null;
    if (update) u.set({ phase: "available", update, current, open: true });
    else u.set({ phase: "uptodate", current, open: manual });
  } catch (e) {
    u.set({ phase: "error", error: String((e as Error)?.message ?? e), open: manual });
  }
}

async function install() {
  const u = useUpdater.getState();
  if (!u.update) return;
  u.set({ phase: "downloading", done: 0, total: null });
  try {
    await u.update.downloadAndInstall((ev) => {
      if (ev.event === "Started") useUpdater.getState().set({ total: ev.data?.contentLength ?? null });
      else if (ev.event === "Progress") useUpdater.getState().set({ done: useUpdater.getState().done + (ev.data?.chunkLength ?? 0) });
      else if (ev.event === "Finished") useUpdater.getState().set({ phase: "installing" });
    });
    useUpdater.getState().set({ phase: "restarting" });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    useUpdater.getState().set({ phase: "error", error: String((e as Error)?.message ?? e) });
  }
}

/** Mount once: checks on launch when enabled and renders the update dialog. */
export function UpdateDialog() {
  const autoUpdate = useStore((s) => s.autoUpdate);
  const u = useUpdater();
  useEffect(() => {
    if (autoUpdate) {
      const t = setTimeout(() => void checkForUpdates(false), 2500);
      return () => clearTimeout(t);
    }
  }, [autoUpdate]);
  if (!u.open) return null;
  const busy = u.phase === "downloading" || u.phase === "installing" || u.phase === "restarting";
  const pct = u.total ? Math.min(100, (u.done / u.total) * 100) : u.phase === "downloading" ? 8 : 100;
  const close = () => !busy && u.set({ open: false });

  return (
    <Modal title={u.phase === "uptodate" ? "You're up to date" : u.phase === "error" ? "Update check failed" : u.phase === "checking" ? "Checking for updates…" : "Update available"} onClose={close}>
      <div className="stack update-dialog" style={{ gap: 16 }}>
        {u.phase === "checking" && (
          <div className="row muted">
            <RefreshCw size={18} className="spin" /> Looking for a newer version on GitHub…
          </div>
        )}
        {u.phase === "uptodate" && (
          <div className="row" style={{ gap: 12 }}>
            <CheckCircle2 size={28} color="var(--good)" />
            <span style={{ fontSize: 16 }}>
              Model Fit Explorer <b>{u.current}</b> is the latest version.
            </span>
          </div>
        )}
        {u.phase === "error" && (
          <div className="warning warn">
            <TriangleAlert size={18} />
            <span>{u.error}. You can try again later; the app keeps working normally.</span>
          </div>
        )}
        {u.update && (u.phase === "available" || busy) && (
          <>
            <div className="row" style={{ gap: 14 }}>
              <div className="update-icon">
                <Sparkles size={24} />
              </div>
              <div>
                <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.02em" }}>Version {u.update.version} is ready</div>
                <div className="muted" style={{ fontSize: 14.5 }}>
                  You have {u.current}. {u.update.date ? `Released ${new Date(u.update.date).toLocaleDateString()}.` : ""}
                </div>
              </div>
            </div>
            {u.update.body && <ReleaseNotes text={u.update.body} />}
            {busy && (
              <div className="stack" style={{ gap: 8 }}>
                <div className="progress big" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
                  <div style={{ width: `${pct}%` }} />
                </div>
                <div className="row muted" style={{ justifyContent: "space-between", fontSize: 14 }}>
                  <span>{u.phase === "downloading" ? "Downloading…" : u.phase === "installing" ? "Installing…" : "Restarting…"}</span>
                  <span className="num">{u.total ? `${fmtBytes(u.done, "GB")} of ${fmtBytes(u.total, "GB")} · ${Math.round(pct)}%` : u.done ? fmtBytes(u.done, "GB") : ""}</span>
                </div>
              </div>
            )}
            {!busy && (
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn ghost" onClick={close}>
                  Later
                </button>
                <button className="btn primary" onClick={() => void install()}>
                  <Download size={16} /> Update now
                </button>
              </div>
            )}
          </>
        )}
        {(u.phase === "uptodate" || u.phase === "error") && (
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn primary" onClick={close}>
              OK
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Turns release notes into a clean "What's new" list (no raw markdown, no download tables). */
export function parseReleaseNotes(text: string): string[] {
  const main = text.split(/\n#{1,3}\s*(Which file|What are the other files)/i)[0];
  return main
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^([-*•])\s+/.test(l))
    .map((l) => l.replace(/^([-*•])\s+/, "").replace(/\*\*|`/g, "").trim())
    .filter(Boolean)
    .slice(0, 8);
}

function ReleaseNotes({ text }: { text: string }) {
  const items = parseReleaseNotes(text);
  if (!items.length) return null;
  return (
    <div className="whats-new">
      <div className="eyebrow">What's new</div>
      <ul>
        {items.map((it, i) => (
          <li key={i} style={{ animationDelay: `${i * 50}ms` }}>
            <CheckCircle2 size={17} />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
