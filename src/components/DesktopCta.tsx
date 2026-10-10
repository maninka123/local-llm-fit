import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, Download, Gauge, RefreshCw, ScanSearch } from "lucide-react";
import { useStore } from "../state/store";
import { Modal } from "./ui";

// Web only: invites the visitor to the desktop app, which reads the hardware exactly.
const REPO = "maninka123/local-llm-fit";
const LATEST = `https://github.com/${REPO}/releases/latest`;

type Target = { label: string; asset: RegExp };

function targetFor(os: string | undefined, arch: string | undefined, renderer: string | null | undefined): Target | null {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const name = os ?? (/Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) && !/Android/.test(ua) ? "Linux" : "");
  if (name === "Windows") return { label: "Windows", asset: /_x64-setup\.exe$/ };
  if (name === "Linux") {
    // Raspberry Pi, Jetson and other ARM boards need the ARM build.
    const arm = arch === "arm" || /aarch64|arm64|armv8/i.test(ua);
    return arm ? { label: "Linux (ARM)", asset: /_aarch64\.AppImage$/ } : { label: "Linux", asset: /_amd64\.AppImage$/ };
  }
  if (name === "macOS") {
    // Browsers report every Mac as Intel; the GPU name tells Apple Silicon from Intel.
    const intel = /intel|amd|radeon/i.test(renderer ?? "") || arch === "x86";
    return intel ? { label: "Mac (Intel)", asset: /_x64\.dmg$/ } : { label: "Mac (Apple Silicon)", asset: /_aarch64\.dmg$/ };
  }
  return null;
}

export function DesktopCta() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn sm desktop-cta" onClick={() => setOpen(true)} data-tip="Detects your hardware automatically" data-tip-pos="below" data-tip-align="end">
        <Download size={15} /> <span>Get the desktop app</span>
      </button>
      {/* Rendered at page level: the sticky machine bar would otherwise trap the overlay. */}
      {open && createPortal(<DesktopCtaDialog onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function DesktopCtaDialog({ onClose }: { onClose: () => void }) {
  const sig = useStore((s) => s.browserSignals);
  const target = targetFor(sig?.os.name, sig?.os.arch, sig?.renderer);
  const [file, setFile] = useState<{ url: string; mb: number } | null>(null);

  // Find the exact installer for this OS in the latest release (public GitHub API, no hardware sent).
  useEffect(() => {
    if (!target) return;
    const ctl = new AbortController();
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((rel: { assets?: { name: string; browser_download_url: string; size?: number }[] } | null) => {
        const a = rel?.assets?.find((x) => target.asset.test(x.name)) as { browser_download_url: string; size?: number } | undefined;
        if (a) setFile({ url: a.browser_download_url, mb: (a.size ?? 0) / 1048576 });
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [target?.label]);

  const perks = [
    { icon: <ScanSearch size={18} />, title: "Knows your hardware instantly", sub: "Reads your exact GPU, video memory and RAM. No questions to answer." },
    { icon: <Activity size={18} />, title: "Live, not guessed", sub: "Sees what's free right now, so “fits” really means fits." },
    { icon: <Gauge size={18} />, title: "Real speed tests", sub: "Measure actual words per second with Ollama on your machine." },
    { icon: <RefreshCw size={18} />, title: "Free and private", sub: "Small download, updates itself, and nothing leaves your computer." },
  ];

  return (
    <Modal title="Get exact answers for your computer" onClose={onClose}>
      <div className="stack" style={{ gap: 16 }}>
        <p className="muted" style={{ margin: 0, fontSize: 15 }}>
          Browsers hide most hardware details, so this website has to estimate. The desktop app detects everything automatically and shows what will really run.
        </p>
        <ul className="cta-perks">
          {perks.map((p) => (
            <li key={p.title}>
              <span className="cta-icon">{p.icon}</span>
              <span>
                <b>{p.title}</b>
                <span className="muted">{p.sub}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
          <a className="btn primary" href={file?.url ?? LATEST} target="_blank" rel="noreferrer">
            <Download size={16} /> {target ? `Download for ${target.label}` : "Download the desktop app"}
            {file && file.mb > 0 && <span className="cta-size">{file.mb < 10 ? file.mb.toFixed(1) : Math.round(file.mb)} MB</span>}
          </a>
          <a className="btn ghost" href={LATEST} target="_blank" rel="noreferrer">
            {target ? "Other systems" : "All downloads"}
          </a>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Windows, Mac, Linux and 64-bit ARM boards. First launch: on Mac right-click the app → Open; on Windows choose More info → Run anyway.
        </p>
      </div>
    </Modal>
  );
}
