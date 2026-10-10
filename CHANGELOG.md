# Changelog

Short, user-facing notes. The section for each version is shown in the app's update window.

## 1.0.19
- Build your sample: desktop/workstation (graphics card, memory size, 1 or 2 cards), gaming laptop (laptop GPU), Mac (model, chip and memory), office laptop or board
- Dropdowns now match the app's light and dark theme
- Shorter top-bar buttons: "My computer" and "Desktop app"
- Fix: two AMD cards (RX 6900/6950 XT, RX 6700/6750 XT) were not recognised correctly

## 1.0.18
- The machine your results are for is now ringed in the top bar (dashed for a sample)
- While a sample is shown, a "Back to my computer" button sits top-right

## 1.0.17
- While a sample is shown, the top bar also shows your own computer, with one click back to it
- "No graphics card" now always means models run on the CPU, even if a GPU was detected
- Compare and Playground no longer mention GPU memory on computers without a usable GPU

## 1.0.16
- Samples: one "Single-board & edge AI" option, then choose the board
- Boards show their GPU and say clearly whether Ollama can use it

## 1.0.15
- New sample machines: Raspberry Pi 4/5, Orange Pi 5 Plus, Jetson Nano, Orin Nano Super, Orin NX, AGX Orin, AGX Thor and DGX Spark
- Desktop app for 64-bit ARM Linux (Raspberry Pi, Jetson); detects Jetson GPUs and board names
- Realistic speed guesses on boards with slower memory
- The MacBook sample is now simply "MacBook"
- Clearer wording on computers without a usable GPU, and several small fixes

## 1.0.14
- Clearer memory choice: Live or Normal use

## 1.0.13
- Choose Live (memory free now) or Normal use (typical background use) for your computer
- Update button in the top-right corner when a new version is ready
- Consistent fonts on Windows and Linux; centred text in the Data/Time bars

## 1.0.12
- Try sample machines in the desktop app, or adjust your detected memory
- Cleaner update window with a short “What's new” list
- Release pages explain which file to download

## 1.0.11
- Clearer “won't run” vs “tight fit” in the memory blocks
- Tight fit shows the apps' memory to free, with “Try with apps closed”
- Speed guesses in tokens per second, plus where each word's work happens

## 1.0.1
- New Playground with 3D memory blocks
- “What can I run” ranks the best models for your computer
- Light, dark and system themes; automatic updates
