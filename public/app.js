const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("statusText");
const startBtn = document.getElementById("startBtn");
const resetBtn = document.getElementById("resetBtn");
const slideFrame = document.getElementById("slideFrame");
const stripEl = document.getElementById("strip");
const transcriptText = document.getElementById("transcriptText");

let ws;
let vad;
let transcriber;
let isRecording = false;
let micStream;
const slides = [];
let activeSlideIdx = -1;

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
  const bullets = s.bullets.map((b, i) => `<li style="animation-delay:${i * 80}ms">${escapeHtml(b)}</li>`).join("");
  slideFrame.innerHTML = `
    <div class="slide entering">
      <h2>${escapeHtml(s.titulo)}</h2>
      ${bullets ? `<ul>${bullets}</ul>` : ""}
      <div class="slide-meta">${idx + 1} / ${slides.length}</div>
    </div>`;
  activeSlideIdx = idx;
  renderStrip();
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

async function loadTranscriber() {
  setStatus("cargando whisper…");
  const { pipeline, env } = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5/+esm");
  env.allowLocalModels = false;
  const device = navigator.gpu ? "webgpu" : "wasm";
  setStatus(`cargando whisper (${device})…`);
  transcriber = await pipeline("automatic-speech-recognition", "onnx-community/whisper-base", {
    device,
    dtype: device === "webgpu" ? "fp32" : "q8",
    progress_callback: (p) => {
      if (p.status === "progress" && typeof p.progress === "number") {
        setStatus(`bajando ${p.file || "modelo"} ${Math.round(p.progress)}%`);
      }
    },
  });
  setStatus("listo", "");
}

// Custom energy-based VAD using an AudioWorklet. No ONNX, no model download,
// no dependency conflicts with transformers.js. Tradeoff: less accurate than
// Silero in noisy rooms, but rock-solid in clean recording environments.
class EnergyVoiceDetector {
  constructor({ onSpeechStart, onSpeechEnd, onMisfire }) {
    this.onSpeechStart = onSpeechStart;
    this.onSpeechEnd = onSpeechEnd;
    this.onMisfire = onMisfire;
    this.threshold = 0.012;       // RMS threshold for "voice"
    this.silenceMs = 700;         // ms of silence to finalize a turn
    this.minSpeechMs = 350;       // min duration to count as a real speech turn
    this.audioCtx = null;
    this.node = null;
    this.stream = null;
    this.source = null;
    this.buffer = [];             // Float32Array chunks captured during speech
    this.bufferSeconds = 0;
    this.speaking = false;
    this.lastVoiceTs = 0;
    this.speechStartTs = 0;
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
    this.bufferSeconds = 0;
    this.speaking = false;
  }

  _onFrame({ rms, samples }) {
    if (!this.running) return;
    const now = performance.now();
    const isVoice = rms > this.threshold;

    if (this.speaking) {
      this.buffer.push(samples);
      this.bufferSeconds += samples.length / this.sampleRate;
      if (isVoice) {
        this.lastVoiceTs = now;
      } else if (now - this.lastVoiceTs > this.silenceMs) {
        // Finalize this turn.
        const totalMs = now - this.speechStartTs;
        const chunks = this.buffer;
        this.buffer = [];
        this.bufferSeconds = 0;
        this.speaking = false;
        if (totalMs < this.minSpeechMs) {
          this.onMisfire?.();
        } else {
          const merged = this._merge(chunks);
          this.onSpeechEnd?.(merged);
        }
      }
    } else if (isVoice) {
      this.speaking = true;
      this.speechStartTs = now;
      this.lastVoiceTs = now;
      this.buffer = [samples];
      this.bufferSeconds = samples.length / this.sampleRate;
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

async function loadVAD() {
  vad = new EnergyVoiceDetector({
    onSpeechStart: () => setStatus("escuchando", "live"),
    onSpeechEnd: async (audio) => {
      setStatus("transcribiendo…", "thinking");
      try {
        const result = await transcriber(audio, {
          language: "spanish",
          task: "transcribe",
          chunk_length_s: 30,
          stride_length_s: 5,
        });
        const text = (result?.text || "").trim();
        if (text) {
          transcriptText.textContent = text;
          sendTranscript(text);
        } else {
          setStatus("escuchando", "live");
        }
      } catch (err) {
        console.error("[whisper]", err);
        setStatus(`error stt: ${err.message}`, "error");
      }
    },
    onMisfire: () => setStatus("escuchando", "live"),
  });
  // Don't request mic yet — only when user clicks "empezar".
}

async function init() {
  try {
    await fetch("/api/reset", { method: "POST" }).catch(() => {});
    await connectWS();
  } catch (err) {
    console.error(err);
    setStatus(`error ws: ${err.message}`, "error");
    return;
  }
  try {
    await loadVAD(); // sync now, no model download
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
    const result = await transcriber(audio, {
      language: "spanish",
      task: "transcribe",
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const ms = Math.round(performance.now() - t0);
    const text = (result?.text || "").trim();
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
  const result = await transcriber(audio, {
    language: "spanish",
    task: "transcribe",
    chunk_length_s: 30,
    stride_length_s: 5,
  });
  const ms = Math.round(performance.now() - t0);
  const text = (result?.text || "").trim();
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
