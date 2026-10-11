import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { buildCatalog, type FamilyInfo, type Snapshot } from "../catalog/buildCatalog";
import type { ImportReport } from "../catalog/seedImporter";
import type { OllamaVerification } from "../catalog/ollamaOfficial";
import type { InputSelection } from "../domain/capabilities";
import { DEFAULT_SETTINGS, type EstimatorSettings } from "../domain/estimator";
import type { BenchmarkRecord, CapEvidence, HardwareOverrides, HardwareReport, InputCap, ModelVariant, QuantId } from "../domain/types";
import { EMPTY_OVERRIDES } from "../domain/types";
import { addEvidence } from "../domain/capabilities";
import { DEMO_MACHINES } from "../platform/demoHardware";
import { sanitizeBenchmark, sanitizeCapabilityEvidence, sanitizeMap, sanitizeModel, sanitizeVerification } from "../catalog/validate";
import { buildSample, presetConfig, sampleOverrides, type SampleConfig } from "../platform/samples";
import { buildBrowserReport, detectBrowser, suggestSetup, type BrowserSetup, type BrowserSignals } from "../platform/browserDetect";
import { isTauri, ollama, probeHardware } from "../platform/bridge";
import { modelFromInstalled, type OllamaPsModel, type OllamaTagModel } from "../platform/ollamaLocal";
import seedCsv from "../data/ollama_model_catalog_2026-10.csv?raw";

export type Page = "overview" | "run" | "explore" | "model" | "compare" | "settings";
export type Theme = "light" | "dark" | "system";
export type MotionPref = "system" | "reduce" | "full";
/** "AUTO" = the model's default published tag when known, otherwise Q4_K_M. */
export type QuantChoice = QuantId | "AUTO";

export interface Route {
  page: Page;
  modelId?: string;
}

export interface OllamaState {
  status: "unknown" | "checking" | "online" | "offline";
  version?: string;
  installed: OllamaTagModel[];
  running: OllamaPsModel[];
  error?: string;
  checkedAt?: string;
}

interface Persisted {
  overrides: HardwareOverrides;
  settings: EstimatorSettings;
  quantChoice: QuantChoice;
  perModelQuant: Record<string, QuantId>;
  liveVerifications: Record<string, OllamaVerification>;
  userModels: ModelVariant[];
  capabilityEvidence: Record<string, { key: InputCap; ev: CapEvidence }[]>;
  benchmarks: BenchmarkRecord[];
  compare: string[];
  theme: Theme;
  motion: MotionPref;
  inputs: InputSelection;
  verifiedOnly: boolean;
  demoId: string;
  /** The configured sample machine (null: built from demoId). */
  sample: SampleConfig | null;
  /** Web only: estimate from this browser, or show a sample machine. */
  webHardware: "browser" | "demo";
  browserSetup: BrowserSetup | null;
  /** Desktop: check GitHub Releases for signed updates on launch. */
  autoUpdate: boolean;
}

interface State extends Persisted {
  route: Route;
  hardware: HardwareReport | null;
  hardwareStatus: "idle" | "probing" | "ready" | "error";
  hardwareError?: string;
  browserSignals: BrowserSignals | null;
  /** Desktop: last real hardware probe (kept while a sample machine is shown). */
  nativeReport: HardwareReport | null;
  setupOpen: boolean;
  tryOpen: boolean;
  catalog: Map<string, ModelVariant>;
  families: Record<string, FamilyInfo>;
  importReport: ImportReport | null;
  snapshotDate: string | null;
  snapshotStats: { applied: number; added: number };
  ollamaState: OllamaState;
  toast: { id: number; text: string; tone: "info" | "good" | "warn" | "bad" } | null;

  navigate(r: Route): void;
  setOverrides(p: Partial<HardwareOverrides>): void;
  resetOverrides(): void;
  setSettings(p: Partial<EstimatorSettings>): void;
  setQuantChoice(q: QuantChoice): void;
  setModelQuant(id: string, q: QuantId): void;
  rescanHardware(): Promise<void>;
  setDemo(id: string): void;
  setSample(cfg: SampleConfig): void;
  useBrowserHardware(): void;
  saveBrowserSetup(s: BrowserSetup): void;
  setSetupOpen(v: boolean): void;
  setTryOpen(v: boolean): void;
  setAutoUpdate(v: boolean): void;
  rebuildCatalog(): Promise<void>;
  saveVerification(v: OllamaVerification): void;
  addUserModel(m: ModelVariant): void;
  removeUserModel(id: string): void;
  addCapabilityEvidence(modelId: string, key: InputCap, ev: CapEvidence): void;
  refreshOllama(): Promise<void>;
  addBenchmark(b: BenchmarkRecord): void;
  clearBenchmarks(): void;
  toggleCompare(id: string): void;
  setTheme(t: Theme): void;
  setMotion(m: MotionPref): void;
  setInputs(s: InputSelection): void;
  setVerifiedOnly(v: boolean): void;
  showToast(text: string, tone?: "info" | "good" | "warn" | "bad"): void;
}

