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

REGLAS:
1. Cada slide tiene un TÍTULO corto (3-7 palabras, idea fuerte) y 1-5 BULLETS (frases cortas, sin redundar el título).
2. Crear UNA NUEVA SLIDE cuando hay un cambio claro de tema o cuando la slide actual ya tiene 5 bullets.
3. AGREGAR un bullet a la slide actual cuando la persona desarrolla más el mismo tema. Si el bullet ya existe parafraseado, NO lo agregues de nuevo.
4. NO crees slide para muletillas, dudas, "eh", "bueno", correcciones, o frases vacías. Tampoco para fragmentos cortados a la mitad. Para esos casos llamá a "esperar".
5. Bullets en MINÚSCULA y SIN punto final, salvo nombres propios. Concretos, no genéricos.
6. Títulos: idea, no descripción. "El problema de la velocidad" no "Hablamos del problema".
7. Respondés en ESPAÑOL RIOPLATENSE (voseo).
8. NUNCA expliques tu razonamiento — solo llamás herramientas.

CONTEXTO: vas a recibir la transcripción nueva (lo que se acaba de decir) y la slide actual. La transcripción puede venir cortada en mitad de oración porque procesamos en chunks de pocos segundos. Si dudás de si una idea es real o inferida, esperá.

ICONOS (Lucide, kebab-case): SIEMPRE incluí un icono al crear una slide. Elegí el que mejor represente el tema. Ejemplos típicos:
- ideas/concepto: lightbulb, brain, sparkles, eye, zap, star
- crecimiento/métricas: trending-up, trending-down, chart-bar, chart-line, chart-pie, activity, target
- gente/equipo: users, user, user-check, smile, handshake
- tech: cpu, code, terminal, database, cloud, smartphone, laptop, bot, network
- plata: dollar-sign, banknote, coins, percent, calculator, piggy-bank, credit-card
- tiempo: clock, calendar, hourglass, timer, fast-forward
- comunicación: message-square, mail, phone, megaphone, mic, video, headphones
- proceso/herramientas: settings, wrench, hammer, key, lock, refresh-cw, workflow
- educación/conocimiento: book, book-open, graduation-cap, file-text, folder
- alerta/info: alert-triangle, info, help-circle, shield, ban
- creatividad: palette, paintbrush, music, film, image, camera
- objetivos: flag, trophy, medal, crown, rocket, mountain
- problemas/soluciones: bug, x-circle, check-circle, fire, life-buoy
Si no encontrás uno perfecto, elegí el más cercano (lucide tiene 1500+, los nombres son intuitivos en inglés).`;

const tools = {
  nueva_slide: tool({
    description:
      "Crear una nueva slide con título, bullets iniciales y un icono semántico. Usar cuando hay un cambio claro de tema.",
    inputSchema: z.object({
      titulo: z.string().min(1).max(80),
      bullets: z.array(z.string().min(1).max(140)).min(0).max(5),
      icon: z
        .string()
        .max(40)
        .describe(
          "Nombre de un icono Lucide en kebab-case que represente visualmente el tema de la slide. Ej: rocket, brain, chart-bar, dollar-sign, lightbulb, users, target.",
        ),
    }),
    execute: async (args) => ({ ok: true, ...args }),
  }),
  agregar_bullet: tool({
    description:
      "Agregar uno o varios bullets a la slide actual. Usar cuando la persona sigue desarrollando el mismo tema. Podés actualizar el icono si la nueva info lo justifica.",
    inputSchema: z.object({
      bullets: z.array(z.string().min(1).max(140)).min(1).max(3),
      icon: z
        .string()
        .max(40)
        .optional()
        .describe("Opcional: nuevo nombre de icono Lucide si el tema mutó."),
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

export async function runTurn({ transcript, currentSlide, history = [] }) {
  const model = await getModel();
  const messages = [
    ...history,
    {
      role: "user",
      content: `${describeCurrentSlide(currentSlide)}\n\n--- TRANSCRIPCIÓN NUEVA ---\n${transcript}\n\nDecidí qué hacer.`,
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
