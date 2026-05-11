import { createOpenAI } from "@ai-sdk/openai";
import { streamText, tool } from "ai";
import { z } from "zod";

import { DEFAULT_CODEX_BASE_URL, createCodexFetch, resolveCredentials } from "./codex-auth.js";

const MODEL_REQUESTED = "gpt-5.5-fast";
const MODEL_BASE = "gpt-5.5";

let cachedModel;

async function getModel() {
  if (cachedModel) return cachedModel;
  const creds = await resolveCredentials();
  const codex = createOpenAI({
    name: "openai-codex",
    baseURL: creds.baseURL || DEFAULT_CODEX_BASE_URL,
    apiKey: creds.accessToken,
    fetch: createCodexFetch(),
  });
  cachedModel = codex.responses(MODEL_BASE);
  return cachedModel;
}

const SYSTEM_PROMPT = `Sos un asistente que arma slides en VIVO mientras alguien habla en español.

Tu tarea: convertir lo que la persona dice en una presentación clara, una slide a la vez.

REGLA DE ORO — ANTI-ALUCINACIÓN:
Los bullets deben reflejar SOLAMENTE lo que está EXPLÍCITAMENTE en la transcripción. Está PROHIBIDO inventar contenido, completar ideas que el orador no dijo, o "rellenar" temas relacionados que no aparecieron literalmente.
Si la transcripción es un fragmento incompleto o ambiguo, llamá a "esperar". Mejor demorar una slide que mostrar una mentira en pantalla.

RITMO — CRÍTICO:
La presentación debe ser RÁPIDA y CINEMÁTICA. Muchas slides cortas, no pocas saturadas.
- Target: 1-2 bullets por slide (3 máximo en raros casos).
- **CADA EJEMPLO CONCRETO = SLIDE NUEVA**. Si el orador dice "por ejemplo Homero…" → slide. Después "Lisa pide…" → OTRA slide. Después "Bart hace…" → OTRA slide. Cada personaje, cada caso, cada anécdota tiene su propia slide.
- "por otro lado", "también", "además", "otra cosa", "después", "encima" → NUEVA slide.
- Cualquier cambio de protagonista, ángulo, métrica o registro → NUEVA slide.
- agregar_bullet solo cuando es LITERALMENTE el mismo punto desarrollado en la misma oración.
- Si la slide actual ya tiene 2 bullets, tu default es nueva_slide.
- EN LA DUDA: nueva_slide. Siempre nueva_slide.

REGLAS:
1. Cada slide tiene un TÍTULO corto (3-7 palabras, idea fuerte) y 1-2 BULLETS típicos (máximo absoluto 3).
2. NUEVA SLIDE siempre que haya quiebre de tema o ángulo.
3. AGREGAR_BULLET solo cuando es continuación literal del mismo punto. Si el bullet ya existe parafraseado, NO lo agregues de nuevo.
4. NO crees slide para muletillas, dudas, "eh", "bueno", correcciones, o frases vacías. Tampoco para fragmentos cortados a la mitad. Para esos casos llamá a "esperar".
5. Bullets en MINÚSCULA y SIN punto final, salvo nombres propios. Concretos, no genéricos.
6. Títulos: idea, no descripción. "El problema de la velocidad" no "Hablamos del problema".
7. Respondés en ESPAÑOL RIOPLATENSE (voseo).
8. NUNCA expliques tu razonamiento — solo llamás herramientas.

CONTEXTO: vas a recibir la transcripción nueva (lo que se acaba de decir) y la slide actual. La transcripción puede venir cortada en mitad de oración porque procesamos en chunks de pocos segundos. Si dudás de si una idea es real o inferida, esperá.

ICONOS (Lucide): SIEMPRE incluí un icono al crear una slide. Tenés ~1500 a disposición, el frontend hace fuzzy match así que cualquier nombre razonable en inglés kebab-case se resuelve. Ejemplos de anclas semánticas:
- ideas: lightbulb, brain, sparkles, zap, star, eye
- crecimiento/datos: trending-up, trending-down, chart-bar, chart-line, chart-pie, activity, target
- gente: users, user-check, handshake, smile
- tech: cpu, code, terminal, database, cloud, bot, network, smartphone
- plata: dollar-sign, banknote, coins, percent, piggy-bank
- tiempo: clock, calendar, hourglass, timer
- comunicación: message-square, mail, megaphone, mic, video
- proceso: settings, wrench, key, lock, workflow, refresh-cw
- conocimiento: book-open, graduation-cap, file-text
- alerta: alert-triangle, info, shield
- creatividad: palette, paintbrush, music, film, image, camera
- objetivos: flag, trophy, rocket, mountain, crown
- problemas: bug, x-circle, life-buoy

LAYOUTS — elegí el que mejor sirva al contenido:
- **bullets** (default): 2-5 ideas que desarrollar el mismo tema.
- **cover**: introducción de sección o capítulo. Solo el título potente y opcionalmente un subtítulo corto en bullets[0]. Bullets vacío = solo título gigante.
- **stat**: la idea principal es UNA CIFRA. bullets[0] DEBE ser una métrica CORTA de máximo 8 caracteres. Válidos: "20M", "$20M", "+340%", "150K", "8×", "99.9%", "1/3", "$2B". NO uses "20 millones de dólares" — eso va en titulo. titulo = qué describe esa cifra ("dólares levantados", "más rápido", "del equipo"). bullets[1+] = contexto adicional opcional.
- **quote**: cita textual de alguien. titulo = quién dice la cita. bullets[0] = la cita exacta. Solo usar cuando el orador EXPLÍCITAMENTE cita a alguien.
- **split**: contraste de dos ideas. bullets[0] = lado izquierdo, bullets[1] = lado derecho. Ej: "antes vs ahora", "problema vs solución".
- **photo**: cuando hay imagen real que aporta humor/impacto. La imagen ocupa medio slide, título y bullets al costado. Solo usar este layout si tenés imagen (campo imagen lleno).

CUÁNDO USAR IMAGEN (campo imagen):
- El orador hizo un chiste o referencia pop ("como Homero cuando…", "se siente como ese meme de…", "es como cuando Bender…")
- La idea pega más fuerte con un visual conocido que con un icono
- Hay una analogía con cultura pop concreta

CÓMO USAR IMAGEN — CRÍTICO:
1. SIEMPRE poné el campo "fuente" explícito ('simpsons' / 'futurama' / 'reddit'). NO confíes en el keyword para ruteo.
2. Para fuente='simpsons' o 'futurama': el campo imagen DEBE ser DIÁLOGO LITERAL EN INGLÉS del episodio. Ejemplos VÁLIDOS:
   - "i wish for a turkey sandwich" (Bart en Treehouse of Horror II)
   - "i wish for world peace" (Lisa, mismo episodio)
   - "old man yells at cloud" (titular)
   - "i for one welcome our new ant overlords"
   - "shut up and take my money" (Fry)
   - "good news everyone" (Profesor Farnsworth)
   Ejemplos INVÁLIDOS (no funcionan): "simpsons sandwich", "lisa world peace", "simpsons monkey paw" — son descripciones, no diálogo. Frinkiac es búsqueda por subtítulos.
3. Si NO sabés la frase literal del momento, usá fuente='reddit' y un keyword de meme conocido en inglés.

NO uses imagen para:
- Slides técnicas, sobrias, expositivas — usá icon.
- Cifras (stat) — el número es el visual.
- Citas textuales (quote) — el texto es el foco.
Cuando no hay encaje claro, omití el campo imagen (es opcional).`;

