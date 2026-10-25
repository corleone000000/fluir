// Voz del tutor: dice el texto frase a frase con ElevenLabs (si está activado) o con la voz del móvil.
// Pensado para no quedarse nunca colgado: cada paso tiene un tiempo máximo, si ElevenLabs falla
// esa frase la dice la voz del móvil, y cancel() lo corta y lo da todo por terminado al momento.
import { speakQueued, stopSpeaking, audioMode, unlockSpeech } from './speech.js';
import { synthesize, silentWav } from './elevenlabs.js';

const FETCH_TIMEOUT_MS = 7000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// Quita lo que no se debe leer en voz alta: emojis, símbolos de formato y etiquetas.
export function speakable(text) {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[*_#`~|]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[‍️]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Divide un texto en frases.
export function sentences(text) {
  return (text.match(/[^.!?…]+(?:[.!?…]+|$)/g) || []).map((s) => s.trim()).filter(Boolean);
}

// getConfig(lang) → { rate, deviceLang, voiceURI, eleven: { key, model, voiceId } | null }
export function createSpeaker({ getConfig, onElevenError }) {
  const audio = new Audio();
  audio.preload = 'auto';
  let elevenBroken = false; // clave mala o sin créditos: el resto de la sesión, voz del móvil
  let current = null;

  // Hay que llamarlo dentro de un toque en la pantalla (iPhone solo deja sonar audio así).
  function unlock() {
    unlockSpeech();
    if (audio.dataset.unlocked) return;
    audio.src = silentWav();
    audio
      .play()
      .then(() => (audio.dataset.unlocked = '1'))
      .catch(() => {});
  }

  function stop() {
    current?.cancel();
    current = null;
    stopSpeaking();
    try {
      audio.pause();
    } catch {}
  }

  // Empieza un turno de habla. Devuelve { push(texto), finish() → promesa, cancel() }.
  // finish() se cumple cuando se ha dicho todo o se ha cortado; nunca se queda esperando.
  function begin(lang, { rateFactor = 1, override = null, onError = onElevenError } = {}) {
    stop();
    audioMode('speak');
    const cfg = getConfig(lang);
    const eleven = override || cfg.eleven;
    const rate = clamp(cfg.rate * rateFactor, 0.5, 1.6);
    // ElevenLabs acepta 0,7–1,2; lo que falte o sobre se ajusta al reproducir (sin cambiar el tono).
    const elSpeed = clamp(rate, 0.7, 1.2);
    const playbackRate = clamp(rate / elSpeed, 0.5, 2);
    const useEleven = () => Boolean(eleven?.key && eleven?.voiceId) && !elevenBroken;

    const queue = []; // texto pendiente de convertir en voz
    const ready = []; // trozos listos para sonar, en orden
    const controllers = new Set();
    const stopHooks = new Set();
    let fetching = false;
    let playing = false;
    let inputDone = false;
    let cancelled = false;
    let firstRequest = true;
    let previousText = '';
    let resolveDone;
    const done = new Promise((resolve) => (resolveDone = resolve));

    const deviceSay = (text) => speakQueued(text, cfg.deviceLang, rate, cfg.voiceURI);

    async function fetchAudio(text) {
      for (let attempt = 0; ; attempt++) {
        const ctrl = new AbortController();
        controllers.add(ctrl);
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
          const blob = await synthesize(text, { ...eleven, lang, speed: elSpeed, previousText, signal: ctrl.signal });
          previousText = text;
          return blob;
        } catch (err) {
          if (cancelled) throw err;
          // Sin red, tiempo agotado, saturado (429) o error del servidor: un reintento.
          const transient = !err?.status || err.status === 429 || err.status >= 500;
          if (!transient || attempt >= 1) throw err;
          await sleep(600);
        } finally {
          clearTimeout(timer);
          controllers.delete(ctrl);
        }
      }
    }

    // Resuelve true si ha sonado (o se ha dado por terminado) y false si no ha podido sonar.
    function playBlob(blob) {
      return new Promise((resolve) => {
        if (cancelled) return resolve(true);
        const url = URL.createObjectURL(blob);
        let finished = false;
        let triedResume = false;
        let timer = null;
        const finish = (played) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          audio.onended = audio.onerror = audio.onpause = audio.onloadedmetadata = null;
          stopHooks.delete(onStop);
          URL.revokeObjectURL(url);
          resolve(played);
        };
        const onStop = () => finish(true);
        stopHooks.add(onStop);
        const arm = (ms) => {
          clearTimeout(timer);
          timer = setTimeout(() => finish(true), ms);
        };
        arm(25000); // por si nunca llega a cargar
        audio.onloadedmetadata = () => {
          if (Number.isFinite(audio.duration)) arm((audio.duration / playbackRate) * 1000 + 3000);
        };
        audio.onended = () => finish(true);
        audio.onerror = () => finish(false);
        audio.onpause = () => {
          if (finished || audio.ended) return;
          if (cancelled) return finish(true);
          // Lo ha pausado el sistema (cambio de audio, notificación…): se intenta seguir una vez.
          if (triedResume) return finish(true);
          triedResume = true;
          audio.play().catch(() => finish(true));
        };
        audio.src = url;
        audio.defaultPlaybackRate = playbackRate;
        audio.playbackRate = playbackRate;
        audio.play().catch(() => finish(false));
      });
    }

    function pump() {
      if (cancelled) return;
      if (useEleven()) {
        // Una petición cada vez (los planes de ElevenLabs limitan las simultáneas) y como mucho
        // un trozo preparado de reserva. La primera frase va sola para empezar a hablar cuanto antes;
        // después se junta todo lo pendiente en una sola petición.
        if (!fetching && queue.length && ready.length < 2) {
          const text = firstRequest ? queue.shift() : queue.splice(0).join(' ');
          firstRequest = false;
          fetching = true;
          fetchAudio(text)
            .then((blob) => ready.push({ text, blob }))
            .catch((err) => {
              if (cancelled) return;
              if ([401, 402, 403].includes(err?.status) || /créditos/i.test(err?.message || '')) elevenBroken = true;
              onError?.(err);
              ready.push({ text, blob: null });
            })
            .finally(() => {
              fetching = false;
              pump();
            });
        }
      } else if (queue.length) {
        ready.push(...queue.splice(0).map((text) => ({ text, blob: null })));
      }

      if (!playing && ready.length) {
        const item = ready.shift();
        playing = true;
        (item.blob ? playBlob(item.blob) : Promise.resolve(false))
          .then((played) => (played || cancelled ? null : deviceSay(item.text)))
          .then(() => {
            playing = false;
            pump();
          });
        return;
      }
      if (!playing && !fetching && !queue.length && !ready.length && inputDone) resolveDone();
    }

    const session = {
      push(text) {
        if (cancelled || inputDone) return;
        const clean = speakable(text);
        if (!clean) return;
        queue.push(clean);
        pump();
      },
      finish() {
        inputDone = true;
        pump();
        return done;
      },
      cancel() {
        if (cancelled) return;
        cancelled = true;
        controllers.forEach((c) => c.abort());
        [...stopHooks].forEach((fn) => fn());
        stopSpeaking();
        resolveDone();
      },
    };
    current = session;
    return session;
  }

  return { begin, stop, unlock };
}
