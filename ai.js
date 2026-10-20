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

// Quita espacios, saltos de línea y caracteres invisibles que se cuelan al copiar y pegar.
export const cleanKey = (key = '') => key.replace(/[^\x21-\x7E]/g, '');

// Avisa si lo pegado no tiene pinta de clave de Claude.
export function keyProblem(key) {
  if (!key) return '';
  if (key.startsWith('sk_')) return 'Esta parece la clave de ElevenLabs. La de Claude empieza por «sk-ant-».';
  if (!key.startsWith('sk-ant-')) return 'Las claves de Claude empiezan por «sk-ant-». Revisa que la has copiado entera.';
  if (key.length < 60) return 'La clave parece incompleta. Cópiala otra vez entera.';
  return '';
}

function client() {
  const apiKey = cleanKey(state.settings.apiKey);
  if (!apiKey) throw new Error('NO_KEY');
  // La clave vive solo en este móvil; la app no tiene servidor propio.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
}

// Comprueba la clave sin gastar nada (listar modelos es gratis).
export async function checkKey() {
  await client().models.list({ limit: 1 });
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
  return messageText(message.content);
}

// Texto visible de un mensaje guardado (puede ser texto o una lista de bloques).
export function messageText(content) {
  if (typeof content === 'string') return content;
  return content
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
- Plain text only: no markdown, no lists, no headings.
- Your replies are read aloud by the app's voice. If the student asks you to speak more slowly, faster or at normal speed (in any language), use the ${SPEED_TOOL.name} tool straight away; it is the only way to change how fast you sound, so never just promise it. After the tool result, confirm in one short sentence in ${target} and carry on with the conversation.
- When you use a tool, you may say a brief sentence first. Do not include internal or system XML tags in your response.${voice ? `

This is a live voice call. The student's messages are automatic speech transcriptions, and your reply will be read aloud by a text-to-speech voice:
- Talk like a real person on the phone: one or two short sentences per turn, with contractions and natural spoken phrasing.
- In your reply, use only words that sound natural read aloud: no emojis, symbols, parentheses or abbreviations.
- Ignore punctuation, capital letters and obvious transcription glitches in the student's messages. Only correct real grammar or vocabulary mistakes.` : ''}`;
}

export const KICKOFF = '[The student just opened this conversation. Greet them briefly and start the scenario with an opening line or question.]';
export const CALL_KICKOFF = '[The student just started a voice call with you. Pick the conversation up naturally from where it was, with a short line or question.]';

// Herramienta para que el tutor cambie de verdad la velocidad de su voz cuando se lo piden.
export const SPEED_CHANGES = ['much_slower', 'slower', 'normal', 'faster', 'much_faster'];
const SPEED_TOOL = {
  name: 'set_speech_speed',
  description:
    'Changes how fast the app reads your replies aloud. Use it whenever the student asks you to talk more slowly, faster or at normal speed, in any language (for example "can you speak more slowly?", "habla más despacio", "a bit faster, please").',
  input_schema: {
    type: 'object',
    properties: {
      change: {
        type: 'string',
        enum: SPEED_CHANGES,
        description:
          '"slower" or "faster" for a normal request; "much_slower" or "much_faster" if they ask for a big change or say it is still too fast or too slow; "normal" to go back to the default speed.',
      },
    },
    required: ['change'],
    additionalProperties: false,
  },
  strict: true,
};

// Tiempos máximos: si la respuesta no empieza o se queda parada, se corta y se reintenta.
const FIRST_TOKEN_MS = 15000;
const STALL_MS = 12000;
const MAX_TOOL_ROUNDS = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Si la API rechazara alguno de los ajustes opcionales, se reintenta sin ellos el resto de la sesión.
let lean = false;

function tutorParams(system, messages) {
  const params = {
    ...baseParams(),
    max_tokens: 16000,
    system,
    messages,
    tools: [lean ? { ...SPEED_TOOL, strict: undefined } : SPEED_TOOL],
  };
  if (!lean) {
    // Reutiliza el principio de la conversación ya procesado: respuestas más rápidas en charlas largas.
    params.cache_control = { type: 'ephemeral' };
    // En Haiku, sin pensamiento previo: para conversar en voz alta importa más la rapidez.
    if (params.model === 'claude-haiku-5-5') params.thinking = { type: 'disabled' };
  }
  return params;
}

// El historial se envía sin los bloques de pensamiento de turnos anteriores: no hacen falta
// para seguir la charla y así el historial sigue siendo válido aunque cambie el modo (texto o llamada).
function withoutThinking(content) {
  if (typeof content === 'string') return content;
  return content.filter(
    (b) => b.type !== 'thinking' && b.type !== 'redacted_thinking' && !(b.type === 'text' && !b.text.trim()),
  );
}

function historyForApi(messages) {
  const out = [];
  for (const { role, content } of messages) {
    if (role !== 'user' && role !== 'assistant') continue;
    const clean = withoutThinking(content);
    if (typeof clean === 'string' ? clean.trim() : clean.length) out.push({ role, content: clean });
  }
  return out;
}

async function streamRound(params, { signal, onDelta }) {
  const stream = client().beta.messages.stream(params, { signal });
  let timer = null;
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => stream.abort(), ms);
  };
  arm(FIRST_TOKEN_MS);
  stream.on('streamEvent', () => arm(STALL_MS));
  stream.on('text', onDelta);
  try {
    return await stream.finalMessage();
  } finally {
    clearTimeout(timer);
  }
}

// Un turno del tutor: puede tener varias rondas si usa la herramienta de velocidad.
// onText(texto) recibe todo lo que va diciendo; onSpeed(cambio) aplica la velocidad y devuelve
// un texto para el tutor; commit(mensaje) guarda cada mensaje nuevo en orden, en cuanto está completo.
// Devuelve { text } con todo lo que ha dicho en este turno.
export async function tutorTurn({ lang, scenario, messages, voice = false, signal, onText, onSpeed, commit }) {
  const system = tutorSystem(lang, scenario, voice);
  const history = historyForApi(messages);
  const turn = []; // mensajes de este turno tal cual los devuelve la API (se reenvían sin tocar)
  let said = '';

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const prefix = said ? `${said} ` : '';
    let segment = '';
    let final = null;
    for (let attempt = 0; !final; attempt++) {
      segment = '';
      try {
        final = await streamRound(tutorParams(system, history.concat(turn)), {
          signal,
          onDelta: (delta) => {
            segment += delta;
            onText?.(prefix + segment);
          },
        });
      } catch (err) {
        if (signal?.aborted) throw new Error('ABORTED');
        if (segment.trim()) {
          // Se cortó a mitad de respuesta: nos quedamos con lo que ya ha dicho.
          final = { content: [{ type: 'text', text: segment }], stop_reason: 'end_turn' };
          break;
        }
        if (err instanceof Anthropic.BadRequestError && !lean) {
          lean = true;
          console.warn('Reintentando sin ajustes opcionales:', err.message);
          continue;
        }
        const status = err?.status;
        const retryable = !(err instanceof Anthropic.APIError) || status === undefined || status === 429 || status >= 500;
        if (!retryable || attempt >= 1) throw err;
        await sleep(800);
      }
    }

    if (final.stop_reason === 'refusal') {
      throw new Error('El tutor no ha podido responder a eso. Prueba a decirlo de otra forma.');
    }
    const text = textOf(final);
    if (text.trim()) said = prefix + text;
    if (!final.content.length) break;
    turn.push({ role: 'assistant', content: final.content });
    const visible = withoutThinking(final.content);
    if (visible.length) commit?.({ role: 'assistant', content: visible });

    const toolUses = final.content.filter((b) => b.type === 'tool_use');
    if (!toolUses.length) break;
    // Cada llamada a la herramienta necesita su respuesta, aunque no se haya podido ejecutar.
    const results = toolUses.map((b) => {
      const valid = final.stop_reason === 'tool_use' && b.name === SPEED_TOOL.name && SPEED_CHANGES.includes(b.input?.change);
      return valid
        ? { type: 'tool_result', tool_use_id: b.id, content: onSpeed?.(b.input.change) || 'Done.' }
        : { type: 'tool_result', tool_use_id: b.id, content: 'Could not change the speed (invalid request).', is_error: true };
    });
    const toolMessage = { role: 'user', content: results };
    turn.push(toolMessage);
    commit?.({ ...toolMessage, hidden: true });
    if (final.stop_reason !== 'tool_use') break;
  }
  return { text: said };
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
