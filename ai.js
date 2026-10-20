// Todo lo que usa la IA (Claude): tutor de conversación y generación de tarjetas/ejercicios.
import Anthropic from 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm';
import { state } from './store.js';
import { LANGS } from './data.js';

export const MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', note: 'La mejor calidad (recomendado)' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', note: 'Mucho más barato y rápido' },
];

// Separador entre la respuesta del tutor y las correcciones.
export const FIX_MARK = '%%';

const LANG_NAMES = { en: 'English', es: 'Spanish' };

function client() {
  const apiKey = state.settings.apiKey.trim();
  if (!apiKey) throw new Error('NO_KEY');
  // La clave vive solo en este móvil; la app no tiene servidor propio.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

function baseParams() {
  const model = state.settings.model;
  const params = { model, output_config: { effort: 'low' } };
  if (model === 'claude-opus-5-5') {
    // Si un filtro de seguridad rechaza la petición, la API la reintenta sola con otro modelo.
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  return params;
}

export function friendlyError(err) {
  if (err?.message === 'NO_KEY') return 'Falta la clave de la API. Añádela en Ajustes (⚙️ en Inicio).';
  if (err instanceof Anthropic.AuthenticationError) return 'La clave de la API no es válida. Revísala en Ajustes.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'Esta clave no tiene permiso para usar ese modelo.';
  if (err instanceof Anthropic.RateLimitError) return 'Demasiadas peticiones o sin saldo. Espera un poco o revisa el saldo de la cuenta.';
  if (err instanceof Anthropic.BadRequestError) return `La petición no es válida: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'Sin conexión. Comprueba internet e inténtalo de nuevo.';
  if (err instanceof Anthropic.APIError) return `Error del servicio (${err.status ?? '?'}). Inténtalo de nuevo.`;
  return err?.message || 'Algo ha fallado.';
}

function textOf(message) {
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

// ---------- Tutor de conversación ----------

export function tutorSystem(lang, scenario, voice = false) {
  const target = LANG_NAMES[lang];
  const other = LANG_NAMES[lang === 'en' ? 'es' : 'en'];
  const explain = LANG_NAMES[LANGS[lang].meaningLang];
  const name = state.settings.name.trim();
  return `You are a warm, encouraging conversation tutor inside a language-learning app. The student${name ? `, ${name},` : ''} is practising ${target}. They are an intermediate learner (around B1–B2) who also speaks ${other}.

Scenario: ${scenario.prompt}

How to reply:
- Always write your reply in ${target}. Keep it short, like a real chat: 1–3 sentences, usually ending with a question that keeps the conversation going.
- Use natural, everyday ${target} at B1–B2 level. Now and then, slip in a useful expression the student could learn.
- If the student writes in ${other} or asks how to say something, help briefly, then continue in ${target}.
- After your reply, if the student's last message had mistakes or sounded unnatural, add a line containing only ${FIX_MARK} and then up to 3 short corrections, one per line, in this format:
❌ what they wrote → ✅ better version — very short reason in ${explain}
- If their message was correct and natural, leave out the ${FIX_MARK} section entirely. Small typos and missing accents or capital letters are fine, don't correct them.
- Plain text only: no markdown, no lists, no headings.${voice ? `

This is a live voice call. The student's messages are automatic speech transcriptions, and your reply will be read aloud by a text-to-speech voice:
- Talk like a real person on the phone: one or two short sentences per turn, with contractions and natural spoken phrasing.
- In your reply, use only words that sound natural read aloud: no emojis, symbols, parentheses or abbreviations.
- Ignore punctuation, capital letters and obvious transcription glitches in the student's messages. Only correct real grammar or vocabulary mistakes.` : ''}`;
}

export const KICKOFF = '[The student just opened this conversation. Greet them briefly and start the scenario with an opening line or question.]';
export const CALL_KICKOFF = '[The student just started a voice call with you. Pick the conversation up naturally from where it was, with a short line or question.]';

// messages: [{role, content}] ; onText(textoAcumulado) se llama mientras llega la respuesta.
// voice: true en modo llamada (respuestas más cortas y habladas).
export async function tutorReply(lang, scenario, messages, onText, { voice = false } = {}) {
  const stream = client().beta.messages.stream({
    ...baseParams(),
    max_tokens: 16000,
    system: tutorSystem(lang, scenario, voice),
    messages: messages.map(({ role, content }) => ({ role, content })),
  });
  let acc = '';
  stream.on('text', (delta) => {
    acc += delta;
    onText(acc);
  });
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') {
    throw new Error('El tutor no ha podido responder a eso. Prueba a decirlo de otra forma.');
  }
  return textOf(final);
}

export function splitReply(text) {
  const i = text.indexOf(FIX_MARK);
  if (i === -1) return { reply: text.trim(), fixes: '' };
  return { reply: text.slice(0, i).trim(), fixes: text.slice(i + FIX_MARK.length).trim() };
}

// ---------- Generar contenido con IA ----------

async function structured(prompt, schema) {
  const response = await client().beta.messages.create({
    ...baseParams(),
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
    output_config: { ...baseParams().output_config, format: { type: 'json_schema', schema } },
  });
  if (response.stop_reason === 'refusal') throw new Error('No se ha podido generar ese contenido. Prueba otro tema.');
  if (response.stop_reason === 'max_tokens') throw new Error('La respuesta se ha cortado. Inténtalo de nuevo.');
  return JSON.parse(textOf(response));
}

export async function generateCards(lang, topic, count = 10) {
  const target = LANG_NAMES[lang];
  const meaning = LANG_NAMES[LANGS[lang].meaningLang];
  const data = await structured(
    `Create ${count} flashcards for an intermediate (B1–B2) learner of ${target} about this topic: "${topic}".
Prefer useful, natural words and expressions that people really use. For each card:
- front: the word or expression in ${target}
- back: its meaning in ${meaning} (short)
- example: one natural example sentence in ${target}`,
    {
      type: 'object',
      properties: {
        cards: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              front: { type: 'string' },
              back: { type: 'string' },
              example: { type: 'string' },
            },
            required: ['front', 'back', 'example'],
            additionalProperties: false,
          },
        },
      },
      required: ['cards'],
      additionalProperties: false,
    },
  );
  return data.cards.filter((c) => c.front && c.back);
}

export async function generateExercises(lang, topic) {
  const target = LANG_NAMES[lang];
  const explain = LANG_NAMES[LANGS[lang].meaningLang];
  const data = await structured(
    `Create 8 multiple-choice exercises for an intermediate (B1–B2) learner of ${target}${topic ? ` focused on: "${topic}"` : ' covering common grammar and vocabulary mistakes'}.
Each exercise is one sentence in ${target} with a gap written as ___, four options, exactly one correct.
- q: the sentence with ___
- options: 4 options
- answer: index (0–3) of the correct option
- why: a very short explanation in ${explain}`,
    {
      type: 'object',
      properties: {
        exercises: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              q: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
              answer: { type: 'integer' },
              why: { type: 'string' },
            },
            required: ['q', 'options', 'answer', 'why'],
            additionalProperties: false,
          },
        },
      },
      required: ['exercises'],
      additionalProperties: false,
    },
  );
  return data.exercises
    .filter((e) => e.options.length >= 2 && e.answer >= 0 && e.answer < e.options.length)
    .map((e) => ({ type: 'choice', ...e }));
}