const LAYOUTS = ["bullets", "cover", "stat", "quote", "split", "photo"];

const tools = {
  nueva_slide: tool({
    description:
      "Crear una nueva slide con título, bullets, icono y layout. Usar cuando hay un cambio claro de tema.",
    inputSchema: z.object({
      titulo: z.string().min(1).max(80),
      bullets: z.array(z.string().min(1).max(160)).min(0).max(5),
      icon: z
        .string()
        .max(40)
        .describe(
          "Nombre de un icono Lucide (kebab-case). Tenés ~1500 a disposición — elegí libremente en inglés. Si dudás, alguno de: rocket, brain, lightbulb, chart-bar, dollar-sign, users, target, sparkles, zap, trending-up, message-square, code, book-open, clock, flag, trophy.",
        ),
      imagen: z
        .string()
        .max(120)
        .optional()
        .describe(
          "Opcional: keyword en INGLÉS para buscar imagen. Si fuente='simpsons' o 'futurama', pasale DIÁLOGO LITERAL del episodio en inglés ('i wish for a turkey sandwich', 'old man yells at cloud', 'i for one welcome our new ant overlords', 'shut up and take my money'). NUNCA descripciones tipo 'simpsons sandwich' o 'lisa world peace' — Frinkiac indexa subtítulos, no temas. Si fuente='reddit', pasale términos típicos de meme ('this is fine', 'galaxy brain', 'drake yes no', 'expanding brain').",
        ),
      fuente: z
        .enum(["simpsons", "futurama", "reddit"])
        .optional()
        .describe(
          "Opcional: de dónde sacar la imagen. 'simpsons' → Frinkiac (screencaps de Los Simpson, búsqueda por DIÁLOGO LITERAL EN INGLÉS). 'futurama' → Morbotron (igual). 'reddit' → memes virales. Si lo omitís, se infiere por el keyword. PONELO EXPLÍCITO siempre que sepas qué show o fuente querés — es mucho más confiable que depender del keyword.",
        ),
      subreddit: z
        .string()
        .max(30)
        .optional()
        .describe(
          "Opcional: subreddit cuando fuente='reddit'. Opciones: memes, wholesomememes, reactiongifs, dankmemes, AdviceAnimals, ProgrammerHumor, PoliticalHumor, aww, argentina, RepublicaArgentina, oldschoolcool, interestingasfuck, gifs.",
        ),
      layout: z
        .enum(LAYOUTS)
        .describe(
          "Layout: 'bullets' (default) para 2-5 ideas. 'cover' para introducir sección/capítulo. 'stat' cuando es UNA cifra (bullets[0]='20M'). 'quote' para cita (titulo=autor, bullets[0]=cita). 'split' para contraste de dos lados (bullets[0]/[1]). 'photo' cuando hay imagen — la imagen ocupa medio slide y el título va al costado.",
        ),
    }),
    execute: async (args) => ({ ok: true, ...args }),
  }),
  agregar_bullet: tool({
    description:
      "Agregar uno o varios bullets a la slide actual. Usar cuando la persona sigue desarrollando el mismo tema. Opcionalmente actualizar icono, imagen o layout.",
    inputSchema: z.object({
      bullets: z.array(z.string().min(1).max(160)).min(1).max(3),
      icon: z.string().max(40).optional(),
      imagen: z.string().max(120).optional(),
      fuente: z.enum(["simpsons", "futurama", "reddit"]).optional(),
      subreddit: z.string().max(30).optional(),
      layout: z.enum(LAYOUTS).optional(),
    }),
    execute: async (args) => ({ ok: true, ...args }),
  }),
  esperar: tool({
    description:
      "No hacer nada. Usar cuando la transcripción es muletilla, ruido o no aporta contenido todavía.",
    inputSchema: z.object({
      razon: z.string().max(80).optional(),
    }),
    execute: async (args) => ({ ok: true, ...args }),
  }),
};

