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

// --- Meme/screencap image resolver (server-side; no CORS to worry about) ---
function pickRandomTop(arr, top = 5) {
  const slice = arr.slice(0, Math.min(top, arr.length));
  return slice[Math.floor(Math.random() * slice.length)];
}

async function frinkiacFamilyResolve(keyword, host) {
  const r = await fetch(`https://${host}/api/search?q=${encodeURIComponent(keyword)}`);
  if (!r.ok) return null;
  const data = await r.json();
  if (!Array.isArray(data) || !data.length) return null;
  const hit = pickRandomTop(data);
  return `https://${host}/img/${hit.Episode}/${hit.Timestamp}.jpg`;
}

async function redditMemeResolve(keyword, subreddit) {
  // If the agent named a specific subreddit, try it first, then fall back to
  // the generic chain. Sanitization guarantees this string is safe.
  const defaultSubs = ["memes", "wholesomememes", "reactiongifs", "AdviceAnimals"];
  const subs = subreddit ? [subreddit, ...defaultSubs.filter((s) => s !== subreddit)] : defaultSubs;
  for (const sub of subs) {
    try {
      const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(keyword)}&restrict_sr=1&sort=top&t=year&limit=20`;
      const r = await fetch(url, {
        headers: {
          // Reddit blocks unidentified bots; this UA passes their filter.
          "User-Agent": "dictado-slides/0.1 by /u/dictado-slides",
          Accept: "application/json",
        },
      });
      if (!r.ok) continue;
      const data = await r.json();
      const posts = (data?.data?.children || [])
        .map((c) => c.data)
        .filter(
          (p) =>
            p &&
            (p.post_hint === "image" || /\.(jpg|jpeg|png|gif|webp)$/i.test(p.url || "")) &&
            !p.over_18,
        );
      if (posts.length) return pickRandomTop(posts).url;
    } catch {
      // try next sub
    }
  }
  return null;
}

export async function resolveMemeImageUrl(keyword, subreddit) {
  const k = keyword.toLowerCase();
  if (/\b(simpson|homer|bart|lisa|marge|moe|burns|flanders|skinner|krusty|nelson|milhouse|apu)\b/.test(k)) {
    const stripped = keyword.replace(/\bsimpsons?\b/gi, "").trim() || keyword;
    return frinkiacFamilyResolve(stripped, "frinkiac.com");
  }
  if (/\b(futurama|fry|bender|leela|zoidberg|farnsworth|hermes|amy wong|nibbler)\b/.test(k)) {
    const stripped = keyword.replace(/\bfuturama\b/gi, "").trim() || keyword;
    return frinkiacFamilyResolve(stripped, "morbotron.com");
  }
  return redditMemeResolve(keyword, subreddit);
}

function broadcast(wss, msg) {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

const VALID_LAYOUTS = new Set(["bullets", "cover", "stat", "quote", "split", "photo"]);
function sanitizeLayout(value) {
  return VALID_LAYOUTS.has(value) ? value : "bullets";
}
function sanitizeSubreddit(value) {
  if (typeof value !== "string") return "";
  const s = value.trim().replace(/^r\//i, "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 30);
  return s;
}

function applyToolCall(call) {
  if (call.name === "nueva_slide") {
    const slide = {
      id: `s${Date.now()}-${state.slides.length}`,
      titulo: call.args.titulo,
      bullets: Array.isArray(call.args.bullets) ? call.args.bullets : [],
      icon: typeof call.args.icon === "string" ? call.args.icon.trim() : "",
      imagen: typeof call.args.imagen === "string" ? call.args.imagen.trim().slice(0, 120) : "",
      subreddit: sanitizeSubreddit(call.args.subreddit),
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
    if (typeof call.args.imagen === "string" && call.args.imagen.trim()) {
      slide.imagen = call.args.imagen.trim().slice(0, 120);
    }
    const subFromCall = sanitizeSubreddit(call.args.subreddit);
    if (subFromCall) slide.subreddit = subFromCall;
    if (typeof call.args.layout === "string" && VALID_LAYOUTS.has(call.args.layout)) {
      slide.layout = call.args.layout;
    }
    return { type: "slide:update", slide, index: i, total: state.slides.length };
  }
  return { type: "wait", reason: call.args?.razon || "esperando" };
}

async function processTranscript(wss, transcript, opts = {}) {
  if (!transcript.trim()) return;
  if (state.isProcessing) {
    state.pendingTranscript = `${state.pendingTranscript} ${transcript}`.trim();
    state.pendingOpts = opts;
    return;
  }
  state.isProcessing = true;
  broadcast(wss, { type: "agent:thinking", on: true });
  console.log(`[transcript] ${transcript} (images=${opts.imagesEnabled ? "on" : "off"})`);
  try {
    const t0 = Date.now();
    const { calls } = await runTurn({
      transcript,
      currentSlide: currentSlide(),
      history: state.history,
      imagesEnabled: opts.imagesEnabled !== false,
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
      const nextOpts = state.pendingOpts || {};
      state.pendingTranscript = "";
      state.pendingOpts = null;
      processTranscript(wss, next, nextOpts);
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

  // Resolve a meme/screencap keyword to an image URL.
  // Frinkiac, Morbotron and Reddit don't ship CORS headers, so the browser
  // can't call them directly — we proxy the search here (server-side, no
  // CORS) and return only the final image URL. The <img> tag in the browser
  // can then load it directly without CORS since image elements don't
  // enforce same-origin.
  const imageResolveCache = new Map();
  app.get("/api/image-search", async (req, res) => {
    const q = String(req.query.q || "").trim().slice(0, 200);
    const subreddit = sanitizeSubreddit(req.query.sub || "");
    if (!q) return res.status(400).json({ ok: false, error: "missing q" });
    const cacheKey = subreddit ? `${subreddit}::${q}` : q;
    if (imageResolveCache.has(cacheKey)) {
      return res.json({ ok: true, url: imageResolveCache.get(cacheKey), cached: true });
    }
    try {
      const url = await resolveMemeImageUrl(q, subreddit);
      imageResolveCache.set(cacheKey, url);
      if (imageResolveCache.size > 200) {
        const oldest = imageResolveCache.keys().next().value;
        imageResolveCache.delete(oldest);
      }
      res.json({ ok: true, url });
    } catch (err) {
      console.error("[image-search]", err);
      res.json({ ok: true, url: null });
    }
  });

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
    const imagesEnabled = req.body?.imagesEnabled !== false;
    res.json({ ok: true });
    processTranscript(wss, text, { imagesEnabled });
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
        processTranscript(wss, msg.text.trim(), { imagesEnabled: msg.imagesEnabled !== false });
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
