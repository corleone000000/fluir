// Oír a la alumna con el micrófono: detecta cuándo empieza y cuándo termina de hablar
// (sin depender del dictado del móvil) y devuelve su voz lista para transcribir con ElevenLabs.
import { audioMode } from './speech.js';

const RATE = 16000; // lo que pide la transcripción en bruto (16 kHz, 16 bits, mono)
const FRAME = 2048;
const PREROLL_S = 0.5; // se guarda un poco antes de que empiece a hablar para no cortar la primera palabra
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const AC = window.AudioContext || window.webkitAudioContext;
let ctx = null;

export const canRecord = Boolean(navigator.mediaDevices?.getUserMedia && AC);

// Hay que llamarlo dentro de un toque en la pantalla (iPhone solo deja usar el audio así).
export function unlockMic() {
  if (!AC) return;
  try {
    if (!ctx || ctx.state === 'closed') ctx = new AC();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  } catch {}
}

// Pasa el audio del micrófono (44,1 o 48 kHz) a 16 kHz.
function downsample(input, sampleRate) {
  const ratio = sampleRate / RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to; j++) sum += input[j];
    out[i] = sum / Math.max(1, to - from);
  }
  return out;
}

function toInt16(chunks, from, to) {
  const out = new Int16Array(Math.max(0, to - from));
  let pos = 0;
  let k = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++, pos++) {
      if (pos < from) continue;
      if (pos >= to) return out;
      const s = Math.max(-1, Math.min(1, chunk[i]));
      out[k++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  return out;
}

// Graba una intervención. Devuelve { stop(), cancel(), result } y result se cumple con { pcm, reason }:
//   'speech'  ha hablado y luego se ha callado    'manual'  ha tocado para enviar ya
//   'silence' nadie ha hablado a tiempo           'stopped' ha tocado antes de hablar
//   'denied'  no hay permiso de micrófono         'no-audio' / 'error' el micrófono no funciona
export function record({ endSilenceMs = 1300, maxWaitMs = 15000, maxSpeechMs = 45000, onLevel, onSpeech } = {}) {
  let resolve;
  const result = new Promise((r) => (resolve = r));
  let stream = null;
  let source = null;
  let proc = null;
  let sink = null;
  let done = false;
  const timers = [];

  let chunks = [];
  let total = 0; // muestras guardadas (a 16 kHz)
  let frames = 0;
  let floor = 0.003; // ruido de fondo (se va aprendiendo)
  let voicedMs = 0;
  let silentMs = 0;
  let speechAt = -1; // muestra donde empezó a hablar
  let lastVoiceAt = 0;
  let speechStarted = 0;

  const end = (reason) => {
    if (done) return;
    done = true;
    timers.forEach(clearTimeout);
    try {
      if (proc) proc.onaudioprocess = null;
      proc?.disconnect();
      source?.disconnect();
      sink?.disconnect();
    } catch {}
    stream?.getTracks().forEach((t) => t.stop());
    let pcm = null;
    if (speechAt >= 0 && reason !== 'cancel') {
      const from = Math.max(0, speechAt - PREROLL_S * RATE);
      const to = reason === 'manual' ? total : Math.min(total, lastVoiceAt + 0.35 * RATE);
      if (to - from > RATE * 0.25) pcm = toInt16(chunks, from, to);
    }
    resolve({ pcm, reason: pcm || reason !== 'speech' ? reason : 'silence' });
  };

  function onFrame(input, sampleRate) {
    frames++;
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    const ms = (input.length / sampleRate) * 1000;
    const down = downsample(input, sampleRate);
    chunks.push(down);
    total += down.length;
    onLevel?.(Math.min(1, rms / 0.12));

    const startAt = Math.max(0.015, floor * 3.5);
    const keepAt = Math.max(0.009, floor * 2.2);
    if (speechAt < 0) {
      if (rms > startAt) {
        voicedMs += ms;
        if (voicedMs >= 120) {
          speechAt = Math.max(0, total - Math.round((voicedMs / 1000) * RATE));
          lastVoiceAt = total;
          speechStarted = performance.now();
          onSpeech?.();
        }
      } else {
        voicedMs = 0;
        floor = floor * 0.95 + Math.min(rms, 0.05) * 0.05;
        // Antes de que hable solo hace falta guardar el último segundo.
        while (chunks.length > 1 && total - chunks[0].length > RATE) {
          total -= chunks.shift().length;
        }
      }
    } else {
      if (rms > keepAt) {
        silentMs = 0;
        lastVoiceAt = total;
      } else {
        silentMs += ms;
      }
      if (silentMs >= endSilenceMs || performance.now() - speechStarted > maxSpeechMs) end('speech');
    }
  }

  (async () => {
    try {
      audioMode('listen');
      unlockMic();
      if (!ctx) throw new Error('sin audio');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      if (done) return stream.getTracks().forEach((t) => t.stop());
      if (ctx.state !== 'running') await Promise.race([ctx.resume().catch(() => {}), sleep(500)]);
      source = ctx.createMediaStreamSource(stream);
      proc = ctx.createScriptProcessor(FRAME, 1, 1);
      sink = ctx.createGain();
      sink.gain.value = 0;
      proc.onaudioprocess = (e) => {
        if (!done) onFrame(e.inputBuffer.getChannelData(0), e.inputBuffer.sampleRate);
      };
      source.connect(proc);
      proc.connect(sink);
      sink.connect(ctx.destination);
      // Si en 1,5 s no llega nada del micrófono, algo falla: quien llama usará el dictado del móvil.
      timers.push(setTimeout(() => !frames && end('no-audio'), 1500));
      timers.push(setTimeout(() => speechAt < 0 && end('silence'), maxWaitMs));
    } catch (err) {
      end(err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'denied' : 'error');
    }
  })();

  return {
    stop: () => end(speechAt >= 0 ? 'manual' : 'stopped'),
    cancel: () => end('cancel'),
    result,
  };
}
