# How estimates work

Everything here is implemented in `src/domain/estimator.ts`, a pure function `(model, settings, machine) → estimate` with unit tests in `src/domain/estimator.test.ts`.

## Quantities

| Symbol | Meaning | Source, in order of preference |
| --- | --- | --- |
| **W** | Quantized weights held in memory: **all** experts for MoE, plus the vision encoder | Exact registry blob size → scaled from another published quantization of the same model → `params × bits/weight ÷ 8 × (1 + overhead)` (labelled *hypothetical*) |
| **A** | Active weights per token | `W × active/total` only when active params are known. Dense: A = W. Otherwise **Unknown**, never invented |
| **KV** | KV cache | `2 × layers × kv_heads × head_dim × ctx × bytes/elem × parallel` from GGUF/`/api/show`/`config.json`; sliding-window models get a bounded range; no metadata → wide heuristic range |
| **H_gpu** | GPU runtime | KV + compute scratch (`0.3 GiB + 6 KiB × ctx × parallel`, ×0.6–×1.8) + image activations + backend context (0.3–0.7 GiB) |
| **H_ram** | Host runtime | Runner process and buffers (0.3–0.9 GiB) |
| **V, R, U** | Usable VRAM, RAM, unified pool | Live free memory minus your reserve (default 0.5 GiB VRAM, 2 GiB RAM, capped at a quarter of RAM on small boards). *Normal use* (no live readings): 10% VRAM / 20% RAM reserves |

Every quantity is a range (low/mid/high). The class is computed at all three levels; if they disagree, confidence drops to *low* and a "borderline" warning appears. A GPU whose Ollama support isn't confirmed (AMD, Intel, older or unrecognised NVIDIA) is never given *high* confidence, and a warning says it may run on the CPU instead.

Free memory is never allowed to exceed total memory, and RAM and VRAM each carry their own basis (live reading or planning reserve).

**Groups.** *Runs well* means it fits fully on the GPU **and** the speed guess is at least 5 tok/s; a full-GPU fit slower than that is listed under *Runs, but slower*.

## Classes

- **Fully GPU**: W + H_gpu ≤ V (discrete) or ≤ the GPU working-set limit (unified: Apple Silicon, Jetson, DGX Spark).
- **Promising hybrid MoE**: does not fit fully, fits across VRAM + RAM, and A + KV + buffers ≤ V. Shown as *potential* only: real expert placement and speed must be measured.
- **Hybrid likely slow**: fits across pools but the GPU can't hold the active computation.
- **CPU only**: no usable GPU backend (or integrated graphics); fits in RAM.
- **Memory constrained**: fits only by using memory reserved for the OS and apps (swap risk). Disk/NVMe swap is not RAM.
- **Cannot fit**: exceeds physical memory.
- **Unknown**: missing model size or GPU memory. Shown as "Needs verification", never an optimistic yes.

## Rules that prevent double counting

- Apple Silicon, NVIDIA Jetson (Orin, Thor) and DGX Spark: one unified pool. On Macs the GPU is limited by `recommendedMaxWorkingSetSize`; elsewhere it is assumed ⅔–¾ of RAM unless you set it. VRAM and RAM are never added.
- Raspberry Pi, RK3588 boards and the original Jetson Nano run models on the CPU (Ollama has no GPU backend for them).
- Windows "shared GPU memory" is system RAM and is never added to dedicated VRAM.
- Integrated GPUs share RAM; Ollama GPU acceleration on them is not assumed.
- Multiple GPUs are not summed unless you turn on *Combine GPUs* after verifying your runtime splits models.
- Form factor (laptop/desktop) never changes capacity; power limits affect speed, not allocation.

## Speed

Generating a word is mostly limited by memory bandwidth: every token reads the active weights plus the KV cache. The guess is

`time per token = GPU bytes ÷ GPU bandwidth + CPU bytes ÷ RAM bandwidth + overhead`

The range runs from a full context window (slow end, late in a long chat) through ~4K tokens (typical) to a fresh chat (fast end). It uses published peak bandwidth for the GPU or chip (and for boards' RAM, e.g. Raspberry Pi 5 ≈ 17 GB/s), at 50–80% efficiency, so it is shown as a range with "≈". Typical desktop RAM is assumed when the board is unknown. When the GPU's bandwidth is unknown no number is shown. A local benchmark (`eval_count ÷ eval_duration`, converted from nanoseconds) is shown as "Measured X tok/s on this computer" and stored with model digest, quantization, context, Ollama version, GPU, driver, OS and backend. A measurement is only shown for the same installed file (digest and quantization) and never while a sample machine is shown; the test always measures the installed file, and the page says so when the estimate is for another quantization.

## Data provenance

Each field is `verified`, `derived`, `estimated`, `user_entered` or `unknown`, with source URL and timestamp. The seed CSV's Q4 sizes are heuristics and its tags are lookup candidates; they are only replaced by official registry data (`npm run catalog:refresh`). Records older than 45 days show a stale warning.
