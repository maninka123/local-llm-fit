## Which file should I download?

| Your computer | Download this | Notes |
| --- | --- | --- |
| **Windows** 10 / 11 | `Model.Fit.Explorer_<version>_x64-setup.exe` | Recommended. `…_x64_en-US.msi` does the same for managed/IT installs. |
| **Mac with Apple Silicon** (M1–M5) | `Model.Fit.Explorer_<version>_aarch64.dmg` | Not sure? Apple menu → About This Mac → **Chip** says "Apple M…". |
| **Mac with Intel** | `Model.Fit.Explorer_<version>_x64.dmg` | About This Mac says **Processor: Intel**. |
| **Linux** (any distro) | `Model.Fit.Explorer_<version>_amd64.AppImage` | Recommended: runs anywhere and updates itself. Make it executable, then run it. |
| Linux: Ubuntu / Debian | `Model.Fit.Explorer_<version>_amd64.deb` | Install with `sudo apt install ./<file>.deb`. Updates via your package manager. |
| Linux: Fedora / openSUSE | `Model.Fit.Explorer-<version>-1.x86_64.rpm` | Install with `sudo dnf install ./<file>.rpm`. |

**First launch:** the installers aren't code-signed yet. On macOS, right-click the app → **Open** → **Open**. On Windows, click **More info → Run anyway**.

## What are the other files?

You don't need to download these:

- **`.sig` files**: digital signatures. The app uses them to check that an update really comes from this project.
- **`latest.json`**: tells installed apps which version is newest and where to get it (used by auto-update).
- **`.app.tar.gz` files**: compressed macOS app used only by auto-update (use the `.dmg` to install).
- **Source code (zip / tar.gz)**: added automatically by GitHub, for building the app yourself.

Once installed, the app updates itself: when a new version is released it shows an update window with a progress bar.
