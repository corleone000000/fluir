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

// En iPhone, después de usar el micrófono el sonido sale por el auricular de llamada.
// Como nunca escuchamos y hablamos a la vez, cambiamos el modo de audio según el turno:
// 'speak' = altavoz (como un vídeo), 'listen' = el móvil elige el modo para grabar.
// Solo se cambia si hace falta: reconfigurar el audio mientras algo suena puede cortarlo.
export function audioMode(mode) {
  const session = navigator.audioSession;
  if (!session) return;
  const type = mode === 'speak' ? 'playback' : 'auto';
  if (session.type === type) return;
  try {
    session.type = type;
  } catch {}
}

// iPhone solo deja hablar al navegador si la primera vez ocurre dentro de un toque en la pantalla.
let speechUnlocked = false;
export function unlockSpeech() {
  if (!canSpeak || speechUnlocked) return;
  speechUnlocked = true;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  window.speechSynthesis.speak(u);
}

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
  stopSpeaking();
  audioMode('speak');
  window.speechSynthesis.speak(utterance(text, langCode, rate, voiceURI));
}

// Cola propia, una frase cada vez: la cola del navegador a veces se salta frases o se atasca.
let queueTail = Promise.resolve();
let generation = 0;
const finishers = new Set(); // cómo dar por terminada cada frase pendiente
const keepAlive = new Set(); // Chrome descarta frases sin referencia antes de leerlas

// Añade una frase a la cola sin cortar la anterior. La promesa siempre se cumple: al terminar de
// leerla, si se corta con stopSpeaking o, como muy tarde, al pasar el tiempo que debería durar.
export function speakQueued(text, langCode, rate = 1, voiceURI = '') {
  const gen = generation;
  const job = queueTail.then(() => (gen === generation ? speakOne(text, langCode, rate, voiceURI) : undefined));
  queueTail = job;
  return job;
}

function speakOne(text, langCode, rate, voiceURI) {
  return new Promise((resolve) => {
    if (!canSpeak || !text.trim()) return resolve();
    const synth = window.speechSynthesis;
    const u = utterance(text, langCode, rate, voiceURI);
    let timer = null;
    const done = () => {
      if (!finishers.delete(done)) return;
      keepAlive.delete(u);
      clearTimeout(timer);
      resolve();
    };
    finishers.add(done);
    keepAlive.add(u);
    u.onend = done;
    u.onerror = done;
    // Unos 10 caracteres por segundo a velocidad normal, con margen de sobra.
    timer = setTimeout(() => {
      synth.cancel();
      done();
    }, (text.length / (10 * rate)) * 1000 + 5000);
    audioMode('speak');
    if (synth.paused) synth.resume();
    synth.speak(u);
  });
}

export function stopSpeaking() {
  generation++;
  queueTail = Promise.resolve();
  if (canSpeak) window.speechSynthesis.cancel();
  [...finishers].forEach((done) => done());
}

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const canListen = Boolean(Recognition);

// Escucha una frase. onText recibe el texto parcial y final; onEnd se llama una sola vez al terminar.
// Devuelve { stop, abort }: stop termina y conserva lo dicho, abort lo descarta.
export function listen(langCode, { onText, onEnd, onError }) {
  if (!canListen) return null;
  audioMode('listen');
  const rec = new Recognition();
  rec.lang = langCode;
  rec.interimResults = true;
  rec.continuous = false;
  let ended = false;
  let guard = null;
  const finish = () => {
    if (ended) return;
    ended = true;
    clearTimeout(guard);
    onEnd?.();
  };
  rec.onresult = (e) => {
    if (ended) return;
    let text = '';
    for (const r of e.results) text += r[0].transcript;
    onText(text, e.results[e.results.length - 1].isFinal);
  };
  rec.onerror = (e) => onError?.(e.error);
  rec.onend = finish;
  // En iPhone a veces no llega el aviso de fin: si tarda, lo damos por terminado nosotros.
  const end = (method) => {
    try {
      rec[method]();
    } catch {}
    if (!guard) guard = setTimeout(finish, 1200);
  };
  try {
    rec.start();
  } catch {
    onError?.('start-failed');
    setTimeout(finish);
  }
  return { stop: () => end('stop'), abort: () => end('abort') };
}