function routeFromHash(): Route {
  const h = typeof location !== "undefined" ? location.hash.replace(/^#\/?/, "") : "";
  const [page, ...rest] = h.split("/");
  const valid: Page[] = ["overview", "run", "explore", "model", "compare", "settings"];
  if (page === "find") return { page: "run" };
  if (page === "model" && rest.length) {
    // A malformed link (e.g. "%E0") must not stop the app from starting.
    try {
      return { page: "model", modelId: decodeURIComponent(rest.join("/")) };
    } catch {
      return { page: "explore" };
    }
  }
  if (valid.includes(page as Page)) return { page: page as Page };
  return { page: "overview" };
}

const safeStorage = createJSONStorage<Persisted>(() => {
  try {
    const k = "__mfe_probe";
    localStorage.setItem(k, "1");
    localStorage.removeItem(k);
    return localStorage;
  } catch {
    const mem = new Map<string, string>();
    return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) };
  }
});

let snapshotCache: Snapshot | null | undefined;
async function loadSnapshot(): Promise<Snapshot | null> {
  if (snapshotCache !== undefined) return snapshotCache;
  try {
    const mod = await import("../data/verified-snapshot.json");
    snapshotCache = (mod.default ?? mod) as unknown as Snapshot;
  } catch {
    snapshotCache = null;
  }
  return snapshotCache;
}

function applyLocal(models: Map<string, ModelVariant>, s: Pick<State, "ollamaState" | "capabilityEvidence">, details: Map<string, Parameters<typeof modelFromInstalled>[1]>) {
  const now = new Date().toISOString();
  for (const tag of s.ollamaState.installed) {
    const id = tag.name.toLowerCase().replace(/:latest$/, "");
    const key = models.has(tag.name.toLowerCase()) ? tag.name.toLowerCase() : models.has(id) ? id : tag.name.toLowerCase();
    models.set(key, modelFromInstalled(tag, details.get(tag.name) ?? null, models.get(key), now));
  }
  for (const [id, list] of Object.entries(s.capabilityEvidence)) {
    const m = models.get(id);
    if (!m) continue;
    const caps = JSON.parse(JSON.stringify(m.capabilities));
    for (const { key, ev } of list) caps.inputs[key] = addEvidence(caps.inputs[key], ev);
    models.set(id, { ...m, capabilities: caps });
  }
}

