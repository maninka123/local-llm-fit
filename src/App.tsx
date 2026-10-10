import { useEffect, useMemo } from "react";
import { Boxes, Gauge, LayoutGrid, Columns3, Settings2 } from "lucide-react";
import { useStore, type Page } from "./state/store";
import { MachineBar } from "./components/MachineBar";
import { Playground } from "./screens/Playground";
import { RunPage } from "./screens/RunPage";
import { TryModelModal } from "./components/TryModel";
import { UpdateDialog } from "./components/Updater";
import { ThemeSwitch } from "./components/ThemeSwitch";
import { Explorer } from "./screens/Explorer";
import { ModelDetail } from "./screens/ModelDetail";
import { Compare } from "./screens/Compare";
import { Settings } from "./screens/Settings";
import { MachineSetupModal } from "./components/MachineSetup";

const NAV: { page: Page; label: string; icon: React.ReactNode }[] = [
  { page: "overview", label: "Playground", icon: <Boxes size={18} /> },
  { page: "run", label: "What can I run", icon: <Gauge size={18} /> },
  { page: "explore", label: "Model Explorer", icon: <LayoutGrid size={18} /> },
  { page: "compare", label: "Compare", icon: <Columns3 size={18} /> },
  { page: "settings", label: "Settings & Diagnostics", icon: <Settings2 size={18} /> },
];

export function App() {
  const route = useStore((s) => s.route);
  const navigate = useStore((s) => s.navigate);
  const theme = useStore((s) => s.theme);
  const motion = useStore((s) => s.motion);
  const compare = useStore((s) => s.compare);
  const toast = useStore((s) => s.toast);

  useEffect(() => {
    const s = useStore.getState();
    void s.rescanHardware();
    void s.rebuildCatalog().then(() => s.refreshOllama());
  }, []);

  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme = theme === "system" ? (mq.matches ? "dark" : "light") : theme;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  const systemReduce = useMemo(() => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  useEffect(() => {
    const reduce = motion === "reduce" || (motion === "system" && systemReduce);
    document.documentElement.classList.toggle("reduce-motion", reduce);
  }, [motion, systemReduce]);

  const active: Page = route.page === "model" ? "explore" : route.page;

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="app">
        <nav className="sidebar" aria-label="Main">
          <div className="brand">
            <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" />
            <div>
              <b>Model Fit Explorer</b>
              <span>Local AI on your machine</span>
            </div>
          </div>
          {NAV.map((n) => (
            <button key={n.page} className="nav-item" aria-current={active === n.page ? "page" : undefined} onClick={() => navigate({ page: n.page })}>
              {n.icon}
              <span>{n.label}</span>
              {n.page === "compare" && compare.length > 0 && <span className="count num">{compare.length}</span>}
            </button>
          ))}
          <div className="sidebar-foot">
            <ThemeSwitch />
            <p className="faint hide-narrow" style={{ fontSize: 13, margin: 0 }}>
              Estimates, not guarantees. Nothing leaves your computer unless you search online.
            </p>
          </div>
        </nav>
        <div className="main">
          <MachineBar />
          <main id="main" className="page page-anim" key={route.page + (route.modelId ?? "")} tabIndex={-1}>
            {route.page === "overview" && <Playground />}
            {route.page === "run" && <RunPage />}
            {route.page === "explore" && <Explorer />}
            {route.page === "model" && <ModelDetail id={route.modelId ?? ""} />}
            {route.page === "compare" && <Compare />}
            {route.page === "settings" && <Settings />}
          </main>
        </div>
      </div>
      <MachineSetupModal />
      <TryModelModal />
      <UpdateDialog />
      {toast && (
        <div className={`toast`} role="status" aria-live="polite" style={{ color: toast.tone === "good" ? "var(--good)" : toast.tone === "warn" ? "var(--warn)" : toast.tone === "bad" ? "var(--bad)" : undefined }}>
          {toast.text}
        </div>
      )}
    </>
  );
}
