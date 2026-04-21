# tobiifree - ET5 on Linux & Web

An ongoing experiment to make Tobii eye trackers work on Linux.

The Tobii Eye Tracker 5 (ET5) ships with Windows-only drivers and no public protocol documentation. Under EU law — specifically the [European Interoperability Act](https://eur-lex.europa.eu/eli/dir/2009/24/oj) and related directives — reverse engineering for interoperability purposes is permitted. This project exercises that right to bring eye tracking to Linux users.

> **Status:** experimental. The USB wire protocol was decoded by observing the device's standard USB bulk transfers. Things work, things break, things change.

## Demo: https://aetherall.github.io/tobiifree/
<img width="2309" height="1219" alt="image" src="https://github.com/user-attachments/assets/8fe16a58-5d75-4104-a6bd-2c038be8d1e6" />


## What's here

- **driver/** — Zig implementation of the TTP/TLV framing protocol. Compiles to both WebAssembly (for the browser SDK) and native (for the Linux applications). Pure byte-level protocol engine — no allocator, no syscalls.
- **sdk/** — TypeScript SDK wrapping the wasm core. Works in the browser (WebUSB) and Node.js (`usb` package). `Tobii.fromUsb()` to connect, `subscribeToGaze()` to stream.
- **applications/tobiifreed** — Linux daemon. Talks to the tracker over libusb, exposes gaze data over a Unix socket (and optionally WebSocket).
- **applications/tobiifree-overlay** — GTK4 + layer-shell overlay that draws a gaze dot on your Wayland desktop. Connects directly via USB or through the daemon.
- **applications/tobiifree-demo** — Browser app for live gaze visualization, calibration, and display area configuration. Hosted on GitHub Pages.
- **assets/** — Firmware tools (DFU flash/extract) and udev rules.

## Quick start

### Prerequisites

[Nix](https://nixos.org/) with flakes enabled, or Zig 0.14+ and Node.js 22+ installed manually.

```sh
# Enter the dev shell (provides zig, node, libusb, gtk4, etc.)
nix develop

# USB permissions (run once)
sudo cp assets/99-tobii.rules /etc/udev/rules.d/
sudo udevadm control --reload && sudo udevadm trigger
```

### Build and run

```sh
# Run the daemon (direct USB)
just tobiifreed

# Run the gaze overlay (direct USB)
just overlay

# Run the overlay through the daemon (Unix socket)
just tobiifreed                # terminal 1
just overlay -- --socket   # terminal 2

# Run the browser demo (WebUSB, opens http://localhost:5173)
just bundle   # build wasm + embed in SDK
just demo
```

### Nix packages

```sh
nix build .#tobiifreed        # daemon binary
nix build .#tobiifree-overlay # GTK4 overlay binary
nix build .#tobiifree-demo     # static SPA (deployable to any web server)
```

## Supported hardware

| Device | VID:PID | Status |
|--------|---------|--------|
| Tobii Eye Tracker 5 (runtime) | `2104:0313` | Working — gaze, calibration, display area |
| Tobii Eye Tracker 5 (bootloader) | `2104:0102` | DFU flash only |
| Tobii 4c (runtime) | `2104:0127` | **Fork** — WebUSB path only; 90 Hz verified on macOS (see `feat/tobii-4c-support`) |

## Fork additions

This fork adds two features on top of upstream `aetherall/tobiifree`.

### 1. Calibration workbench — on `main`

Post-calibration validation + client-side polynomial correction fit, layered
on top of the tracker's onboard calibration. Code in
`applications/tobiifree-demo/src/cal-workbench.ts` (~413 LOC), integrated into
`main.ts`.

**Features**:
- **Validation grids**: 5 / 9 / 13 test points (configurable margin)
- **Client-side fit models**: `affine` / `poly2` / `poly3` (polynomial degree
  1-3) applied to gaze after onboard calibration
- **Persistent bundles**: browser `localStorage` under key
  `tobii_cal_bundles_v1` — stores display area, screen rect, viewport, onboard
  cal blob, test points, fit model, pre/post residual stats. Loadable /
  exportable / deletable from the UI.
- **Residual statistics**: mean / p95 / max error norms, per-point errors,
  computed before and after the client-side fit
- **Apply fit correction** toggle: enable/disable the client-side fit at
  runtime (compare with/without)

### 2. Tobii 4c support — `feat/tobii-4c-support` branch

Adds Tobii 4c (`2104:0127`) to the WebUSB path. USB descriptors are
structurally identical to ET5 (same product string `EyeChip`, same 3-interface
composite layout, same endpoint counts), so the TTP/TLV protocol is reused
as-is.

**Scope**: WebUSB path only (`sdk/src/webusb.ts` + `applications/tobiifree-demo`).
The native Zig path (`driver/src/libusb_transport.zig`, used by `tobiifreed`)
has not been updated.

**Tested on**: macOS 26 / Chrome WebUSB, 90 Hz gaze stream, 5-pt affine
calibration pipeline working end-to-end.

**Known differences from ET5**:
- `validity_L/R` mask bits show 0/0 (field position/semantics likely differ);
  gaze and pupil values are still correct
- Extra column IDs `0x25` / `0x27` carry additional direction data; handled
  by the generic TLV fallback in `tobiifree_decode.zig`

## License

[GPL-3.0](LICENSE)
