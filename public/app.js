const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("statusText");
const startBtn = document.getElementById("startBtn");
const resetBtn = document.getElementById("resetBtn");
const slideFrame = document.getElementById("slideFrame");
const stripEl = document.getElementById("strip");
const transcriptText = document.getElementById("transcriptText");
const modelSelect = document.getElementById("modelSelect");
const themeSelect = document.getElementById("themeSelect");
const imagesToggle = document.getElementById("imagesToggle");

function getImagesEnabled() {
  return imagesToggle.checked;
}

function getCustomInstructions() {
  return localStorage.getItem("dictado.customInstructions") || "";
}

const PRESET_THEMES = ["default", "mono", "cyber", "sunset", "paper"];
const ALL_PRESET_CLASSES = PRESET_THEMES.map((x) => `theme-${x}`);

// ---------- Color helpers (no library) ----------
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, "0")).join("");
}
function mix(hexA, hexB, t) {
  const [a, b] = [hexToRgb(hexA), hexToRgb(hexB)];
  return rgbToHex(a.map((x, i) => x + (b[i] - x) * t));
}
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => c / 255);
  const f = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function isDark(hex) {
  return luminance(hex) < 0.35;
}

// Given the 4 user-chosen colors, derive every CSS var the theme system needs.
function deriveThemeVars({ bg, fg, accent, accent2 }) {
  const dark = isDark(bg);
  const bg2 = dark ? mix(bg, "#ffffff", 0.05) : mix(bg, "#000000", 0.04);
  const fgDim = mix(fg, bg, 0.45);
  const border = dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)";
  const titleStart = fg;
  const titleEnd = mix(fg, bg, 0.3);
  return {
    "--bg": bg,
    "--bg-2": bg2,
    "--fg": fg,
    "--fg-dim": fgDim,
    "--accent": accent,
    "--accent-2": accent2,
    "--border": border,
    "--title-grad-start": titleStart,
    "--title-grad-end": titleEnd,
    "--stat-grad-start": accent,
    "--stat-grad-end": accent2,
    "--bullet-fg": dark ? mix(fg, "#000000", 0.05) : mix(fg, "#000000", 0.1),
  };
}

// ---------- Theme application ----------
function applyTheme(spec) {
  // Clear both preset class AND inline vars.
  document.body.classList.remove(...ALL_PRESET_CLASSES);
  for (const v of [
    "--bg", "--bg-2", "--fg", "--fg-dim", "--accent", "--accent-2",
    "--border", "--title-grad-start", "--title-grad-end",
    "--stat-grad-start", "--stat-grad-end", "--bullet-fg",
  ]) document.body.style.removeProperty(v);

  if (typeof spec === "string" && PRESET_THEMES.includes(spec)) {
    document.body.classList.add(`theme-${spec}`);
    return spec;
  }
  // Custom theme — spec is { id, name, colors: { bg, fg, accent, accent2 } }
  if (spec && spec.colors) {
    const vars = deriveThemeVars(spec.colors);
    for (const [k, v] of Object.entries(vars)) document.body.style.setProperty(k, v);
    return spec.id;
  }
  document.body.classList.add("theme-default");
  return "default";
}

