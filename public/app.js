const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("statusText");
const startBtn = document.getElementById("startBtn");
const resetBtn = document.getElementById("resetBtn");
const slideFrame = document.getElementById("slideFrame");
const stripEl = document.getElementById("strip");
const transcriptText = document.getElementById("transcriptText");
const modelSelect = document.getElementById("modelSelect");

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
  slideFrame.innerHTML = renderLayoutHTML(s, idx);
  for (const slot of slideFrame.querySelectorAll("[data-icon]")) {
    const name = slot.dataset.icon;
    if (name) renderIconInto(slot, name);
  }
  activeSlideIdx = idx;
  renderStrip();
}

function splitTitleForSplitLayout(t) {
  // Split "X vs Y" / "antes y ahora" into two labels. Falls back gracefully.
  const m = t.match(/^(.+?)\s+(?:vs|versus|v\/s|y|contra|frente a)\s+(.+)$/i);
  if (m) return [m[1].trim(), m[2].trim()];
  // Fallback: use title as the header for both sides.
  return [t, ""];
}

function renderLayoutHTML(s, idx) {
  const layout = s.layout || "bullets";
  const t = escapeHtml(s.titulo || "");
  const b = (s.bullets || []).map(escapeHtml);
  const icon = s.icon ? escapeHtml(s.icon) : "";
  const meta = `<div class="slide-meta">${idx + 1} / ${slides.length}</div>`;

  if (layout === "cover") {
    const subtitle = b[0] ? `<div class="cover-subtitle">${b[0]}</div>` : "";
    const iconSlot = icon ? `<div class="cover-icon" data-icon="${icon}"></div>` : "";
    return `<div class="slide entering layout-cover">
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
    // Auto-shrink for long stat strings. Up to ~6 chars get the full XL size.
    const lenClass =
      num.length <= 4 ? "len-xs" : num.length <= 7 ? "len-sm" : num.length <= 12 ? "len-md" : "len-lg";
    return `<div class="slide entering layout-stat">
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
    const quote = b[0] || t;
    const attr = b[0] ? t : "";
    return `<div class="slide entering layout-quote">
      <div class="quote-mark" data-icon="quote"></div>
      <p class="quote-text">${quote}</p>
      ${attr ? `<div class="quote-attr">— ${attr}</div>` : ""}
      ${meta}
    </div>`;
  }

  if (layout === "split") {
    const [leftLabel, rightLabel] = splitTitleForSplitLayout(s.titulo || "");
    const left = b[0] || "";
    const right = b[1] || "";
    const iconSlot = icon ? `<div class="split-icon" data-icon="${icon}"></div>` : "";
    return `<div class="slide entering layout-split">
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

  // Default: bullets — title + bullets on left, big icon on right.
  const bullets = b.map((x, i) => `<li style="animation-delay:${i * 80}ms">${x}</li>`).join("");
  const iconSlot = icon ? `<div class="bullets-icon" data-icon="${icon}"></div>` : "";
  return `<div class="slide entering layout-bullets">
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
  ws.send(JSON.stringify({ type: "transcript", text }));
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

async function init() {
  // Restore previously selected model.
  const savedModel = localStorage.getItem("dictado.model");
  if (savedModel && [...modelSelect.options].some((o) => o.value === savedModel)) {
    modelSelect.value = savedModel;
  }
  modelSelect.addEventListener("change", () => switchModel(modelSelect.value));

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