const showDetails = new Map<string, Parameters<typeof modelFromInstalled>[1]>();
/** Digest each cached /api/show answer belongs to: a re-pulled model under the same name is re-read. */
const showDigests = new Map<string, string | undefined>();
/** Latest catalog rebuild; an older rebuild that finishes later is discarded. */
let catalogRev = 0;
let toastId = 0;

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      overrides: EMPTY_OVERRIDES,
      // Website: starts on a sample, so "Normal use" (no live readings there). Desktop: "Live" for your computer.
      settings: { ...DEFAULT_SETTINGS, memoryBasis: isTauri() ? "live" : "planning" },
      quantChoice: "AUTO",
      perModelQuant: {},
      liveVerifications: {},
      userModels: [],
      capabilityEvidence: {},
      benchmarks: [],
      compare: [],
      theme: "system",
      motion: "system",
      inputs: { text: true },
      verifiedOnly: false,
      demoId: DEMO_MACHINES[0].id,
      sample: null,
      webHardware: "browser",
      browserSetup: null,
      autoUpdate: true,

      route: routeFromHash(),
      browserSignals: null,
      nativeReport: null,
      setupOpen: false,
      tryOpen: false,
      hardware: null,
      hardwareStatus: "idle",
      catalog: new Map(),
      families: {},
      importReport: null,
      snapshotDate: null,
      snapshotStats: { applied: 0, added: 0 },
      ollamaState: { status: "unknown", installed: [], running: [] },
      toast: null,

      navigate(r) {
        const hash = r.page === "model" && r.modelId ? `#/model/${encodeURIComponent(r.modelId)}` : `#/${r.page}`;
        if (location.hash !== hash) history.pushState(null, "", hash);
        set({ route: r });
        window.scrollTo({ top: 0 });
      },
      setOverrides: (p) => set({ overrides: { ...get().overrides, ...p } }),
      resetOverrides: () => set({ overrides: EMPTY_OVERRIDES }),
      setSettings: (p) => set({ settings: { ...get().settings, ...p } }),
      setQuantChoice: (q) => set({ quantChoice: q }),
      setModelQuant: (id, q) => set({ perModelQuant: { ...get().perModelQuant, [id]: q } }),

      async rescanHardware() {
        set({ hardwareStatus: "probing", hardwareError: undefined });
        try {
          if (get().webHardware === "demo") {
            const cfg = get().sample ?? presetConfig(get().demoId);
            const demo = buildSample(cfg);
            const need = sampleOverrides(cfg);
            if (need.combineGpus && !get().overrides.combineGpus) set({ overrides: { ...get().overrides, ...need } });
            set({ hardware: { ...demo.report, mode: "demo", detectedAt: new Date().toISOString() }, hardwareStatus: "ready" });
            if (isTauri() && !get().nativeReport) void probeHardware().then((r) => r && set({ nativeReport: { ...r, mode: "native" } }));
            return;
          }
          if (!isTauri()) {
            const sig = await detectBrowser();
            const setup = get().browserSetup ?? suggestSetup(sig);
            set({ browserSignals: sig, hardware: buildBrowserReport(sig, setup), hardwareStatus: "ready" });
            return;
          }
          const r = await probeHardware();
          const native = r ? { ...r, mode: "native" as const } : null;
          set({ hardware: native, nativeReport: native, hardwareStatus: "ready" });
        } catch (e) {
          set({ hardwareStatus: "error", hardwareError: String((e as Error).message ?? e) });
        }
      },
      setDemo(id) {
        get().setSample(presetConfig(id));
        set({ demoId: id });
      },
      setSample(cfg) {
        // A sample starts on "Normal use" (its free figures are typical, not measured); Live is still a click away.
        set({ sample: cfg, webHardware: "demo", overrides: { ...EMPTY_OVERRIDES, ...sampleOverrides(cfg) }, settings: { ...get().settings, memoryBasis: "planning" } });
        void get().rescanHardware();
      },
      useBrowserHardware() {
        // Your own computer in the desktop app starts on "Live" (real free-memory readings).
        set({ webHardware: "browser", overrides: EMPTY_OVERRIDES, ...(isTauri() ? { settings: { ...get().settings, memoryBasis: "live" as const } } : {}) });
        void get().rescanHardware();
      },
      saveBrowserSetup(s) {
        set({ browserSetup: s, webHardware: "browser", setupOpen: false, overrides: EMPTY_OVERRIDES });
        void get().rescanHardware();
      },
      setSetupOpen: (v) => set({ setupOpen: v }),
      setTryOpen: (v) => set({ tryOpen: v }),
      setAutoUpdate: (v) => set({ autoUpdate: v }),

      async rebuildCatalog() {
        const rev = ++catalogRev;
        const snap = await loadSnapshot();
        if (rev !== catalogRev) return; // a newer rebuild started meanwhile
        const s = get(); // read state after the await, so nothing newer is overwritten
        const b = buildCatalog(seedCsv, snap, s.liveVerifications, s.userModels);
        applyLocal(b.models, s, showDetails);
        set({ catalog: b.models, families: b.families, importReport: b.report, snapshotDate: b.snapshotDate, snapshotStats: { applied: b.snapshotApplied, added: b.snapshotAdded } });
      },
      saveVerification(v) {
        const id = `${v.family}:${v.variant}`.toLowerCase();
        set({ liveVerifications: { ...get().liveVerifications, [id]: v } });
        void get().rebuildCatalog();
      },
      addUserModel(m) {
        set({ userModels: [...get().userModels.filter((u) => u.id !== m.id), m] });
        void get().rebuildCatalog();
      },
      removeUserModel(id) {
        set({ userModels: get().userModels.filter((u) => u.id !== id), compare: get().compare.filter((c) => c !== id) });
        void get().rebuildCatalog();
      },
      addCapabilityEvidence(modelId, key, ev) {
        const cur = get().capabilityEvidence[modelId] ?? [];
        set({ capabilityEvidence: { ...get().capabilityEvidence, [modelId]: [...cur.filter((x) => !(x.key === key && x.ev.scope === ev.scope)), { key, ev }] } });
        void get().rebuildCatalog();
      },

      async refreshOllama() {
        set({ ollamaState: { ...get().ollamaState, status: "checking" } });
        const c = ollama();
        try {
          const v = await c.version();
          const [tags, ps] = await Promise.all([c.tags(), c.ps().catch(() => ({ models: [] }))]);
          for (const t of tags.models) {
            if (!showDetails.has(t.name) || showDigests.get(t.name) !== t.digest) {
              try {
                showDetails.set(t.name, await c.show(t.name));
                showDigests.set(t.name, t.digest);
              } catch {
                /* show failures leave metadata unknown */
              }
            }
          }
          set({ ollamaState: { status: "online", version: v.version, installed: tags.models, running: ps.models, checkedAt: new Date().toISOString() } });
        } catch (e) {
          set({ ollamaState: { status: "offline", installed: [], running: [], error: String((e as Error).message ?? e), checkedAt: new Date().toISOString() } });
        }
        await get().rebuildCatalog();
      },

      addBenchmark: (b) => set({ benchmarks: [b, ...get().benchmarks].slice(0, 200) }),
      clearBenchmarks: () => set({ benchmarks: [] }),
      toggleCompare(id) {
        const c = get().compare;
        if (c.includes(id)) set({ compare: c.filter((x) => x !== id) });
        else if (c.length >= 4) get().showToast("Compare holds up to 4 models. Remove one first.", "warn");
        else {
          set({ compare: [...c, id] });
          get().showToast("Added to Compare", "good");
        }
      },
      setTheme: (t) => set({ theme: t }),
      setMotion: (m) => set({ motion: m }),
      setInputs: (s) => set({ inputs: { ...s, text: true } }),
      setVerifiedOnly: (v) => set({ verifiedOnly: v }),
      showToast(text, tone = "info") {
        const id = ++toastId;
        set({ toast: { id, text, tone } });
        setTimeout(() => {
          if (get().toast?.id === id) set({ toast: null });
        }, 3200);
      },
    }),
    {
      name: "model-fit-explorer",
      version: 2,
      // v2: theme became user-selectable (light/dark/system); earlier builds defaulted to dark.
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Partial<Persisted>;
        if (version < 2) p.theme = "system";
        return p as Persisted;
      },
      storage: safeStorage,
      partialize: (s): Persisted => ({
        overrides: s.overrides,
        settings: s.settings,
        quantChoice: s.quantChoice,
        perModelQuant: s.perModelQuant,
        liveVerifications: s.liveVerifications,
        userModels: s.userModels,
        capabilityEvidence: s.capabilityEvidence,
        benchmarks: s.benchmarks,
        compare: s.compare,
        theme: s.theme,
        motion: s.motion,
        inputs: s.inputs,
        verifiedOnly: s.verifiedOnly,
        demoId: s.demoId,
        sample: s.sample,
        webHardware: s.webHardware,
        browserSetup: s.browserSetup,
        autoUpdate: s.autoUpdate,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<Persisted>;
        // Saved data is re-checked on every start, so a bad record can't break the app.
        if (p.benchmarks) p.benchmarks = (Array.isArray(p.benchmarks) ? p.benchmarks : []).map(sanitizeBenchmark).filter((b): b is BenchmarkRecord => !!b);
        if (p.userModels) p.userModels = (Array.isArray(p.userModels) ? p.userModels : []).map(sanitizeModel).filter((m): m is ModelVariant => !!m);
        if (p.liveVerifications) p.liveVerifications = sanitizeMap(p.liveVerifications, sanitizeVerification);
        if (p.capabilityEvidence) p.capabilityEvidence = sanitizeCapabilityEvidence(p.capabilityEvidence);
        return { ...current, ...p, settings: { ...current.settings, ...(p.settings ?? {}), reserves: { ...DEFAULT_SETTINGS.reserves, ...(p.settings?.reserves ?? {}) } }, overrides: { ...EMPTY_OVERRIDES, ...(p.overrides ?? {}) } };
      },
    },
  ),
);

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => useStore.setState({ route: routeFromHash() }));
}
