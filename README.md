# Hermes Audio Visualizer

**English** | [简体中文](README.zh.md)

A system-audio-driven rainbow spectrum for the **Hermes Desktop** status bar — 48 bars that dance to whatever your Mac is playing, plus a window-edge glow that breathes with the bass.

Fully local: audio is analyzed in memory only (FFT via `AnalyserNode`), never recorded, never uploaded.

```
 ▁▃▅█▅▃▁▂▄▆█▆▄▂  ← 48-bar rainbow spectrum chip (status bar, right side)
 + window edge glow (cool blue when quiet → warm red-orange on heavy bass)
```

## Features

- **48-bar rainbow spectrum** — hue by frequency (low = red → high = violet), lightness follows amplitude
- **Window-edge glow** — an inset glow around the whole window, driven by the actual bass range (~47–234 Hz)
- **Adaptive sensitivity** — a slowly-decaying gain tracker so quiet tracks still fill the bars, with a contrast curve so heavy beats visibly punch
- **Real band separation** — 2048-point FFT with a hybrid band split (40–500 Hz linear, 500–11 kHz log). The low bars each own a separate bin instead of sharing one, so they move independently
- **Crest-friendly gain** — pre-analyser −9 dB trim + dynamic expansion + 8 % headroom: the curve rides between ~25 % and 100 % instead of pinning to the ceiling
- **One click on/off** — click the status-bar chip, or ⌘K → "音频律动"
- **Zero telemetry** — `getDisplayMedia` → `AnalyserNode` → canvas. Nothing leaves the process.

> **2026-11 update** — three amplitude issues are fixed in this version: (1) the 8-bit `getByteFrequencyData` mapping (default −100/−30 dB) was saturating the whole low end, so every frame had a bar pinned at 100 % and the curve looked flat; (2) 512-point FFT at 48 kHz gave 93.75 Hz/bin, which collapsed the first ~14 log bands onto a single bin; (3) `raw**0.78` + peak normalisation flattened the remaining dynamics. Now: pre-gain −9 dB, 2048-point FFT, hybrid linear/log bands, `raw**1.10`, floor 0.05, 8 % top headroom.

## Requirements

> ⚠️ **This plugin needs a main-process patch.** Desktop plugins run in the renderer process and cannot register the `setDisplayMediaRequestHandler` that Chromium's loopback-audio path requires. The patch lives in [`patches/`](patches/) — apply it once, then the plugin works like any other.

| Component | Version |
|---|---|
| Hermes Desktop | 0.17.2 (Electron 40.10.2) |
| macOS | 13.2+ (developed on macOS 26.6) |

## Install

### 1. Install the plugin

One-click (Hermes Desktop needs to be running):

**`hermes://plugin/install?repo=caesarjue/hermes-audio-visualizer`**

Or via **Settings → Plugins → Install from Git** with `caesarjue/hermes-audio-visualizer`, or manually:

```bash
mkdir -p ~/.hermes/desktop-plugins/audio-visualizer
cp plugin.js ~/.hermes/desktop-plugins/audio-visualizer/plugin.js
```

### 2. Apply the main-process patch

```bash
# 1) clone this repo somewhere
git clone https://github.com/caesarjue/hermes-audio-visualizer.git /tmp/hav

# 2) apply the patch to your Hermes source tree
cd ~/.hermes/hermes-agent
git apply /tmp/hav/patches/hermes-desktop-audio-loopback.patch

# 3) rebuild and reinstall the desktop app
cd apps/desktop
npm run build && npm run builder -- --dir --publish never --arm64
# quit Hermes (⌘Q), then from a terminal:
ditto release/mac-arm64/Hermes.app /Applications/Hermes.app
```

Verify the patch landed (should print `1`):

```bash
rg -c "MacCatapLoopbackAudioForScreenShare" ~/.hermes/hermes-agent/apps/desktop/electron/main.ts
```

### 3. Enable

1. Open Hermes Desktop → **⌘K → "Reload desktop plugins"**
2. A spectrum chip appears in the status bar, right side (left of the context-usage chip)
3. **Click it** — the dot lights up and the bars start moving 🎵

## Usage

| Action | Result |
|---|---|
| Click the chip | toggle on / off |
| ⌘K → "音频律动" | toggle from the command palette |
| Play anything (music, video, calls) | bars follow the system output mix |
| Turn off | audio stream is released immediately, glow disappears |

## Troubleshooting

| Symptom | Fix |
|---|---|
| Chip is grey / nothing moves | Click the chip to start |
| Plugin missing after an update | ⌘K → **Reload desktop plugins** (full reload beats repeated hot-reloads) |
| `Error starting capture` | The main-process patch isn't applied (or the app wasn't rebuilt/reinstalled after applying) |
| `Video was requested, but no video stream was provided` | Old plugin version — update to the latest `plugin.js` |
| macOS permission prompt | Allow **Screen & System Audio Recording** for Hermes on first use |

Diagnostics: the plugin writes its state to `localStorage['av.diag']`:

```bash
strings ~/Library/Application\ Support/Hermes/Local\ Storage/leveldb/* | rg 'av\.diag'
# {"t":...,"state":"drawing","cv":true,"max":87}  → healthy
```

## Compatibility notes (for future Hermes/Electron versions)

- The loopback feature is **`MacCatapLoopbackAudioForScreenShare`** on Electron 40. This family has been renamed before (`MacSck*` → `MacCatap*`). If the plugin stops working after a Hermes update:

  ```bash
  strings "/Applications/Hermes.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework" | rg -i 'loopback' | sort -u
  ```

  Use whatever name comes back in place of `MacCatapLoopbackAudioForScreenShare` in the patch.
- `session.defaultSession` must only be touched after `app.whenReady()` — the patch already does this.
- Audio-only `getDisplayMedia` is broken on this Chromium stack ([electron#49607](https://github.com/electron/electron/issues/49607)); the workaround (a tiny placeholder video track + a real screen source in the handler) is baked into both the patch and the plugin.

## Uninstall

```bash
rm -rf ~/.hermes/desktop-plugins/audio-visualizer
# and revert the source patch if you like:
cd ~/.hermes/hermes-agent && git apply --reverse <patch>
```

## License

MIT — see [LICENSE](LICENSE).
