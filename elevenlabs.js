// Voz realista del tutor con ElevenLabs. Si falla (sin créditos, sin internet…),
// quien la usa vuelve a la voz gratis del móvil.

const API = 'https://api.elevenlabs.io';

export const EL_MODELS = [
  { id: 'eleven_v4_turbo', name: 'v4 Turbo — natural y muy rápido (recomendado)' },
  { id: 'eleven_flash_v2_5', name: 'Flash v2.5 — el más barato' },
  { id: 'eleven_v3_conversational', name: 'v3 Conversational — muy expresivo, algo más lento' },
];

export class ElevenError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, key, options = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      ...options,
      // Sin espacios ni caracteres invisibles que se cuelan al copiar y pegar.
      headers: {
        'xi-api-key': key.replace(/[^\x21-\x7E]/g, ''),
        ...(typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ElevenError('Sin conexión con ElevenLabs.', 0);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.detail?.message || body?.detail?.status || '';
    } catch {}
    const msg =
      res.status === 401 ? 'La clave de ElevenLabs no es válida o le faltan permisos.'
      : res.status === 402 || /quota|credit/i.test(detail) ? 'Se han acabado los créditos de ElevenLabs.'
      : res.status === 429 ? 'ElevenLabs está saturado. Inténtalo en un momento.'
      : `ElevenLabs ha dado un error (${res.status}).`;
    throw new ElevenError(msg, res.status);
  }
  return res;
}

export async function listVoices(key) {
  const voices = [];
  let token = null;
  do {
    const qs = new URLSearchParams({ page_size: '100' });
    if (token) qs.set('next_page_token', token);
    const data = await (await request(`/v2/voices?${qs}`, key)).json();
    voices.push(...data.voices);
    token = data.has_more ? data.next_page_token : null;
  } while (token);
  return voices.map((v) => ({
    id: v.voice_id,
    name: v.name,
    accent: v.labels?.accent || '',
    gender: v.labels?.gender || '',
    language: v.labels?.language || '',
  }));
}

export async function getUsage(key) {
  const data = await (await request('/v1/user/subscription', key)).json();
  return { used: data.character_count, limit: data.character_limit, resetsAt: data.next_character_count_reset_unix };
}

export async function synthesize(text, { key, voiceId, model, lang, speed, previousText, signal }) {
  // 64 kbps: para una voz suena igual de bien y el archivo llega el doble de rápido al móvil.
  const res = await request(`/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_64`, key, {
    method: 'POST',
    signal,
    body: JSON.stringify({
      text,
      model_id: model,
      language_code: lang,
      previous_text: previousText || undefined,
      voice_settings: { speed: Math.min(1.2, Math.max(0.7, speed)) },
    }),
  });
  return res.blob();
}

// Pasa a texto lo que ha dicho (audio en bruto: 16 kHz, 16 bits, mono). Con un reintento si
// la red falla o tarda; devuelve '' si no se ha entendido nada.
export async function transcribe(pcm, { key, lang }) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    try {
      const form = new FormData();
      form.append('model_id', 'scribe_v2');
      form.append('file', new Blob([pcm.buffer], { type: 'application/octet-stream' }), 'voz.pcm');
      form.append('file_format', 'pcm_s16le_16');
      form.append('language_code', lang);
      form.append('tag_audio_events', 'false');
      const data = await (await request('/v1/speech-to-text', key, { method: 'POST', body: form, signal: ctrl.signal })).json();
      return (data.text || '').trim();
    } catch (err) {
      const transient = err.name === 'AbortError' || !err.status || err.status === 429 || err.status >= 500;
      if (!transient || attempt >= 1) throw err.name === 'AbortError' ? new ElevenError('ElevenLabs tarda demasiado en entender el audio.', 0) : err;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Una décima de segundo de silencio en WAV, para "desbloquear" el audio en el móvil.
export function silentWav() {
  const samples = 800;
  const rate = 8000;
  const v = new DataView(new ArrayBuffer(44 + samples));
  const str = (offset, s) => [...s].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  str(36, 'data');
  v.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([v.buffer], { type: 'audio/wav' }));
}
