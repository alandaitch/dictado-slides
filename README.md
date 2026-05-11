# dictado-slides

> Hablás. El navegador transcribe. Aparecen slides. En vivo.

Una app que convierte una charla en una presentación visual a medida que la
das. Vos hablás en español, [Whisper](https://github.com/openai/whisper)
transcribe en tu navegador (sin mandar audio a ningún lado), un agente
agarra esa transcripción y arma slides una por una con título, bullets,
icono y, si querés, una imagen real de los Simpsons / Futurama / un meme
de Reddit que matchee con lo que estás diciendo.

Pensado para creadores que quieren preparar charlas o reels sin pasar 4
horas armando un Keynote.

![banner](https://raw.githubusercontent.com/alandaitch/dictado-slides/main/.gh/banner.png)

---

## ⚠️ Antes de empezar — leé esto

Este proyecto es **alpha** y tiene varias decisiones que conviene entender
antes de usarlo:

1. **Es gratis** si ya tenés una suscripción a ChatGPT (Plus, Pro o Team).
   No usa la API de pago de OpenAI. Reaprovecha el login que hace la CLI
   `codex` de OpenAI y manda los pedidos al backend de ChatGPT como si
   fueras vos hablando con ChatGPT en el navegador.

2. **El audio NUNCA sale de tu computadora.** Whisper corre con WebGPU /
   WebAssembly directo en el navegador. Lo único que viaja a internet es
   la **transcripción de texto** (en español) que se manda al backend de
   ChatGPT para que el agente decida qué slide armar.

3. **Es un atajo, no un producto oficial de OpenAI.** El método de login
   vía `codex` CLI fue diseñado para esa CLI específica, no para apps de
   terceros. **OpenAI podría cambiar este flujo en cualquier momento y
   romperse la app sin aviso.** No hay ToS que prohíba esto explícitamente
   al día de hoy, pero tampoco hay garantía de que siga andando mañana.

4. **Las imágenes vienen de fuentes públicas sin garantía:**
   [Frinkiac](https://frinkiac.com) (screencaps de los Simpsons),
   [Morbotron](https://morbotron.com) (Futurama) y Reddit JSON anónimo.
   Son gratis, no requieren cuenta, pero pueden ralentizarse o caer si
   tienen tráfico alto. Es una feature opcional, se puede apagar.

5. **El reconocimiento de voz puede confundir palabras.** Whisper-base
   (~280 MB) es rápido pero a veces escucha "IA" como "ella" o "guiones"
   como "bienes". Whisper-turbo (~1.3 GB) anda muchísimo mejor pero tarda
   más en cargar la primera vez. Se elige desde el panel de ajustes.

6. **Sólo está probado en Chrome / Edge / Brave en macOS.** WebGPU es la
   pieza crítica. Si tu navegador no tiene WebGPU, Whisper cae a WebAssembly
   y todo va 3-5× más lento.

7. **No subas audio confidencial.** Aunque el audio no sale del browser,
   la transcripción SÍ va al servidor de ChatGPT. No uses esto para
   meetings con NDA o información sensible. Es para charlas públicas,
   reels, presentaciones que ibas a contar de todas formas.

---

## ¿Cómo funciona?

```
                  TU NAVEGADOR                                INTERNET
┌─────────────────────────────────────────────────────┐
│                                                     │
│  🎤 mic ──▶ AudioWorklet (VAD por energía RMS)      │
│                  │                                  │
│                  ▼                                  │
│            Whisper-WebGPU                           │
│         (transformers.js, español)                  │
│                  │                                  │
│                  ▼                                  │
│            transcripción texto ──▶ WebSocket ──┐    │
│                                                │    │
│           ┌────────────────────────────────────┘    │
│           ▼                                         │
│   Node + Express server (en tu localhost)           │
│           │                                         │
│           │ resuelve OAuth con ~/.codex/auth.json   │
│           │                                         │
│           └────────────────────────────────────────────────▶  chatgpt.com/backend-api/codex
│                                                     │            (gpt-5.5-fast, tu plan ChatGPT)
│           ┌────────────────────────────────────────────────◀
│           ▼                                         │
│   Agent: tool calls → nueva_slide / agregar_bullet  │
│           │                                         │
│           ▼                                         │
│   Frontend renderiza slide (HTML/CSS/Lucide icons)  │
│           │                                         │
│           ▼ si el agente pidió imagen:              │
│   /api/image-search → ──────────────────────────────────────▶ Frinkiac / Morbotron / Reddit
│           ◀──── URL de imagen ──────────────────────────────  (sin auth, free)
│           │                                         │
│           ▼                                         │
│       <img src="..."> directo en la slide           │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## Requisitos

| Cosa | Versión | ¿Por qué? |
|---|---|---|
| Node.js | ≥ 22 | Para correr el server local |
| Chrome / Edge / Brave | reciente con WebGPU | Para correr Whisper localmente rápido |
| Micrófono | obviamente | Para que te escuche |
| Suscripción ChatGPT | Plus / Pro / Team | El agente la usa para generar slides |
| `codex` CLI | latest | Para hacer login con tu cuenta ChatGPT |
| Conexión a internet | mientras hablás | Para que el agente responda |

---

## Instalación paso a paso

### 1. Instalá `codex` (CLI de OpenAI)

[Codex](https://github.com/openai/codex) es la CLI oficial de OpenAI para
charlar con ChatGPT desde la terminal. Acá la usamos solo para el login.

```sh
brew install codex
# o seguí las instrucciones en https://github.com/openai/codex
```

Después logueate con tu cuenta de ChatGPT:

```sh
codex
# te va a abrir el navegador, hacés login con tu cuenta ChatGPT
# y la CLI guarda tus tokens en ~/.codex/auth.json
```

> Solo necesitás hacer esto **una vez**. Si después de mucho tiempo deja
> de funcionar, volvés a correr `codex` y listo.

### 2. Cloná este repo

```sh
git clone https://github.com/alandaitch/dictado-slides.git
cd dictado-slides
npm install
```

### 3. Corré el servidor

```sh
npm start
```

Vas a ver:

```
dictado-slides escuchando en http://127.0.0.1:3211
```

### 4. Abrí Chrome

Andá a [http://127.0.0.1:3211](http://127.0.0.1:3211).

Chrome te va a pedir permiso para usar el micrófono. **Aceptá**. Sin
permiso no funciona.

La primera vez también va a descargar el modelo de Whisper (~280 MB para
base, ~1.3 GB para turbo). Esto solo pasa una vez — después queda cacheado.

---

## Cómo usar

### Lo más básico

1. Apretás **empezar**.
2. Hablás normal, como si fuera una charla.
3. Cuando hacés una pausa breve (medio segundo de silencio), la app
   transcribe lo que dijiste y se lo manda al agente.
4. El agente decide si crear una slide nueva, agregar un bullet a la que
   está, o esperar (si fue una muletilla).
5. Las slides aparecen en pantalla, una a una, mientras seguís hablando.

> Si Whisper te falla, podés también subir un audio pre-grabado con el
> botón **audio…** (acepta `.wav`, `.mp3`, `.m4a`, `.mp4`).

### Atajos de teclado

Mientras la app está abierta (y el foco no está en un input):

- **F** — pantalla completa (la slide ocupa toda la pantalla)
- **→** / **espacio** / **PageDown** — siguiente slide
- **←** / **PageUp** — slide anterior
- **Home** — primera slide
- **End** — última slide
- **ESC** — sale de pantalla completa o cierra modales

### Pantalla completa (modo presentación)

Con el botón **⛶** o tecla **F** entrás a fullscreen. Se oculta la barra
superior y la slide ocupa toda la pantalla. Ideal para proyectar mientras
hablás.

---

## El panel de ajustes ⚙

Click en **⚙ ajustes** (arriba a la derecha) para abrir el panel. Tiene
seis controles.

### `modo` — bullets vs show

Misma slide, dos formas de presentarla:

- **bullets**: título + lista de puntos + icono. Lectura tipo documento.
- **show**: solo título grande, sin bullets visibles. Para presentaciones
  cinematográficas.

Las dos versiones se renderean desde el mismo contenido — el agente no
genera dos veces. Podés saltar entre modos en cualquier momento.

### `fotos` — encendido / apagado

Cuando está **on**, el agente puede pedir imágenes reales para las slides
(memes, screencaps de los Simpsons, Futurama, Reddit). Cuando está **off**,
las slides usan solo iconos.

Por default está **off** porque las imágenes pueden ser inconsistentes
(Reddit a veces devuelve memes random). Encendelo cuando estés contando
algo donde el visual ayude.

### `ritmo` — qué tan seguido aparecen slides

Slider de 4 niveles:

- **lento**: acumula hasta 4-5 bullets en una slide antes de cambiar
- **medio-lento**: 2-3 bullets por slide
- **medio-rápido**: 1-2 bullets por slide
- **rápido** (default): cada idea = una slide nueva, máximo 1 bullet

Para presentaciones rápidas tipo TED, dejalo en rápido. Para clases o
charlas pausadas, bajalo a lento.

### `tema` — paleta de colores

Click en el nombre del tema → se despliega la lista. 5 presets vienen
de fábrica:

- **default** — fondo oscuro, acento naranja
- **mono** — blanco y negro, sin acentos
- **cyber** — verde neón sobre negro
- **sunset** — rosa y violeta
- **paper** — fondo crema, texto negro (modo claro)

Podés crear los tuyos con **+ crear tema…**. Te pide elegir 4 colores
(fondo, texto, acento principal, acento secundario) y deriva el resto
automáticamente. Quedan guardados en `localStorage` y aparecen abajo en
el picker. Doble-click sobre uno custom para editarlo.

### `modelo STT` — qué tan exacta es la transcripción

Tres opciones de Whisper, todas en español:

- **turbo** (~1.3 GB) — la mejor calidad. Confunde menos palabras pero
  tarda más en cargar la primera vez.
- **small** (~970 MB) — balance.
- **base** (~280 MB) — el más rápido y chico. A veces confunde palabras
  con acentos o nombres propios.

Si recién empezás, dejalo en **base** para no esperar la descarga grande.
Si vas a usarlo seguido, cambialo a **turbo**.

### `instrucciones` — cómo querés que arme las slides

Click en el botón → modal con un textarea para escribirle al agente. Por
ejemplo:

- "Sé exagerado con el humor, siempre buscá memes."
- "Soy argentino, priorizá memes de r/argentina."
- "Slides cortas, máximo 1 bullet."
- "Para temas técnicos sé sobrio, solo iconos."

Hay 4 presets de un click si no querés escribir desde cero: **memes**,
**sobrio**, **argentino**, **limpiar**.

Las instrucciones quedan guardadas y se aplican en cada slide que generes.
El primer renglón se ve en el panel — si vés texto truncado con `...`,
es porque tenés instrucciones activas.

---

## Imágenes y memes — cómo funcionan

Cuando **fotos** está activado y el agente decide que una slide se
beneficia de una imagen real, hace 3 cosas:

1. Genera un **keyword en inglés** (ej: "old man yells at cloud").
2. Elige una **fuente**: `simpsons`, `futurama` o `reddit`.
3. Si es reddit, elige un **subreddit** de una lista curada.

Tu Node server hace la búsqueda contra:

- **Frinkiac.com** (Simpsons) — busca por subtítulo literal. Funciona
  mejor con diálogo exacto del episodio.
- **Morbotron.com** (Futurama) — idem.
- **Reddit JSON anónimo** (`r/memes`, `r/wholesomememes`, `r/argentina`,
  `r/ProgrammerHumor`, `r/aww`, etc.) — busca posts virales con imagen.

Devuelve la URL de la imagen, el frontend la carga directo. Si la búsqueda
no encuentra nada, la slide cae a icono Lucide en lugar de mostrar un
hueco vacío.

> **Atención:** las imágenes de Frinkiac/Morbotron son fair-use por
> investigación / educación / paródica. Reddit es contenido subido por
> usuarios, sin verificación. **No uses estas imágenes en contenido
> comercial sin chequear derechos.**

---

## Iconos

Cada slide tiene un ícono [Lucide](https://lucide.dev) (1.500+
disponibles) que el agente elige según el tema. La lista es muy amplia:
🚀 rocket, 💸 dollar-sign, 🧠 brain, 📈 chart-bar, etc. Si la imagen
falla, el ícono sirve de fallback automático.

---

## Solución de problemas

**"vad falló: Permission denied"**
Le tenés que dar permiso de micrófono al sitio. Click en el candado de
la barra de direcciones → Microphone → Allow → recargar.

**Whisper transcribe palabras en otros idiomas o no entiende nada**
Probaste con un modelo demasiado chico (tiny no funciona en español).
Cambiá a **base** o más grande desde el panel de ajustes.

**"Codex CLI auth not found"**
No corriste `codex` para loguearte, o el archivo `~/.codex/auth.json` no
existe. Corré `codex` y hacé login.

**El agente tarda mucho en responder**
La primera llamada al backend de ChatGPT siempre tarda más (~10s).
Después se calientan los caches y las llamadas tardan 1-3s. Si tarda
consistentemente mucho, puede que ChatGPT esté saturado — esperá
unos minutos.

**Las imágenes no cargan / aparece "imagen no encontrada"**
Frinkiac/Reddit pueden tener bajadas momentáneas. La app cae al ícono
automáticamente. Si nunca cargan, chequeá tu conexión y que tu firewall
no bloquee `frinkiac.com` / `morbotron.com` / `reddit.com`.

**Aparecen slides random sin que hable**
Whisper puede "alucinar" en silencios (loops de tokens basura). Hay un
filtro de energía RMS (< -45 dBFS) y otro de patrones conocidos de
alucinación, pero algunos se filtran. Si pasa mucho, hablá más fuerte
o más cerca del mic.

---

## Limitaciones conocidas

- **Argentina-centric:** los iconos, prompts y subreddits están optimizados
  para un creador argentino hablando en español rioplatense. Funciona en
  español neutro también pero algunos chistes locales pueden no calar.

- **Moonshine NO está integrado.** Sería ~5× más rápido que Whisper pero
  la CDN de moonshine.ai está caída desde mayo 2026. Cuando vuelva, hay
  loader code listo en `app.js`.

- **El agente cachea sesiones de slide.** Si querés empezar fresco, click
  en **reset**.

- **Multi-tab:** la app no está pensada para múltiples pestañas abiertas
  al mismo tiempo. Una pestaña por sesión.

---

## Arquitectura — qué está dónde

```
dictado-slides/
├── src/
│   ├── server.js          ← Express + WS, image-search proxy
│   ├── agent.js           ← tool definitions, runTurn, prompt
│   └── codex-auth.js      ← OAuth refresh contra OpenAI
└── public/
    ├── index.html
    ├── app.js             ← STT, VAD, render slides, WS client, theme system
    ├── style.css          ← layouts, themes via CSS vars, animations
    └── vad-worklet.js     ← AudioWorklet para detectar voz (RMS-based)
```

- El system prompt del agente vive en `src/agent.js`.
- Los layouts (bullets, cover, stat, quote, split, photo) se renderean en
  `public/app.js` y se estilan en `public/style.css`.
- Los temas son sets de CSS vars en `style.css` + un sistema de derivación
  para los custom.

---

## Cómo contribuir

Pull requests bienvenidos. Issues también. Si encontrás un bug, abrí un
issue describiendo:

1. Qué hiciste
2. Qué esperabas
3. Qué pasó
4. (Idealmente) el log del server (los logs `[transcript]` y `[agent]`)

---

## Créditos

- [autopreso](https://github.com/kunchenguid/autopreso) — me prestó el
  patrón de auth contra el backend de Codex
- [transformers.js](https://github.com/huggingface/transformers.js) —
  Whisper en el browser
- [Frinkiac](https://frinkiac.com) — Paul Kehrer y team, screencap search
  legendario
- [Lucide](https://lucide.dev) — el pack de iconos

---

## Licencia

MIT. Ver [LICENSE](./LICENSE).

---

## Disclaimer

Este es un proyecto personal hecho para experimentar. **No tiene garantía
de funcionar mañana**, no es un producto, no te lo recomiendo para una
demo importante sin probarlo antes 2-3 veces.

Si OpenAI cambia su backend, si Frinkiac se cae, si Reddit cambia su API,
si tu modelo de Whisper se desfasa — esta app deja de andar parcial o
totalmente. Es un atajo construido sobre pilares ajenos.

Usalo con cariño. Reportá bugs. Hacé forks.
