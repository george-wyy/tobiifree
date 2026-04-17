// Optional bridge producer: pushes each gaze sample to a local WebSocket relay.
//
// Off by default. Enable with one of:
//   ?bridge=1                       (uses ws://localhost:7081/gaze)
//   ?bridge=ws://host:port/path     (custom URL)
//
// Consumer: voice-gaze-ui (or any client) receives { x, y, pupil, t } in the
// same wire format as its TobiiSource expects. Kept out of the main demo code
// so tobiifree-demo behaves identically for users who don't opt in.

import type { GazeSample, Source } from 'tobiifree-sdk-ts';

const DEFAULT_URL = 'ws://localhost:7081/gaze';

function resolveBridgeUrl(): string | null {
  const p = new URLSearchParams(location.search).get('bridge');
  if (!p) return null;
  if (p === '1' || p === 'true') return DEFAULT_URL;
  return p;
}

// Optional transform: given a raw GazeSample, return the 2D normalized
// point to broadcast (or null to drop the sample). Useful for applying
// a client-side correction model before broadcasting — consumers see
// the corrected coordinates without knowing the model exists.
export type GazeTransform = (s: GazeSample) => { x: number; y: number; corrected: boolean } | null;

export function maybeStartBridgeProducer(
  tracker: Source,
  transform?: GazeTransform,
): () => void {
  const url = resolveBridgeUrl();
  if (!url) return () => {};

  let ws: WebSocket | null = null;
  let connected = false;
  let pendingReconnect: number | null = null;
  let droppedWhileOffline = 0;

  const open = () => {
    ws = new WebSocket(url);
    ws.addEventListener('open', () => {
      connected = true;
      console.log(`[bridge] connected to ${url}`);
      if (droppedWhileOffline > 0) {
        console.log(`[bridge] (dropped ${droppedWhileOffline} samples while offline)`);
        droppedWhileOffline = 0;
      }
    });
    ws.addEventListener('close', () => {
      connected = false;
      ws = null;
      if (pendingReconnect === null) {
        pendingReconnect = window.setTimeout(() => { pendingReconnect = null; open(); }, 2000);
      }
    });
    ws.addEventListener('error', () => { /* close event follows */ });
  };
  open();

  const unsub = tracker.subscribeToGaze((s: GazeSample) => {
    if (!connected || !ws || ws.readyState !== 1) { droppedWhileOffline++; return; }
    let pt: { x: number; y: number } | null = null;
    let corrected = false;
    if (transform) {
      const r = transform(s);
      if (r) { pt = { x: r.x, y: r.y }; corrected = r.corrected; }
    } else {
      const p = s.gaze_point_2d_norm;
      if (p) pt = { x: p.x, y: p.y };
    }
    if (!pt) return;
    const pl = s.pupil_diameter_L_mm;
    const pr = s.pupil_diameter_R_mm;
    const pupils = [pl, pr].filter((v): v is number => typeof v === 'number' && v > 0);
    const pupil = pupils.length ? pupils.reduce((a, b) => a + b, 0) / pupils.length : null;
    ws.send(JSON.stringify({ x: pt.x, y: pt.y, pupil, t: Date.now(), corrected }));
  });

  return () => {
    unsub();
    if (pendingReconnect !== null) clearTimeout(pendingReconnect);
    ws?.close();
  };
}
