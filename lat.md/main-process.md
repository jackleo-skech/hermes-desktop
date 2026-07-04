# Main Process

The Electron main process keeps the entrypoint small and separates app lifecycle from IPC registration.

## Entrypoint

`src/main/index.ts` performs only pre-ready setup and delegates startup.

[[src/main/index.ts]] applies GPU crash preferences, enables the optional CDP testing port, and calls [[src/main/app/start.ts#startMainProcess]]. This keeps one-off process boot concerns separate from windows, menus, updater wiring, and IPC.

## GPU Fallback

Hardware acceleration is disabled and persisted after a GPU-process crash so machines without a usable GPU avoid an infinite crash → relaunch loop — but only temporarily, so a transient crash can't strand a working GPU on SwiftShader.

[[src/main/gpu-fallback.ts#applyGpuPreferences]] disables hardware acceleration when a crash flag, relaunch sentinel, or `HERMES_DISABLE_GPU` says so, while keeping SwiftShader WebGL available. Persistent GPU-off fallback is honored by default on Windows/Linux, but macOS clears stale flags unless `HERMES_GPU_FALLBACK=1` forces it, protecting the Office tab from permanent software-rendering lag. [[src/main/gpu-fallback.ts#installGpuCrashGuard]] watches fatal GPU-process exits and relaunches with software rendering where the persistent fallback is enabled.

### Flag expiry

The persisted `disable-gpu.flag` is only honored for 24 hours after the crash that wrote it; a stale or unparseable flag is cleared at launch and hardware acceleration is retried.

GPU crashes are often transient (driver update mid-session, a since-removed virtual display adapter, a Chromium blocklist gap for a brand-new GPU), and before the TTL a single crash silently pinned Windows/Linux machines to software rendering forever — a user with an RTX 5060 Ti ran the Office 3D tab at 1 fps on 10+ CPU cores for over a week. If the GPU genuinely still crashes, the re-armed crash guard re-persists a fresh flag, so a broken machine pays at most one crash+relaunch per 24-hour window.

### User preference

Settings → Appearance offers a tri-state hardware-acceleration preference — Auto (crash-guard driven, the default), Always on, Always off — persisted in `gpu-preference.json` beside the crash flag.

The preference lives in `userData`, not renderer settings storage, because [[src/main/gpu-fallback.ts#getGpuPreference]] must read it synchronously before app-ready — the only point where hardware acceleration can still be disabled. Precedence is `HERMES_DISABLE_GPU` env (support escape hatch) > relaunch sentinel (a crash still rescues the current session even under "Always on") > preference > crash flag. Under "Always on" the crash guard relaunches with the sentinel but skips persisting the flag, so every subsequent launch retries hardware acceleration; "Always off" suppresses the crash guard and the Office banner's re-enable button (the banner points at Settings instead). [[src/main/gpu-fallback.ts#setGpuPreference]] writes the file (IPC `set-gpu-preference`, validated in the main process); changes apply after a relaunch via [[src/main/gpu-fallback.ts#relaunchApp]] (IPC `relaunch-app`). The Appearance pane (`src/renderer/src/components/settings/AppearancePane.tsx`) compares the saved preference against the `bootPreference` captured by [[src/main/gpu-fallback.ts#applyGpuPreferences]] so its "restart to apply" prompt survives closing and reopening Settings.

### Renderer visibility and recovery

Software rendering is no longer silent: the Office tab shows a warning banner with a one-click recovery when hardware acceleration is off.

[[src/main/gpu-fallback.ts#getGpuStatus]] reports whether the GPU is disabled, why (`env` / `preference` / `sentinel` / `flag`), and whether the app can recover; [[src/main/gpu-fallback.ts#reenableGpuAndRelaunch]] deletes the flag and relaunches without the GPU-off sentinel (refused when `HERMES_DISABLE_GPU=1` forces software rendering, since a relaunch would inherit it). Both are exposed over IPC (`get-gpu-status`, `reenable-gpu`) via the preload bridge, and the Office screen (`src/renderer/src/screens/Office/Office.tsx`) renders the banner over the 3D view — the one surface where SwiftShader is painfully visible. The one-click re-enable applies only to crash fallbacks: env- and preference-forced software rendering render an informational banner without the button.

## App Lifecycle

Lifecycle code owns Electron windows, global app events, and shutdown cleanup.

[[src/main/app/start.ts#startMainProcess]] registers crash logging, IPC handlers, updater handlers, Electron ready/activate/window-all-closed/before-quit events, CSP headers, security hardening, and the main BrowserWindow.

[[src/main/app/start.ts]] also supports the `HERMES_OPEN_DEVTOOLS=1` diagnostic launch path so packaged builds can expose renderer console errors when startup fails before the UI paints.

The packaged renderer keeps its meta CSP aligned with the production response CSP so file-backed startup assets load consistently from `file://` before the main-process header can help.

Because electron-vite emits a bundled main file at `out/main/index.js`, packaged renderer loading resolves `../renderer/index.html` from `__dirname` to reach `out/renderer/index.html`.

## App Chrome Helpers

Menu, updater, and context-menu behavior live in focused modules.

[[src/main/app/menu.ts#buildMenu]] owns the application menu, [[src/main/app/updater.ts#setupUpdater]] owns update IPC and electron-updater events, and [[src/main/app/context-menu.ts#showChatContextMenu]] owns the chat right-click menu.

Release builds keep a Help-menu Developer Tools toggle as a production diagnostics escape hatch without changing renderer sandbox or Node isolation.

## IPC Registry

Renderer IPC handlers are isolated from app bootstrap so the registry can be split by domain.

[[src/main/ipc/register.ts#registerIpcHandlers]] currently preserves the existing handler behavior behind one registration function. It receives app-level callbacks for the main window, model-library notifications, connection-config notifications, external URL opening, and active chat abort handles.

Wallet and token-balance handlers sit in the same registry: `list-wallets`, `create-wallet`, `import-wallet`, `rename-wallet`, `delete-wallet` (backed by [[wallet-token-balances#Wallet Store]]) and `get-token-balances` (backed by [[wallet-token-balances#Token Balances]]).

## Voice transcription IPC

Speech-to-text IPC sends recorded desktop audio through the Hermes API server, not through the active chat model endpoint.

[[src/main/ipc/register.ts#registerIpcHandlers]] exposes `transcribe-audio` for the preload bridge, and [[src/main/hermes.ts#transcribeAudio]] posts a base64 data URL to `/api/audio/transcribe`. If the local gateway lacks that desktop route, it falls back to the Python `tools.transcription_tools.transcribe_audio` dispatcher, so local Whisper, Groq, OpenAI, ElevenLabs, and command/plugin STT providers remain independent from the selected chat model.
