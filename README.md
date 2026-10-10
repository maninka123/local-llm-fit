# Model Fit Explorer

**Which local AI models can your computer actually run?** Build a model in the Playground and watch its memory blocks settle into your GPU memory and RAM, or let the app rank the best models for your machine. Works on Windows, macOS and Linux.

**[▶ Try it in your browser](https://maninka123.github.io/local-llm-fit/)** · **[Download the desktop app](https://github.com/maninka123/local-llm-fit/releases/latest)**

> **Tip:** Browsers hide exact hardware details, so the web version estimates your machine and may not get every spec right. For exact, live readings, use the desktop app. It's a tiny download (about 2–3 MB on Windows and Mac). The website has a **Get the desktop app** button that picks the right file for you.

![Playground: build a model and see where it fits](docs/screenshots/playground.png)

## What it does

- **Playground.** Set a model's size, type (dense or Mixture-of-Experts), precision and context, and watch its memory blocks fill your VRAM and RAM.
- **What can I run.** 430+ models sorted into *Runs well · Runs, but slower · Tight fit · Won't run*, best first, each with a reason.
- **Try a specific model.** Search Ollama or Hugging Face, or paste a link, and see if it fits.
- **Honest estimates.** Real file sizes from the Ollama registry; Apple unified memory and Windows shared memory handled correctly; speed shown as a labelled guess, or measured with a local benchmark when you ask.
- **Sample machines.** Desktops, laptops, Macs, and boards like Raspberry Pi and Jetson, each adjustable.
- **Light, dark or system theme**, keyboard and reduced-motion friendly.

![Where a model would live on a 16 GB GPU](docs/screenshots/detail-moe.png)

![What can I run, ranked](docs/screenshots/what-can-i-run.png)

## Desktop app vs. browser

| | Desktop app | Browser |
| --- | --- | --- |
| Hardware detection | Exact and live (GPU, VRAM, free memory, Apple working-set limit) | GPU name and CPU threads from the browser, known GPU specs, plus a 30-second confirmation |
| Model search | Ollama + Hugging Face | Hugging Face (ollama.com blocks browser requests); bundled verified catalog |
| Local Ollama, benchmarks | Yes | Only if you allow the site in `OLLAMA_ORIGINS` |
| Updates | Automatic, signed | Always the latest |

## Install

Download from [Releases](https://github.com/maninka123/local-llm-fit/releases/latest). Not sure which file? See **[which file to download](docs/RELEASE_ASSETS.md)**. In short: Windows `…x64-setup.exe`, Mac `…aarch64.dmg` (Apple Silicon) or `…x64.dmg` (Intel), Linux `…amd64.AppImage`, Raspberry Pi / Jetson / other 64-bit ARM boards `…aarch64.AppImage`. The installers are not code-signed yet: on macOS right-click the app → **Open** the first time; on Windows choose **More info → Run anyway**.

The app checks GitHub for new versions on launch and shows an update dialog with progress; it can also be checked from **Settings → Updates**. On Linux, auto-update applies to the AppImage; `.deb`/`.rpm` installs update through your package manager.

[Ollama](https://ollama.com) is optional: estimates work without it.

## Build from source

Requirements: Node.js 22+, Rust (stable) and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```bash
npm install
npm run dev          # browser version at http://localhost:5173
npm run app:dev      # desktop app with live reload
npm run app:build    # installers in src-tauri/target/release/bundle/
```

Each OS builds its own installers (macOS: `.app`/`.dmg`, Windows: `.msi`/`.exe`, Linux: `.AppImage`/`.deb`/`.rpm`).

## Releasing a new version

```bash
npm version 1.1.0      # updates the version and creates the tag v1.1.0
git push --follow-tags
```

The tag starts `.github/workflows/release.yml`: it builds Windows, macOS and Linux (x64 + ARM64), signs the updates with the `TAURI_SIGNING_PRIVATE_KEY` secret, and publishes the release once every platform is done. Installed apps then update automatically. Keep the private key secret and backed up, or existing installs can't verify new updates.

## How the estimate works

`total = weights (all experts) + KV cache + compute buffers + image activations + backend context + host process`, compared with free memory minus a reserve. Details and rules: [docs/ESTIMATION.md](docs/ESTIMATION.md).

## Development

```bash
npm test              # unit tests (estimator, ranking, capabilities, catalog, browser detection)
npm run test:e2e      # Playwright end-to-end + screenshot tests
npm run test:rust     # hardware probe fixtures for Windows/Linux/macOS + backend allowlists
npm run probe         # print this machine's hardware report as JSON
npm run catalog:refresh   # re-verify the catalog against ollama.com (metadata only)
```

## Privacy

No telemetry or accounts. Hardware details never leave your computer. Online lookups send only the model name you type. Benchmarks and downloads run only after you confirm.

## License

[MIT](LICENSE)
