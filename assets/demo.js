/*
 * phiredact /demo — the live model, in this tab.
 *
 * Runs the real phi-redact v9 pipeline in the browser, reusing the
 * Chrome extension's engine code verbatim (assets/lib/: WordPiece
 * tokenizer, BIOES decode, checksum-gated rules, merge — the same
 * modules the extension ships, themselves ports of the SDK engine).
 * Inference is onnxruntime-web (assets/ort/, v1.30.0) on the WASM
 * backend, single-threaded: GitHub Pages cannot send the COOP/COEP
 * headers cross-origin isolation requires, so numThreads stays 1,
 * exactly as in the extension's offscreen document.
 *
 * Privacy invariants: redaction is 100% client-side. The only network
 * traffic is first-party GETs of the model assets below (then the
 * Cache Storage copy). Nothing typed or pasted is ever sent anywhere;
 * PostHog autocapture is off on this page and the panes are marked
 * ph-no-capture (see demo/index.html).
 */

import { WordPieceTokenizer } from "./lib/tokenizer.js";
import { NeuralEngine } from "./lib/neural.js";
import { scanAll } from "./lib/merge.js";

// Model assets: CDT5058/phi-redact release v9, self-hosted under
// assets/model/ (byte counts from the extension's modelFiles.js).
const MODEL_FILES = [
  { name: "phi-redact-v9-int8.onnx", bytes: 11323243, key: "model" },
  { name: "tokenizer.json", bytes: 711494, key: "tokenizer" },
  { name: "tags.json", bytes: 1623, key: "tags" },
];
const MODEL_TOTAL = MODEL_FILES.reduce((a, f) => a + f.bytes, 0);
const MODEL_CACHE = "phiredact-model-v9";
const GLOBAL_THRESHOLD = 0.6; // SDK 0.3.0+ default gate

// The two samples that ship with the page's preset chips. "discharge"
// is read from the prefilled textarea at startup so the markup stays
// the single source for it. All sample people are fictional.
const SAMPLES = {
  discharge: null, // filled from the textarea below
  case_note:
    "Intake call with Marcus T. Bell on 10/28/2026. Client DOB 03/14/1985, phone (330) 555-0119, email mbell85@example.com. Household of four at 1227 Kenmore Blvd, Akron, OH 44313. Case number OH-552-9017. Client reported a new employer, Brightpath Logistics, starting 11/03/2026. Forward the verification letter to his sister, Dana Bell, at (330) 555-0126.",
  log_lines: [
    "2026-10-29T14:03:11Z auth[2214]: Accepted password for j.okafor from 192.168.4.22 port 51208 ssh2",
    "2026-10-29T14:03:19Z billing[0871]: invoice INV-2026-8813 charged to card 4111 1111 1111 1111 for account daniel.okafor@example.net",
    "2026-10-29T14:04:02Z api[3305]: POST /v1/members/UHC-88-204-5519/claims from 10.0.8.41 - 201 Created",
    "2026-10-29T14:04:37Z auth[2214]: Failed password for e.okafor from 203.0.113.87 port 49322 ssh2",
  ].join("\n"),
};
const SAMPLE_TITLES = {
  discharge: "Sample — discharge note",
  case_note: "Sample — case note",
  log_lines: "Sample — log lines",
};

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const input = document.getElementById("demo-input");
const mirror = document.getElementById("demo-mirror");
const output = document.getElementById("demo-output");
const outLab = document.getElementById("demo-outlab");
const found = document.getElementById("demo-found");
const status = document.getElementById("demo-status");
const title = document.getElementById("demo-title");
const copyBtn = document.getElementById("demo-copy");
const clearBtn = document.getElementById("demo-clear");
const chips = [...document.querySelectorAll(".chips .chip")];

SAMPLES.discharge = input.value;

// ---------------------------------------------------------------------------
// Model loading (streaming progress + Cache Storage, as the extension
// does, so the "downloads once" claim is literal)
// ---------------------------------------------------------------------------

let engine = null; // NeuralEngine once ready
let engineFailed = false;

async function fetchAsset(file, report) {
  const url = new URL(`./model/${file.name}`, import.meta.url);
  let cache = null;
  try {
    cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(url);
    if (hit) {
      report(file.bytes);
      return new Uint8Array(await hit.arrayBuffer());
    }
  } catch {
    cache = null; // Cache Storage unavailable (e.g. blocked): fetch direct.
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`model download failed: HTTP ${resp.status}`);
  const parts = [];
  let got = 0;
  const reader = resp.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.byteLength;
    report(value.byteLength);
  }
  const buf = new Uint8Array(got);
  let at = 0;
  for (const p of parts) {
    buf.set(p, at);
    at += p.byteLength;
  }
  if (cache) {
    try {
      await cache.put(
        url,
        new Response(buf.slice(0), {
          headers: { "Content-Type": "application/octet-stream" },
        }),
      );
    } catch {
      /* caching is best-effort; the bytes are already in hand */
    }
  }
  return buf;
}

