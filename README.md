# dictado-slides

Hablás y se generan slides en tiempo real, en castellano. Usa tu suscripción
de ChatGPT (vía `codex` CLI OAuth) para el modelo, y Whisper local en el
navegador para la transcripción. No paga API, no manda audio a la nube.

## Cómo anda

```
mic (browser) ─▶ AudioWorklet VAD (energía RMS)
                   │
                   ├─▶ Whisper-WebGPU (transformers.js, español)
                   │       │
                   │       ▼
                   │   transcripción
                   │       │
                   ▼       ▼
              WebSocket ──▶ Node server
                                │
                                ▼
                       agente con tools
                       (nueva_slide / agregar_bullet / esperar)
                                │
                                ▼  vía `~/.codex/auth.json`
                       chatgpt.com/backend-api/codex
                                │
                                ▼  WS push
                       deck renderiza slide
```

## Requisitos

- Node ≥ 22
- `codex` CLI instalada y logueada con ChatGPT (escribe `~/.codex/auth.json`)
- Chrome con WebGPU (cualquier Mac reciente)
- Permisos de micrófono en el browser

## Correr

```sh
npm install
npm start
# abrir http://127.0.0.1:3211 en Chrome
```

La primera carga baja el modelo de Whisper (~150 MB), después queda cacheado.

## Auth (Codex / ChatGPT)

El server lee `~/.codex/auth.json` y refresca el access token automáticamente
contra `https://auth.openai.com/oauth/token` con el client id de Codex. Manda
las requests al backend de ChatGPT con `Authorization: Bearer <access>` +
`ChatGPT-Account-Id`. Esto replica lo que hace
[`autopreso`](https://github.com/kunchenguid/autopreso) (gracias a ellos por
el patrón).

## Tools del agente

El system prompt está en `src/agent.js`. El modelo (`gpt-5.5-fast` con
`serviceTier: priority`) decide entre:

- `nueva_slide(titulo, bullets[])` — cambio de tema o slide actual llena
- `agregar_bullet(bullets[])` — extiende la slide actual
- `esperar(razon?)` — muletilla / sin contenido nuevo

## Subir un audio en vez de hablar

El botón **audio…** acepta `.wav`, `.mp3`, `.m4a` o `.mp4`. Lo decodifica a
16 kHz mono y lo pasa por el mismo pipeline. Útil para procesar audios
pre-grabados.

## Tuning

En `public/app.js`, `EnergyVoiceDetector` tiene tres parámetros:

- `threshold` (0.012) — RMS mínimo para considerar "voz"
- `silenceMs` (700) — silencio que finaliza una oración
- `minSpeechMs` (350) — duración mínima de un turno para no descartarlo
