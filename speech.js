// Voz del propio móvil: leer en voz alta y dictar (gratis, sin servidor).

let voicesCache = [];
const listeners = new Set();
function loadVoices() {
  voicesCache = window.speechSynthesis?.getVoices() || [];
  listeners.forEach((fn) => fn());
}
if ('speechSynthesis' in window) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

export const canSpeak = 'speechSynthesis' in window;

// Avisa cuando el navegador termina de cargar la lista de voces (llega con retraso).
export function onVoicesChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Puntuación aproximada de calidad según el nombre de la voz.
function quality(v) {
  const n = v.name.toLowerCase();
  if (/premium|neural|natural/.test(n)) return 3;
  if (/enhanced|mejorada|siri|google|online/.test(n)) return 2;
  if (v.localService === false) return 1;
  return 0;
}

// Voces disponibles para un idioma ("en-US" → todas las de inglés), las mejores primero.
export function voicesFor(langCode) {
  const prefix = langCode.slice(0, 2);
  return voicesCache
    .filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith(prefix))
    .sort((a, b) =>
      quality(b) - quality(a) ||
      Number(b.lang.replace('_', '-') === langCode) - Number(a.lang.replace('_', '-') === langCode) ||
      a.name.localeCompare(b.name));
}

export function isGoodVoice(v) {
  return quality(v) >= 2;
}

function utterance(text, langCode, rate, voiceURI) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = langCode;
  u.rate = rate;
  const options = voicesFor(langCode);
  const voice = options.find((v) => v.voiceURI === voiceURI) || options[0];
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  }
  return u;
}

export function speak(text, langCode, rate = 1, voiceURI = '') {
  if (!canSpeak || !text) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance(text, langCode, rate, voiceURI));
}

// Chrome a veces descarta las frases en cola antes de leerlas si nadie las referencia.
const queued = new Set();

// Añade una frase a la cola sin cortar la anterior. La promesa se resuelve al terminar de leerla
// (o si se cancela con stopSpeaking).
export function speakQueued(text, langCode, rate = 1, voiceURI = '') {
  return new Promise((resolve) => {
    if (!canSpeak || !text.trim()) return resolve();
    const u = utterance(text, langCode, rate, voiceURI);
    queued.add(u);
    const done = () => {
      queued.delete(u);
      resolve();
    };
    u.onend = done;
    u.onerror = done;
    window.speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  if (canSpeak) window.speechSynthesis.cancel();
}

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canListen = Boolean(Recognition);

// Escucha una frase. onText recibe el texto parcial y final; onEnd se llama al terminar.
export function listen(langCode, { onText, onEnd, onError }) {
  if (!canListen) return null;
  const rec = new Recognition();
  rec.lang = langCode;
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (e) => {
    let text = '';
    for (const r of e.results) text += r[0].transcript;
    onText(text, e.results[e.results.length - 1].isFinal);
  };
  rec.onerror = (e) => onError?.(e.error);
  rec.onend = () => onEnd?.();
  rec.start();
  return rec;
}
