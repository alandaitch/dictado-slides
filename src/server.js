import express from "express";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { runTurn } from "./agent.js";
import { readAuthSync } from "./codex-auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3211);

const state = {
  slides: [],
  history: [],
  isProcessing: false,
  pendingTranscript: "",
};

function currentSlide() {
  if (!state.slides.length) return null;
  const i = state.slides.length - 1;
  return { ...state.slides[i], index: i };
}

function broadcast(wss, msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

const VALID_LAYOUTS = new Set(["bullets", "cover", "stat", "quote", "split"]);
function sanitizeLayout(value) {
  return VALID_LAYOUTS.has(value) ? value : "bullets";
}

function applyToolCall(call) {
  if (call.name === "nueva_slide") {
    const slide = {
      id: `s${Date.now()}-${state.slides.length}`,
      titulo: call.args.titulo,
      bullets: Array.isArray(call.args.bullets) ? call.args.bullets : [],
      icon: typeof call.args.icon === "string" ? call.args.icon.trim() : "",
      emoji: typeof call.args.emoji === "string" ? call.args.emoji.trim().slice(0, 8) : "",
      layout: sanitizeLayout(call.args.layout),
      createdAt: Date.now(),
    };
    state.slides.push(slide);
    return { type: "slide:new", slide, index: state.slides.length - 1, total: state.slides.length };
  }
  if (call.name === "agregar_bullet") {
    if (!state.slides.length) return null;
    const i = state.slides.length - 1;
    const slide = state.slides[i];
    const incoming = Array.isArray(call.args.bullets) ? call.args.bullets : [];
    slide.bullets = [...slide.bullets, ...incoming].slice(0, 5);
    if (typeof call.args.icon === "string" && call.args.icon.trim()) {
      slide.icon = call.args.icon.trim();
    }
    if (typeof call.args.emoji === "string" && call.args.emoji.trim()) {
      slide.emoji = call.args.emoji.trim().slice(0, 8);
    }
    if (typeof call.args.layout === "string" && VALID_LAYOUTS.has(call.args.layout)) {
      slide.layout = call.args.layout;
    }
    return { type: "slide:update", slide, index: i, total: state.slides.length };
  }
  return { type: "wait", reason: call.args?.razon || "esperando" };
}

async function processTranscript(wss, transcript) {
  if (!transcript.trim()) return;
  if (state.isProcessing) {
    state.pendingTranscript = `${state.pendingTranscript} ${transcript}`.trim();
    return;
  }
  state.isProcessing = true;
  broadcast(wss, { type: "agent:thinking", on: true });
  console.log(`[transcript] ${transcript}`);
  try {
    const t0 = Date.now();
    const { calls } = await runTurn({
      transcript,
      currentSlide: currentSlide(),
      history: state.history,
    });
    console.log(`[agent] ${Date.now() - t0}ms — ${calls.map((c) => c.name).join(",") || "no-calls"}`);
    for (const call of calls) {
      const event = applyToolCall(call);
      if (event) broadcast(wss, event);
    }
    state.history.push(
      { role: "user", content: transcript },
      {
        role: "assistant",
        content: calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(" "),
      },
    );
    if (state.history.length > 20) state.history = state.history.slice(-20);
  } catch (err) {
    console.error("[agent] error:", err);
    broadcast(wss, { type: "error", message: String(err?.message || err) });
  } finally {
    broadcast(wss, { type: "agent:thinking", on: false });
    state.isProcessing = false;
    if (state.pendingTranscript) {
      const next = state.pendingTranscript;
      state.pendingTranscript = "";
      processTranscript(wss, next);
    }
  }
}

function resetState(wss) {
  state.slides = [];
  state.history = [];
  state.pendingTranscript = "";
  broadcast(wss, { type: "reset" });
}

function buildApp(wss) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use(express.static(join(__dirname, "..", "public")));

  app.get("/api/health", (_req, res) => {
    const auth = readAuthSync();
    res.json({
      ok: true,
      auth: auth ? { hasAccount: Boolean(auth.accountId) } : null,
      slides: state.slides.length,
    });
  });

  app.post("/api/transcript", async (req, res) => {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ ok: false, error: "empty" });
    res.json({ ok: true });
    processTranscript(wss, text);
  });

  app.post("/api/reset", (_req, res) => {
    resetState(wss);
    res.json({ ok: true });
  });

  app.get("/api/state", (_req, res) => {
    res.json({ slides: state.slides });
  });

  return app;
}

export function startServer({ port = PORT } = {}) {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  const app = buildApp(wss);
  httpServer.on("request", app);

  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "hello", slides: state.slides }));
    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg?.type === "transcript" && typeof msg.text === "string") {
        processTranscript(wss, msg.text.trim());
      } else if (msg?.type === "reset") {
        resetState(wss);
      }
    });
  });

  return new Promise((resolve) => {
    httpServer.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${port}`;
      console.log(`dictado-slides escuchando en ${url}`);
      resolve({ url, httpServer, wss, app });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
