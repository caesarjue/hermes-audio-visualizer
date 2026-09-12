# Main-process patch — system-audio loopback

`hermes-desktop-audio-loopback.patch` is a source patch for `apps/desktop/electron/main.ts` in [hermes-agent](https://github.com/NousResearch/hermes-agent), written against **Hermes Desktop 0.17.2 / Electron 40.10.2**.

## Why a patch is needed

The audio visualizer captures **system output** (loopback) via `getDisplayMedia({ audio: true })`. On macOS that requires the main process to:

1. enable Chromium's loopback feature: `MacCatapLoopbackAudioForScreenShare`
2. register `session.defaultSession.setDisplayMediaRequestHandler(...)` answering with `{ video: <screen source>, audio: 'loopback' }`

Desktop plugins run in the **renderer** process and cannot reach either — hence the patch.

## What it does

- Adds `desktopCapturer` to the electron import list.
- Appends the `enable-features` switch **before** `app.whenReady()` (a `commandLine` switch must be set pre-ready to take effect).
- Inside `whenReady()`, grabs a screen source and registers the display-media request handler. It answers **every** `getDisplayMedia` in the app — the app itself has no other callers today.

Notes and constraints kept from hard-won experience:

- `session.defaultSession` throws if touched before `ready` — the handler registration is inside `whenReady()` for exactly this reason.
- The handler must supply a **real screen source** for the video leg. Combined with [electron#49607](https://github.com/electron/electron/issues/49607): an audio-only request fails with `Error starting capture` on this stack, so the renderer sends a 4×4 placeholder video request and stops the resulting video track immediately. The plugin already does this.
- Audio never leaves the renderer process: the plugin only reads FFT magnitudes from an `AnalyserNode`. Nothing is recorded or uploaded.

## Apply

```bash
cd ~/.hermes/hermes-agent
git apply --check /path/to/hermes-desktop-audio-loopback.patch   # verify it applies cleanly
git apply /path/to/hermes-desktop-audio-loopback.patch
```

Then rebuild and reinstall the desktop app (the patch ships in the main process bundle, which is compiled at build time):

```bash
cd apps/desktop
npm run build && npm run builder -- --dir --publish never --arm64
# ⌘Q quit Hermes first, then:
ditto release/mac-arm64/Hermes.app /Applications/Hermes.app
```

## Revert

```bash
cd ~/.hermes/hermes-agent
git apply --reverse /path/to/hermes-desktop-audio-loopback.patch
# rebuild the same way
```

## When Hermes updates

The patch applies cleanly only against the version it was cut from. After a Hermes/Electron update:

1. If the context lines moved, re-apply with fuzz or regenerate (see below).
2. **Check the feature name still exists** — the loopback feature family has been renamed by Chromium before (`MacSck*` → `MacCatap*`):

   ```bash
   strings "/Applications/Hermes.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework" \
     | rg -i 'loopback' | sort -u
   ```

   Replace `MacCatapLoopbackAudioForScreenShare` in the patch with whatever the binary reports.
3. Rebuild and reinstall.

## Why not upstream it?

Loopback audio is useful beyond this plugin (screen sharing with audio, recording, live transcription). A future upstream implementation could gate it behind a config key and let this patch disappear. Contributions welcome.