function describeCurrentSlide(slide) {
  if (!slide) return "(no hay slide todavía — la próxima acción debería ser nueva_slide)";
  const bullets = slide.bullets.length
    ? slide.bullets.map((b, i) => `  ${i + 1}. ${b}`).join("\n")
    : "  (sin bullets)";
  return `Slide actual #${slide.index + 1}\nTítulo: ${slide.titulo}\nBullets:\n${bullets}\n(${slide.bullets.length}/5 bullets)`;
}

function ritmoGuidance(rate) {
  if (rate <= 3) {
    return `RITMO LENTO (${rate}/10): podés acumular hasta 4-5 bullets en una slide antes de cambiar. Cambiá de slide solo en quiebres de tema MUY claros.`;
  }
  if (rate <= 7) {
    return `RITMO NORMAL (${rate}/10): target 1-2 bullets por slide. Quiebre de tema, ángulo o ejemplo = nueva slide. "Por otro lado", "también", "además" → nueva.`;
  }
  return `RITMO RÁPIDO (${rate}/10): cada idea o sub-idea = SLIDE NUEVA. Máximo 1 bullet por slide. Cualquier cambio mínimo de foco = nueva_slide. Sin excepciones.`;
}

export async function runTurn({ transcript, currentSlide, history = [], imagesEnabled = true, customInstructions = "", rate = 6 }) {
  const model = await getModel();
  const flags = imagesEnabled
    ? "IMÁGENES habilitadas. PODÉS usar imagen cuando claramente la slide se beneficie (chiste, meme, referencia pop, analogía cultural, momento emocional fuerte). NO uses imagen para slides técnicas, expositivas, sobrias, o cuando solo querés ilustrar una idea genérica. Si el orador NO está haciendo una referencia pop específica, dejá la slide con solo icon — es mejor que una imagen forzada. NUNCA repitas el mismo keyword en slides consecutivas (el server rechaza duplicados de las últimas 6 slides)."
    : "IMÁGENES deshabilitadas — NO uses el campo imagen bajo ningún concepto.";
  const rateBlock = `\n\n${ritmoGuidance(rate)}`;
  const customBlock = customInstructions.trim()
    ? `\n\nINSTRUCCIONES PERSONALIZADAS DEL USUARIO (priorizalas sobre defaults):\n${customInstructions.trim()}\n`
    : "";
  const messages = [
    ...history,
    {
      role: "user",
      content: `${flags}${rateBlock}${customBlock}\n\nEstado: ${describeCurrentSlide(currentSlide)}\n\nLo que el orador acaba de decir (entre comillas):\n"""\n${transcript}\n"""`,
    },
  ];

  const stream = streamText({
    model,
    messages,
    tools,
    toolChoice: "required",
    providerOptions: {
      openai: {
        reasoningEffort: "low",
        serviceTier: "priority",
        store: false,
        instructions: SYSTEM_PROMPT,
      },
    },
  });
  await stream.consumeStream();
  const toolCalls = (await stream.toolCalls) || [];
  const usage = await stream.usage.catch(() => undefined);

  const calls = toolCalls.map((c) => ({
    name: c.toolName,
    args: c.input,
  }));

  return { calls, usage };
}