// ---------- Custom theme store ----------
const CUSTOM_KEY = "dictado.customThemes";
function loadCustomThemes() {
  try {
    const arr = JSON.parse(localStorage.getItem(CUSTOM_KEY) || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveCustomThemes(arr) {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(arr));
}
function findTheme(id) {
  if (PRESET_THEMES.includes(id)) return id;
  return loadCustomThemes().find((t) => t.id === id) || null;
}

let ws;
let vad;
let transcriber;
let isRecording = false;
let micStream;
let lucideMod;
const slides = [];
let activeSlideIdx = -1;

// Picked empirically — q8 on base/small produces token-loop garbage in Spanish
// on WebGPU, so we keep them at fp32 there. Turbo's huge enough to need q4.
const MODEL_DTYPES = {
  "onnx-community/whisper-large-v3-turbo": (hasGPU) =>
    hasGPU
      ? { encoder_model: "fp16", decoder_model_merged: "q4" }
      : { encoder_model: "q8", decoder_model_merged: "q4" },
  "onnx-community/whisper-small": (hasGPU) => (hasGPU ? "fp32" : "q8"),
  "onnx-community/whisper-base": (hasGPU) => (hasGPU ? "fp32" : "q8"),
};

function kebabToPascal(name) {
  return name
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

let lucideKeys = []; // PascalCase, cached after load

async function ensureLucide() {
  if (lucideMod) return lucideMod;
  lucideMod = await import("https://cdn.jsdelivr.net/npm/lucide@0.469.0/+esm");
  lucideKeys = Object.keys(lucideMod.icons || {});
  return lucideMod;
}

// Look up an icon by an arbitrary string from the agent. Strategy:
// 1) Exact PascalCase from kebab-case input
// 2) Find icons containing ALL tokens (case-insensitive substring)
// 3) Find icons containing ANY token
// Among multiple candidates, prefer shortest name (more "canonical").
function findLucideIcon(name) {
  if (!name || !lucideMod) return null;
  const exact = lucideMod.icons[kebabToPascal(name)];
  if (exact) return exact;
  const tokens = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  if (!tokens.length) return null;
  const lowerKeys = lucideKeys.map((k) => [k, k.toLowerCase()]);
  const allMatch = [];
  const anyMatch = [];
  for (const [k, lk] of lowerKeys) {
    const matched = tokens.filter((t) => lk.includes(t)).length;
    if (matched === tokens.length) allMatch.push({ k, len: k.length });
    else if (matched > 0) anyMatch.push({ k, len: k.length, matched });
  }
  if (allMatch.length) {
    allMatch.sort((a, b) => a.len - b.len);
    return lucideMod.icons[allMatch[0].k];
  }
  if (anyMatch.length) {
    anyMatch.sort((a, b) => b.matched - a.matched || a.len - b.len);
    return lucideMod.icons[anyMatch[0].k];
  }
  return null;
}

function renderIconInto(el, iconName) {
  if (!el || !iconName || !lucideMod) return;
  const data = findLucideIcon(iconName);
  if (!data) {
    el.innerHTML = "";
    return;
  }
  try {
    const svg = lucideMod.createElement(data);
    el.innerHTML = "";
    el.appendChild(svg);
  } catch {
    el.innerHTML = "";
  }
}

function setStatus(text, mode = "") {
  statusTextEl.textContent = text;
  statusEl.className = `status ${mode}`;
  const dot = document.querySelector(".dot");
  if (dot) dot.className = `dot ${mode === "live" ? "live" : mode === "thinking" ? "thinking" : ""}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Wrap each word of a title in a span with staggered animation delay so the
// title reveals word-by-word on slide entry. Spaces preserved as plain text.
function wrapWords(text) {
  const parts = String(text).split(/(\s+)/);
  let wordIdx = 0;
  return parts
    .map((p) => {
      if (!p.trim()) return p;
      const delay = wordIdx * 55;
      wordIdx++;
      return `<span class="word" style="animation-delay:${delay}ms">${escapeHtml(p)}</span>`;
    })
    .join("");
}

const SLIDE_BG = '<div class="slide-bg"></div>';
const SLIDE_SPARKLE = '<div class="slide-sparkle"></div>';

// ---------- Image resolver: proxied through our server (no browser CORS) ----------
// Frinkiac / Morbotron / Reddit don't ship CORS headers, so we ask the Node
// server to do the actual cross-origin search and return just the image URL.
// The <img> tag can then load the image directly — CORS doesn't apply to img
// elements rendering.
const imageCache = new Map();
const imagePending = new Map();

async function resolveImage(keyword, subreddit = "", fuente = "") {
  if (!keyword) return null;
  const cacheKey = [fuente || "auto", subreddit || "-", keyword].join("::");
  if (imageCache.has(cacheKey)) return imageCache.get(cacheKey);
  if (imagePending.has(cacheKey)) return imagePending.get(cacheKey);
  const params = new URLSearchParams({ q: keyword });
  if (subreddit) params.set("sub", subreddit);
  if (fuente) params.set("fuente", fuente);
  const p = fetch(`/api/image-search?${params.toString()}`)
    .then((r) => r.json())
    .then((data) => data?.url || null)
    .then((u) => {
      imageCache.set(cacheKey, u || null);
      imagePending.delete(cacheKey);
      return u || null;
    })
    .catch(() => {
      imageCache.set(cacheKey, null);
      imagePending.delete(cacheKey);
      return null;
    });
  imagePending.set(cacheKey, p);
  return p;
}

function cachedImage(keyword, subreddit = "", fuente = "") {
  const k = [fuente || "auto", subreddit || "-", keyword].join("::");
  return imageCache.has(k) ? imageCache.get(k) : undefined;
}

// Append only the NEW bullets to the existing <ul> so previously rendered
// content doesn't re-animate. Returns true if patching handled the update.
function tryPatchExistingSlide(s, idx) {
  const slideEl = slideFrame.querySelector(".slide");
  if (!slideEl || slideEl.dataset.slideId !== s.id) return false;
  // Bail to full re-render if any non-bullet attribute changed.
  if (slideEl.dataset.slideIcon !== (s.icon || "") || slideEl.dataset.slideImagen !== (s.imagen || "") || slideEl.dataset.slideLayout !== (s.layout || "bullets")) {
    return false;
  }
  const ul = slideEl.querySelector("ul");
  const renderedCount = ul ? ul.children.length : 0;
  const targetCount = (s.bullets || []).length;
  if (targetCount <= renderedCount) {
    // Same or fewer bullets — nothing to do (edits to existing bullets aren't
    // supported by the agent today; if that changes we'd diff text here).
    const meta = slideEl.querySelector(".slide-meta");
    if (meta) meta.textContent = `${idx + 1} / ${slides.length}`;
    return true;
  }
  // We have new bullets to append. If no <ul> exists yet (layout had no
  // bullets initially), create one inside the right wrapper.
  let mountedUl = ul;
  if (!mountedUl) {
    const host =
      slideEl.querySelector(".bullets-content") ||
      slideEl.querySelector(".photo-content") ||
      slideEl.querySelector(".stat-side");
    if (!host) return false;
    mountedUl = document.createElement("ul");
    if (slideEl.classList.contains("layout-stat")) mountedUl.className = "stat-context";
    host.appendChild(mountedUl);
  }
  const newOnes = s.bullets.slice(renderedCount);
  for (let i = 0; i < newOnes.length; i++) {
    const li = document.createElement("li");
    li.textContent = newOnes[i];
    li.style.animationDelay = `${i * 80}ms`;
    li.classList.add("appended");
    mountedUl.appendChild(li);
  }
  slideEl.dataset.bulletCount = String(targetCount);
  const meta = slideEl.querySelector(".slide-meta");
  if (meta) meta.textContent = `${idx + 1} / ${slides.length}`;
  return true;
}

function renderSlide(idx) {
  if (idx < 0 || idx >= slides.length) {
    slideFrame.innerHTML = `
      <div class="slide empty">
        <h1>Apretá <em>empezar</em> y hablá.</h1>
        <p class="hint">cada vez que hagas una pausa, el modelo decide si extiende la slide o crea una nueva. también podés subir un audio con <em>audio…</em>.</p>
      </div>`;
    return;
  }
  const s = slides[idx];

  // Try patch-only update first (saves re-animating the whole slide).
  if (activeSlideIdx === idx && tryPatchExistingSlide(s, idx)) {
    renderStrip();
    return;
  }

  slideFrame.innerHTML = renderLayoutHTML(s, idx);
  const slideEl = slideFrame.querySelector(".slide");
  if (slideEl) {
    slideEl.dataset.slideId = s.id;
    slideEl.dataset.slideIcon = s.icon || "";
    slideEl.dataset.slideImagen = s.imagen || "";
    slideEl.dataset.slideLayout = s.layout || "bullets";
    slideEl.dataset.bulletCount = String((s.bullets || []).length);
  }
  for (const slot of slideFrame.querySelectorAll("[data-icon]")) {
    const name = slot.dataset.icon;
    if (name) renderIconInto(slot, name);
  }
  activeSlideIdx = idx;
  renderStrip();

  // Resolve image on first render of this slide; on completion swap the
  // placeholder for a real <img>, or fall back to the slide's icon if the
  // search returned nothing / the image fails to load. Skip when images
  // are disabled in the toggle.
  if (s.imagen && getImagesEnabled() && cachedImage(s.imagen, s.subreddit, s.fuente) === undefined) {
    resolveImage(s.imagen, s.subreddit || "", s.fuente || "").then((url) => {
      if (activeSlideIdx !== idx) return;
      const wrap = slideFrame.querySelector(".slide-image");
      if (!wrap) return;
      if (url) {
        wrap.classList.remove("is-loading", "img-not-found", "img-icon-fallback");
        // If the actual image fails to load, fall back to icon as well.
        wrap.innerHTML = `<img alt="${escapeHtml(s.imagen)}" src="${escapeHtml(url)}" referrerpolicy="no-referrer" />`;
        const imgEl = wrap.querySelector("img");
        if (imgEl) {
          imgEl.addEventListener("error", () => fallbackToIcon(wrap, s));
        }
      } else {
        fallbackToIcon(wrap, s);
      }
    });
  }
}

// Replace the photo area with a big icon (or, if no icon, a placeholder).
// Keeps the photo layout intact so text alignment doesn't reflow.
function fallbackToIcon(wrap, s) {
  wrap.classList.remove("is-loading");
  if (s.icon) {
    wrap.classList.add("img-icon-fallback");
    wrap.classList.remove("img-not-found");
    wrap.innerHTML = `<div class="fallback-icon-slot" data-icon="${escapeHtml(s.icon)}"></div>`;
    const slot = wrap.querySelector(".fallback-icon-slot");
    if (slot) renderIconInto(slot, s.icon);
  } else {
    wrap.classList.add("img-not-found");
  }
}

function splitTitleForSplitLayout(t) {
  // Split "X vs Y" / "antes y ahora" into two labels. Falls back gracefully.
  const m = t.match(/^(.+?)\s+(?:vs|versus|v\/s|y|contra|frente a)\s+(.+)$/i);
  if (m) return [m[1].trim(), m[2].trim()];
  // Fallback: use title as the header for both sides.
  return [t, ""];
}

function imageHTML(keyword, subreddit = "", fuente = "") {
  if (!keyword) return "";
  const cached = cachedImage(keyword, subreddit, fuente);
  if (cached) {
    return `<div class="slide-image">
      <img alt="${escapeHtml(keyword)}" src="${escapeHtml(cached)}" referrerpolicy="no-referrer" />
    </div>`;
  }
  if (cached === null) {
    return `<div class="slide-image img-not-found"></div>`;
  }
  // Not yet resolved — placeholder. The renderSlide will swap in <img> when ready.
  return `<div class="slide-image is-loading"></div>`;
}

function renderLayoutHTML(s, idx) {
  const imagesOn = getImagesEnabled();
  // When the user turns off images, treat the slide as if it never had one.
  // photo layout falls back to bullets layout for graceful rendering.
  const effectiveImagen = imagesOn ? s.imagen : "";
  const layout = (!imagesOn && s.layout === "photo") ? "bullets" : (s.layout || "bullets");
  const tRaw = escapeHtml(s.titulo || "");
  const t = wrapWords(s.titulo || "");
  const b = (s.bullets || []).map(escapeHtml);
  const icon = s.icon ? escapeHtml(s.icon) : "";
  const meta = `<div class="slide-meta">${idx + 1} / ${slides.length}</div>`;

  if (layout === "photo") {
    const bullets = b.length
      ? `<ul>${b.map((x, i) => `<li style="animation-delay:${i * 80}ms">${x}</li>`).join("")}</ul>`
      : "";
    return `<div class="slide entering layout-photo">
      ${SLIDE_BG}
      ${imageHTML(effectiveImagen, s.subreddit || "", s.fuente || "")}
      <div class="photo-content">
        <h2>${t}</h2>
        ${bullets}
      </div>
      ${meta}
    </div>`;
  }

  if (layout === "cover") {
    const subtitle = b[0] ? `<div class="cover-subtitle">${b[0]}</div>` : "";
    const iconSlot = icon ? `<div class="cover-icon" data-icon="${icon}"></div>` : "";
    return `<div class="slide entering layout-cover">
      ${SLIDE_BG}${SLIDE_SPARKLE}
      ${iconSlot}
      <h2>${t}</h2>
      ${subtitle}
      ${meta}
    </div>`;
  }

  if (layout === "stat") {
    const num = b[0] || "?";
    const rest = b.slice(1);
    const restList = rest.length
      ? `<ul class="stat-context">${rest.map((x, i) => `<li style="animation-delay:${i * 80}ms">${x}</li>`).join("")}</ul>`
      : "";
    const iconSlot = icon ? `<div class="stat-icon" data-icon="${icon}"></div>` : "";
    const lenClass =
      num.length <= 4 ? "len-xs" : num.length <= 7 ? "len-sm" : num.length <= 12 ? "len-md" : "len-lg";
    return `<div class="slide entering layout-stat">
      ${SLIDE_BG}
      <div class="stat-num ${lenClass}">${escapeHtml(num)}</div>
      <div class="stat-side">
        ${iconSlot}
        <h2>${t}</h2>
        ${restList}
      </div>
      ${meta}
    </div>`;
  }

  if (layout === "quote") {
    const quoteText = s.bullets?.[0] ? wrapWords(s.bullets[0]) : t;
    const attrText = s.bullets?.[0] ? tRaw : "";
    return `<div class="slide entering layout-quote">
      ${SLIDE_BG}
      <div class="quote-mark" data-icon="quote"></div>
      <p class="quote-text">${quoteText}</p>
      ${attrText ? `<div class="quote-attr">— ${attrText}</div>` : ""}
      ${meta}
    </div>`;
  }

  if (layout === "split") {
    const [leftLabel, rightLabel] = splitTitleForSplitLayout(s.titulo || "");
    const left = b[0] || "";
    const right = b[1] || "";
    const iconSlot = icon ? `<div class="split-icon" data-icon="${icon}"></div>` : "";
    return `<div class="slide entering layout-split">
      ${SLIDE_BG}
      <div class="split-side">
        ${leftLabel ? `<div class="split-label">${escapeHtml(leftLabel)}</div>` : ""}
        <div class="split-text">${left}</div>
      </div>
      <div class="split-divider">${iconSlot}</div>
      <div class="split-side">
        ${rightLabel ? `<div class="split-label">${escapeHtml(rightLabel)}</div>` : ""}
        <div class="split-text">${right}</div>
      </div>
      ${meta}
    </div>`;
  }

  const bullets = b.map((x, i) => `<li style="animation-delay:${i * 80}ms">${x}</li>`).join("");
  const iconSlot = icon ? `<div class="bullets-icon" data-icon="${icon}"></div>` : "";
  return `<div class="slide entering layout-bullets">
    ${SLIDE_BG}
    <div class="bullets-content">
      <h2>${t}</h2>
      ${bullets ? `<ul>${bullets}</ul>` : ""}
    </div>
    ${iconSlot}
    ${meta}
  </div>`;
}

function renderStrip() {
  stripEl.innerHTML = slides
    .map((s, i) => `<div class="thumb ${i === activeSlideIdx ? "active" : ""}" data-idx="${i}">${i + 1}. ${escapeHtml(s.titulo)}</div>`)
    .join("");
  stripEl.querySelectorAll(".thumb").forEach((el) => {
    el.addEventListener("click", () => renderSlide(Number(el.dataset.idx)));
  });
  const active = stripEl.querySelector(".thumb.active");
  if (active) active.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
}

function applyEvent(msg) {
  if (msg.type === "slide:new") {
    slides.push(msg.slide);
    renderSlide(slides.length - 1);
  } else if (msg.type === "slide:update") {
    if (slides[msg.index]) {
      slides[msg.index] = msg.slide;
      if (activeSlideIdx === msg.index) renderSlide(msg.index);
      else renderStrip();
    }
  } else if (msg.type === "reset") {
    slides.length = 0;
    activeSlideIdx = -1;
    renderSlide(-1);
    stripEl.innerHTML = "";
    transcriptText.textContent = "—";
  } else if (msg.type === "agent:thinking") {
    if (msg.on) setStatus("pensando…", "thinking");
    else setStatus(isRecording ? "escuchando" : "listo", isRecording ? "live" : "");
  } else if (msg.type === "error") {
    setStatus(`error: ${msg.message}`, "error");
  } else if (msg.type === "hello") {
    if (Array.isArray(msg.slides) && msg.slides.length) {
      slides.push(...msg.slides);
      renderSlide(slides.length - 1);
    }
  }
}

function connectWS() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
    ws.onmessage = (e) => {
      try { applyEvent(JSON.parse(e.data)); } catch {}
    };
    ws.onclose = () => setStatus("desconectado", "error");
  });
}

function sendTranscript(text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: "transcript",
    text,
    imagesEnabled: getImagesEnabled(),
    customInstructions: getCustomInstructions(),
  }));
}

let transformersMod;
let moonshineMod;

async function loadMoonshineTranscriber(modelId) {
  // modelId looks like "moonshine:moonshine/base/es" → load from download.moonshine.ai
  const variant = modelId.replace(/^moonshine:/, "");
  const label = variant.replace(/^moonshine\//, "moonshine-").replace(/\//g, "-");
  setStatus(`cargando ${label}…`);
  if (!moonshineMod) {
    moonshineMod = await import(
      "https://cdn.jsdelivr.net/npm/@moonshine-ai/moonshine-js@latest/+esm"
    );
  }
  const model = new moonshineMod.MoonshineModel(variant);
  await model.loadModel();
  transcriber = async (audio /*, opts */) => {
    const text = await model.generate(audio);
    return { text: typeof text === "string" ? text : text?.text || "" };
  };
  transcriber.__provider = "moonshine";
  setStatus("listo", "");
}

async function loadTransformersTranscriber(modelId) {
  setStatus(`cargando ${modelId.split("/").pop()}…`);
  if (!transformersMod) {
    transformersMod = await import(
      "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5/+esm"
    );
    transformersMod.env.allowLocalModels = false;
  }
  const hasWebGPU = !!navigator.gpu;
  const device = hasWebGPU ? "webgpu" : "wasm";
  const dtypeFn = MODEL_DTYPES[modelId] || (() => "q8");
  const dtype = dtypeFn(hasWebGPU);
  setStatus(`cargando ${modelId.split("/").pop()} (${device})…`);
  const pipe = await transformersMod.pipeline(
    "automatic-speech-recognition",
    modelId,
    {
      device,
      dtype,
      progress_callback: (p) => {
        if (p.status === "progress" && typeof p.progress === "number") {
          setStatus(`bajando ${p.file || "modelo"} ${Math.round(p.progress)}%`);
        }
      },
    },
  );
  transcriber = async (audio /*, _opts */) =>
    pipe(audio, { language: "spanish", task: "transcribe" });
  transcriber.__provider = "transformers";
  setStatus("listo", "");
}

async function loadTranscriber(modelId) {
  modelId = modelId || modelSelect?.value || "onnx-community/whisper-large-v3-turbo";
  if (modelId.startsWith("moonshine:")) {
    await loadMoonshineTranscriber(modelId);
  } else {
    await loadTransformersTranscriber(modelId);
  }
}

async function switchModel(modelId) {
  if (!modelId || !transformersMod) return;
  const wasRecording = isRecording;
  if (wasRecording) {
    vad?.pause();
    isRecording = false;
    startBtn.textContent = "empezar";
    startBtn.classList.remove("recording");
  }
  startBtn.disabled = true;
  transcriber = undefined;
  try {
    await loadTranscriber(modelId);
    localStorage.setItem("dictado.model", modelId);
  } catch (err) {
    console.error("[switchModel]", err);
    setStatus(`error cambiando modelo: ${err.message}`, "error");
    return;
  }
  startBtn.disabled = false;
  if (wasRecording) {
    try {
      await vad.start();
      isRecording = true;
      startBtn.textContent = "pausar";
      startBtn.classList.add("recording");
      setStatus("escuchando", "live");
    } catch (err) {
      setStatus(`error mic: ${err.message}`, "error");
    }
  }
}

// Custom energy-based VAD using an AudioWorklet. No ONNX, no model download,
// no dependency conflicts with transformers.js. Tradeoff: less accurate than
// Silero in noisy rooms, but rock-solid in clean recording environments.
class EnergyVoiceDetector {
  constructor({ onSpeechStart, onChunk, onMisfire }) {
    this.onSpeechStart = onSpeechStart;
    this.onChunk = onChunk;       // fires on flush (silence OR forced periodic)
    this.onMisfire = onMisfire;
    this.threshold = 0.012;       // RMS threshold for "voice"
    this.silenceMs = 600;         // ms of silence to finalize on natural break
    this.minSpeechMs = 350;       // min duration to count as a real speech turn
    this.maxChunkMs = 6000;       // force flush after this much continuous speech (real-time feel)
    this.overlapMs = 250;         // carry over the tail of a mid-flush into the next chunk
    this.audioCtx = null;
    this.node = null;
    this.stream = null;
    this.source = null;
    this.buffer = [];             // Float32Array chunks captured during current chunk
    this.speaking = false;
    this.lastVoiceTs = 0;
    this.speechStartTs = 0;
    this.chunkStartTs = 0;
    this.running = false;
    this.sampleRate = 16000;
  }

  async start() {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 16000,
    });
    this.sampleRate = this.audioCtx.sampleRate;
    await this.audioCtx.audioWorklet.addModule("/vad-worklet.js");
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.audioCtx, "energy-vad");
    this.node.port.onmessage = (e) => this._onFrame(e.data);
    this.source.connect(this.node);
    // Don't connect node to destination (we don't want monitoring).
    this.running = true;
  }

  pause() {
    this.running = false;
    if (this.node) this.node.disconnect();
    if (this.source) this.source.disconnect();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.audioCtx) this.audioCtx.close();
    this.audioCtx = null;
    this.node = null;
    this.source = null;
    this.stream = null;
    this.buffer = [];
    this.speaking = false;
  }

  _onFrame({ rms, samples }) {
    if (!this.running) return;
    const now = performance.now();
    const isVoice = rms > this.threshold;

    if (this.speaking) {
      this.buffer.push(samples);
      if (isVoice) this.lastVoiceTs = now;

      const silenceLong = !isVoice && now - this.lastVoiceTs > this.silenceMs;
      const chunkTooLong = now - this.chunkStartTs > this.maxChunkMs;

      if (silenceLong || chunkTooLong) {
        const totalMs = now - this.speechStartTs;
        const chunks = this.buffer;
        const merged = this._merge(chunks);
        if (silenceLong) {
          this.speaking = false; // wait for next speech start
          this.buffer = [];
        } else {
          // Mid-flush: keep speaking, carry the tail of the chunk into the next
          // buffer so Whisper doesn't see a mid-word cut.
          const overlapSamples = Math.floor((this.overlapMs / 1000) * this.sampleRate);
          const tail = merged.length > overlapSamples ? merged.slice(merged.length - overlapSamples) : merged.slice();
          this.buffer = [tail];
          this.chunkStartTs = now;
        }
        if (totalMs < this.minSpeechMs) {
          this.onMisfire?.();
        } else {
          this.onChunk?.(merged, { final: silenceLong });
        }
      }
    } else if (isVoice) {
      this.speaking = true;
      this.speechStartTs = now;
      this.chunkStartTs = now;
      this.lastVoiceTs = now;
      this.buffer = [samples];
      this.onSpeechStart?.();
    }
  }

  _merge(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Float32Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

// Serialize transcriber calls — transformers.js pipelines aren't concurrent-safe
// and overlapping calls would queue at the WebGPU level anyway.
let transcribeChain = Promise.resolve();

function chunkEnergyDbfs(samples) {
  if (!samples?.length) return -100;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}

// Common Whisper hallucination patterns in Spanish (TTS / silence artifacts).
// If the whole transcription matches one of these (case-insensitive,
// punctuation-stripped), drop it.
const HALLUCINATION_PATTERNS = [
  /^suscr[ií]bete/i,
  /^gracias por ver/i,
  /^hola( ,)?( encantado)?/i,
  /^(hey|ey)[, ]/i,
  /^qu[eé] tal/i,
  /^subt[ií]tulos? (creados? )?por/i,
  /^muchas gracias\b\.?$/i,
];

function looksLikeHallucination(text) {
  const norm = text.replace(/[.,!?¿¡…]/g, "").trim();
  if (!norm) return true;
  if (norm.length < 5) return true;
  return HALLUCINATION_PATTERNS.some((re) => re.test(norm));
}

function enqueueTranscribe(audio) {
  const next = transcribeChain.then(async () => {
    const energyDb = chunkEnergyDbfs(audio);
    if (energyDb < -45) {
      console.log(`[stt] skipping silent chunk (${energyDb.toFixed(1)} dBFS)`);
      return "";
    }
    try {
      const result = await transcriber(audio);
      const text = (result?.text || "").trim();
      if (looksLikeHallucination(text)) {
        console.log(`[stt] discarded hallucination: "${text}"`);
        return "";
      }
      return text;
    } catch (err) {
      console.error("[stt]", err);
      return "";
    }
  });
  transcribeChain = next.catch(() => {});
  return next;
}

async function loadVAD() {
  vad = new EnergyVoiceDetector({
    onSpeechStart: () => setStatus("escuchando", "live"),
    onChunk: async (audio, { final }) => {
      setStatus(final ? "transcribiendo…" : "transcribiendo (mid)…", "thinking");
      const text = await enqueueTranscribe(audio);
      if (text) {
        transcriptText.textContent = text;
        sendTranscript(text);
      }
      setStatus(vad.speaking ? "escuchando" : "escuchando", "live");
    },
    onMisfire: () => setStatus("escuchando", "live"),
  });
  // Don't request mic yet — only when user clicks "empezar".
}

// ---------- Custom instructions modal ----------
const INSTR_PRESETS = {
  memes:
    "Sé GENEROSO con el campo `imagen` — buscá memes, screencaps de los Simpsons, Futurama o de Reddit cada vez que el contenido tenga la mínima referencia pop, humor, política, viralidad o tono emocional. Preferí layout 'photo' cuando uses imagen.",
  sober:
    "NO uses el campo `imagen` salvo que el orador EXPLÍCITAMENTE pida una imagen. Mantené las slides limpias y profesionales, solo iconos Lucide.",
  argentine:
    "El orador es argentino y habla sobre política, tech y cultura argentina. Para imágenes, priorizá subreddit 'argentina' o 'RepublicaArgentina'. Reconocé referencias locales (Milei, dólar, AFIP, asado, etc.) y agregales imágenes apropiadas.",
  clear: "",
};

const instructionsModal = document.getElementById("instructionsModal");
const instructionsBtn = document.getElementById("instructionsBtn");
const instructionsInput = document.getElementById("instructionsInput");
const instructionsSave = document.getElementById("instructionsSave");

function refreshInstructionsBadge() {
  instructionsBtn.classList.toggle("has-instructions", !!getCustomInstructions().trim());
}

function openInstructionsEditor() {
  instructionsInput.value = getCustomInstructions();
  instructionsModal.hidden = false;
  setTimeout(() => instructionsInput.focus(), 50);
}
function closeInstructionsEditor() { instructionsModal.hidden = true; }

instructionsBtn.addEventListener("click", openInstructionsEditor);
instructionsModal.addEventListener("click", (e) => {
  if (e.target.dataset && e.target.dataset.close !== undefined) closeInstructionsEditor();
  const preset = e.target.dataset?.preset;
  if (preset && Object.hasOwn(INSTR_PRESETS, preset)) {
    instructionsInput.value = INSTR_PRESETS[preset];
  }
});
instructionsSave.addEventListener("click", () => {
  const v = instructionsInput.value.trim();
  localStorage.setItem("dictado.customInstructions", v);
  refreshInstructionsBadge();
  closeInstructionsEditor();
});

// ---------- Theme modal (custom-theme editor) ----------
const themeModal = document.getElementById("themeModal");
const themeNameInput = document.getElementById("themeName");
const themeBgInput = document.getElementById("themeBg");
const themeFgInput = document.getElementById("themeFg");
const themeAccentInput = document.getElementById("themeAccent");
const themeAccent2Input = document.getElementById("themeAccent2");
const themePreview = document.getElementById("themePreview");
const themeSaveBtn = document.getElementById("themeSave");
const themeDeleteBtn = document.getElementById("themeDelete");
const modalTitle = document.getElementById("modalTitle");
const customGroup = document.getElementById("customGroup");

let editingId = null;

function updateThemePreview() {
  const vars = deriveThemeVars({
    bg: themeBgInput.value, fg: themeFgInput.value,
    accent: themeAccentInput.value, accent2: themeAccent2Input.value,
  });
  themePreview.style.setProperty("--preview-bg", vars["--bg"]);
  themePreview.style.setProperty("--preview-fg", vars["--fg"]);
  themePreview.style.setProperty("--preview-accent", vars["--accent"]);
  themePreview.style.setProperty("--preview-accent2", vars["--accent-2"]);
}
for (const el of [themeBgInput, themeFgInput, themeAccentInput, themeAccent2Input]) {
  el.addEventListener("input", updateThemePreview);
}

function openThemeEditor(existing = null) {
  if (existing) {
    editingId = existing.id;
    modalTitle.textContent = "editar tema";
    themeNameInput.value = existing.name;
    themeBgInput.value = existing.colors.bg;
    themeFgInput.value = existing.colors.fg;
    themeAccentInput.value = existing.colors.accent;
    themeAccent2Input.value = existing.colors.accent2;
    themeDeleteBtn.hidden = false;
  } else {
    editingId = null;
    modalTitle.textContent = "crear tema";
    themeNameInput.value = "";
    themeBgInput.value = "#0a0a0c";
    themeFgInput.value = "#f5f5f7";
    themeAccentInput.value = "#f97316";
    themeAccent2Input.value = "#fbbf24";
    themeDeleteBtn.hidden = true;
  }
  updateThemePreview();
  themeModal.hidden = false;
  setTimeout(() => themeNameInput.focus(), 50);
}
function closeThemeEditor() { themeModal.hidden = true; }

themeModal.addEventListener("click", (e) => {
  if (e.target.dataset && e.target.dataset.close !== undefined) closeThemeEditor();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !themeModal.hidden) closeThemeEditor();
});

themeSaveBtn.addEventListener("click", () => {
  const name = (themeNameInput.value || "sin nombre").trim().slice(0, 30);
  const colors = {
    bg: themeBgInput.value,
    fg: themeFgInput.value,
    accent: themeAccentInput.value,
    accent2: themeAccent2Input.value,
  };
  const customs = loadCustomThemes();
  if (editingId) {
    const idx = customs.findIndex((t) => t.id === editingId);
    if (idx >= 0) customs[idx] = { ...customs[idx], name, colors };
  } else {
    const id = `custom-${Date.now()}`;
    customs.push({ id, name, colors });
    editingId = id;
  }
  saveCustomThemes(customs);
  rebuildCustomGroup();
  themeSelect.value = editingId;
  const applied = applyTheme(customs.find((t) => t.id === editingId));
  localStorage.setItem("dictado.theme", editingId);
  closeThemeEditor();
});

themeDeleteBtn.addEventListener("click", () => {
  if (!editingId) return;
  const customs = loadCustomThemes().filter((t) => t.id !== editingId);
  saveCustomThemes(customs);
  if (localStorage.getItem("dictado.theme") === editingId) {
    localStorage.setItem("dictado.theme", "default");
    applyTheme("default");
    themeSelect.value = "default";
  }
  rebuildCustomGroup();
  closeThemeEditor();
});

function rebuildCustomGroup() {
  customGroup.innerHTML = "";
  for (const t of loadCustomThemes()) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = `tema · ${t.name}`;
    customGroup.appendChild(opt);
  }
}

async function init() {
  rebuildCustomGroup();

  // Restore theme (synchronous, before anything renders).
  const savedId = localStorage.getItem("dictado.theme") || "default";
  const spec = findTheme(savedId);
  const appliedId = applyTheme(spec || "default");
  themeSelect.value = spec ? savedId : "default";

  themeSelect.addEventListener("change", () => {
    const v = themeSelect.value;
    if (v === "__edit__") {
      // Don't change theme — open editor for new theme.
      themeSelect.value = localStorage.getItem("dictado.theme") || "default";
      openThemeEditor(null);
      return;
    }
    const sp = findTheme(v) || "default";
    const id = applyTheme(sp);
    localStorage.setItem("dictado.theme", typeof sp === "string" ? sp : sp.id);
  });

  // Double-click on a custom theme to edit it.
  themeSelect.addEventListener("dblclick", () => {
    const v = themeSelect.value;
    if (v.startsWith("custom-")) {
      const t = loadCustomThemes().find((x) => x.id === v);
      if (t) openThemeEditor(t);
    }
  });

  // Restore previously selected model.
  const savedModel = localStorage.getItem("dictado.model");
  if (savedModel && [...modelSelect.options].some((o) => o.value === savedModel)) {
    modelSelect.value = savedModel;
  }
  modelSelect.addEventListener("change", () => switchModel(modelSelect.value));

  // Restore images toggle (default off — opt-in).
  imagesToggle.checked = localStorage.getItem("dictado.images") === "1";
  refreshInstructionsBadge();
  imagesToggle.addEventListener("change", () => {
    localStorage.setItem("dictado.images", imagesToggle.checked ? "1" : "0");
    if (activeSlideIdx >= 0) renderSlide(activeSlideIdx);
  });

  try {
    await fetch("/api/reset", { method: "POST" }).catch(() => {});
    await connectWS();
  } catch (err) {
    console.error(err);
    setStatus(`error ws: ${err.message}`, "error");
    return;
  }
  try {
    await loadVAD(); // sync, no model download
    await ensureLucide();
    await loadTranscriber();
  } catch (err) {
    console.error("[init]", err);
    setStatus(`error: ${err.message}`, "error");
    return;
  }
  startBtn.disabled = false;
  setStatus("listo");
}

startBtn.addEventListener("click", async () => {
  if (!isRecording) {
    setStatus("pidiendo mic…");
    try {
      await vad.start();
      isRecording = true;
      startBtn.textContent = "pausar";
      startBtn.classList.add("recording");
      setStatus("escuchando", "live");
    } catch (err) {
      console.error("[mic]", err);
      setStatus(`error mic: ${err.message}`, "error");
    }
  } else {
    vad.pause();
    isRecording = false;
    startBtn.textContent = "empezar";
    startBtn.classList.remove("recording");
    setStatus("pausado");
  }
});

resetBtn.addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "reset" }));
});

// ---------- Fullscreen ----------
const fullscreenBtn = document.getElementById("fullscreenBtn");

function showFsHint() {
  const old = document.querySelector(".fs-hint");
  if (old) old.remove();
  const hint = document.createElement("div");
  hint.className = "fs-hint";
  hint.textContent = "← → para navegar · esc para salir";
  document.body.appendChild(hint);
  setTimeout(() => hint.remove(), 4000);
}

async function toggleFullscreen() {
  if (!document.fullscreenElement) {
    try {
      await document.documentElement.requestFullscreen();
      document.body.classList.add("fs");
      showFsHint();
    } catch (err) {
      console.error("[fs] error:", err);
    }
  } else {
    await document.exitFullscreen().catch(() => {});
    document.body.classList.remove("fs");
  }
}

document.addEventListener("fullscreenchange", () => {
  document.body.classList.toggle("fs", !!document.fullscreenElement);
});

fullscreenBtn.addEventListener("click", toggleFullscreen);

document.addEventListener("keydown", (e) => {
  if (themeModal && !themeModal.hidden) return;
  // Ignore when typing in any input.
  const tag = (e.target?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;

  if (e.key === "f" || e.key === "F") {
    toggleFullscreen();
  } else if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") {
    if (slides.length && activeSlideIdx < slides.length - 1) {
      renderSlide(activeSlideIdx + 1);
      e.preventDefault();
    }
  } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
    if (slides.length && activeSlideIdx > 0) {
      renderSlide(activeSlideIdx - 1);
      e.preventDefault();
    }
  } else if (e.key === "Home") {
    if (slides.length) renderSlide(0);
  } else if (e.key === "End") {
    if (slides.length) renderSlide(slides.length - 1);
  }
});

async function decodeAudioFileTo16k(file) {
  const buf = await file.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const decoded = await ctx.decodeAudioData(buf);
  const ch0 = decoded.getChannelData(0);
  if (decoded.sampleRate === 16000) return ch0;
  const ratio = decoded.sampleRate / 16000;
  const out = new Float32Array(Math.floor(ch0.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const idx = i * ratio;
    const lo = Math.floor(idx);
    const hi = Math.min(lo + 1, ch0.length - 1);
    out[i] = ch0[lo] + (ch0[hi] - ch0[lo]) * (idx - lo);
  }
  return out;
}

const audioInput = document.getElementById("audioInput");
audioInput.addEventListener("change", async () => {
  const file = audioInput.files?.[0];
  if (!file || !transcriber) return;
  setStatus(`decodificando ${file.name}…`, "thinking");
  try {
    const audio = await decodeAudioFileTo16k(file);
    setStatus(`transcribiendo ${file.name}… (${(audio.length / 16000).toFixed(1)}s)`, "thinking");
    const t0 = performance.now();
    const text = await enqueueTranscribe(audio);
    const ms = Math.round(performance.now() - t0);
    transcriptText.textContent = text || "(silencio)";
    if (text) sendTranscript(text);
    setStatus(`transcripción ok (${ms}ms)`, "");
  } catch (err) {
    console.error("[upload]", err);
    setStatus(`error: ${err.message}`, "error");
  } finally {
    audioInput.value = "";
  }
});

async function transcribeUrl(url) {
  const res = await fetch(url);
  const blob = await res.blob();
  const file = new File([blob], url.split("/").pop() || "audio", { type: blob.type });
  const audio = await decodeAudioFileTo16k(file);
  setStatus(`transcribiendo ${file.name}… (${(audio.length / 16000).toFixed(1)}s)`, "thinking");
  const t0 = performance.now();
  const text = await enqueueTranscribe(audio);
  const ms = Math.round(performance.now() - t0);
  transcriptText.textContent = text || "(silencio)";
  if (text) sendTranscript(text);
  setStatus(`transcribió en ${ms}ms`, "");
  return { text, ms };
}

window.__test = {
  send: sendTranscript,
  state: () => ({ slides, activeSlideIdx, isRecording }),
  getTranscriber: () => transcriber,
  getVad: () => vad,
  transcribeUrl,
};

init();