async function initEngine() {
  let done = 0;
  const report = (n) => {
    done += n;
    status.textContent = `Loading model — ${Math.min(99, Math.round((done / MODEL_TOTAL) * 100))}%`;
  };
  status.textContent = "Loading model — 0%";
  const buffers = {};
  for (const file of MODEL_FILES) {
    buffers[file.key] = await fetchAsset(file, report);
  }
  const ort = await import("./ort/ort.wasm.bundle.min.mjs");
  ort.env.wasm.wasmPaths = new URL("./ort/", import.meta.url).href;
  ort.env.wasm.numThreads = 1; // no cross-origin isolation on Pages
  const tokenizer = new WordPieceTokenizer(
    JSON.parse(new TextDecoder().decode(buffers.tokenizer)),
  );
  const labels = JSON.parse(new TextDecoder().decode(buffers.tags));
  const eng = new NeuralEngine(ort, tokenizer, labels);
  await eng.init(buffers.model);
  return eng;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Fill `container` with text, wrapping each entity range in a span. */
function renderSpans(container, text, entities, cls) {
  container.textContent = "";
  let at = 0;
  for (const e of entities) {
    if (e.start > at) {
      container.appendChild(document.createTextNode(text.slice(at, e.start)));
    }
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = text.slice(e.start, e.end);
    container.appendChild(s);
    at = e.end;
  }
  if (at < text.length) {
    container.appendChild(document.createTextNode(text.slice(at)));
  }
  // A trailing newline collapses the mirror's last line box; give it
  // something to hold so the highlight stays glued to the textarea.
  if (text.endsWith("\n")) container.appendChild(document.createTextNode(" "));
}

// Found-line vocabulary: the model's three name sub-labels are one
// kind of thing to a reader, so they group as NAME. Everything else
// shows the engine's own label (a ZIP hit on a log-line port number
// is a ZIP rule hit, and the line says so).
const DISPLAY_LABEL = (label) => (label.startsWith("NAME_") ? "NAME" : label);

function renderFound(entities) {
  found.textContent = "";
  const total = document.createElement("span");
  total.className = "f";
  const b = document.createElement("b");
  b.textContent = String(entities.length);
  total.append(b, document.createTextNode(" entities found"));
  found.appendChild(total);
  const counts = new Map();
  for (const e of entities) {
    const k = DISPLAY_LABEL(e.label);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const [label, n] of [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )) {
    const chip = document.createElement("span");
    chip.className = "f";
    chip.textContent = n > 1 ? `${label} ×${n}` : label;
    found.appendChild(chip);
  }
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

let lastRedacted = "";
let runSeq = 0;

async function run() {
  const seq = ++runSeq;
  const text = input.value;
  if (!text) {
    lastRedacted = "";
    output.textContent = "";
    mirror.textContent = "";
    outLab.textContent = "Redacted";
    renderFound([]);
    return;
  }
  const t0 = performance.now();
  // Ungated neural spans; scanAll's score gate applies the threshold,
  // mirroring the extension's offscreen scan path.
  const neural = engine ? await engine.predict(text, 0) : [];
  if (seq !== runSeq) return; // a newer run owns the panes now
  const result = scanAll(text, neural, { threshold: GLOBAL_THRESHOLD });
  const ms = performance.now() - t0;
  lastRedacted = result.redacted;
  renderSpans(output, text, result.entities, "bar");
  renderSpans(mirror, text, result.entities, "mark");
  outLab.textContent = `Redacted — ${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  renderFound(result.entities);
}

const debounce = (fn, wait) => {
  let h;
  return (...args) => {
    clearTimeout(h);
    h = setTimeout(() => fn(...args), wait);
  };
};
const runDebounced = debounce(run, 300);

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function selectChip(name) {
  for (const chip of chips) {
    const key = Object.keys(SAMPLES).find((k) =>
      chip.dataset.phProps?.includes(`"${k}"`),
    );
    chip.classList.toggle("on", key === name);
  }
}

for (const chip of chips) {
  chip.addEventListener("click", () => {
    const name = Object.keys(SAMPLES).find((k) =>
      chip.dataset.phProps?.includes(`"${k}"`),
    );
    if (!name) return;
    input.value = SAMPLES[name];
    title.textContent = SAMPLE_TITLES[name];
    selectChip(name);
    run();
  });
}

input.addEventListener("input", () => {
  title.textContent = "Your text";
  selectChip(null);
  runDebounced();
});
input.addEventListener("scroll", () => {
  mirror.style.transform = `translateY(${-input.scrollTop}px)`;
});

copyBtn.addEventListener("click", async () => {
  if (!lastRedacted) return;
  try {
    await navigator.clipboard.writeText(lastRedacted);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = lastRedacted;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  const old = copyBtn.textContent;
  copyBtn.textContent = "Copied";
  setTimeout(() => (copyBtn.textContent = old), 1200);
});

clearBtn.addEventListener("click", () => {
  input.value = "";
  title.textContent = "Your text";
  selectChip(null);
  run();
  input.focus();
});

// ---------------------------------------------------------------------------
// Boot: /demo is a single-purpose page — the model is its function —
// so loading starts with the page rather than taxing the first
// keystroke with a 12 MB download. Progress is reported truthfully
// in the panel's status indicator.
// ---------------------------------------------------------------------------

(async () => {
  try {
    engine = await initEngine();
    status.textContent = "Running locally";
  } catch (err) {
    engineFailed = true;
    status.textContent = "Rules only — model failed to load";
    console.error("phi-redact model failed to initialize:", err);
  }
  run();
})();
