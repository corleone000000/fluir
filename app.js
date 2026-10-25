import { LANGS, DECKS, EXERCISES, SCENARIOS } from './data.js';
import * as S from './store.js';
import { state, save } from './store.js';
import { speak, canSpeak, canListen, listen, voicesFor, isGoodVoice, onVoicesChanged } from './speech.js';
import * as AI from './ai.js';
import * as EL from './elevenlabs.js';
import { createSpeaker, sentences } from './voice.js';
import { canRecord, record, unlockMic } from './hearing.js';

const $screen = document.getElementById('screen');
const $title = document.getElementById('screen-title');
const $back = document.getElementById('back-btn');

// ---------- Utilidades ----------

const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Compara frases sin tener en cuenta mayúsculas, tildes ni puntuación.
const normalize = (s) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[¿?¡!.,;:"“”«»—–-]/g, ' ').replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();

const voice = () => LANGS[state.lang].voice;
const say = (text, slow = false, lang = state.lang) =>
  speak(text, LANGS[lang].voice, state.settings.rate * (slow ? 0.7 : 1), state.settings.voices[lang]);

// Voz del tutor: ElevenLabs si está activada; si no (o si falla), la voz gratis del móvil.
let elevenWarned = false;
const speaker = createSpeaker({
  getConfig: (lang) => {
    const s = state.settings;
    const e = s.eleven;
    return {
      rate: s.rate,
      deviceLang: LANGS[lang].voice,
      voiceURI: s.voices[lang],
      eleven: e.enabled && e.key && e.voices[lang] ? { key: e.key, model: e.model, voiceId: e.voices[lang] } : null,
    };
  },
  onElevenError: (err) => {
    if (elevenWarned) return;
    elevenWarned = true;
    toast(`${err.message} Sigo con la voz del móvil.`);
  },
});
const stopAllVoices = () => speaker.stop();

// Para entender lo que dice: si hay ElevenLabs, la app graba su voz y ElevenLabs la transcribe
// (entiende mucho mejor a quien está aprendiendo). Si no se puede, se usa el dictado del móvil.
let cloudEarsOff = false;
const cloudEars = () => {
  const e = state.settings.eleven;
  return canRecord && !cloudEarsOff && e.enabled && Boolean(e.key) && e.stt !== false;
};
// Pasa al dictado del móvil el resto de la sesión, explicando por qué.
function earsFallback(reason) {
  if (cloudEarsOff) return;
  cloudEarsOff = true;
  toast(
    reason === 'permission'
      ? 'Tu clave de ElevenLabs no tiene permiso de «Speech to Text». De momento uso el dictado del móvil.'
      : 'No puedo usar el micrófono así en este móvil. Uso el dictado del móvil.',
  );
}
const transcribe = (pcm, lang) => EL.transcribe(pcm, { key: state.settings.eleven.key, lang });

// Lee en voz alta una respuesta ya completa del tutor.
function tutorSay(text, slow = false) {
  speaker.unlock();
  const talk = speaker.begin(state.lang, { rateFactor: slow ? 0.8 : 1 });
  sentences(text).forEach((s) => talk.push(s));
  return talk.finish();
}

// El tutor llama a esto cuando ella pide que hable más despacio o más rápido.
// Cambia la velocidad guardada (la misma que el control de Ajustes) y devuelve qué ha pasado.
const SPEED_FACTORS = { much_slower: 0.75, slower: 0.87, faster: 1.15, much_faster: 1.3 };
const MIN_RATE = 0.6;
const MAX_RATE = 1.4;
function applySpeed(change) {
  const s = state.settings;
  const before = s.rate;
  const target = change === 'normal' ? 1 : before * SPEED_FACTORS[change];
  const next = Math.round(Math.min(MAX_RATE, Math.max(MIN_RATE, target)) * 100) / 100;
  s.rate = next;
  save();
  const fmt = (n) => `${n.toFixed(2).replace('.', ',')}×`;
  if (next === before) {
    toast(change === 'normal' ? 'La voz ya va a velocidad normal' : `La voz ya está al ${next <= MIN_RATE ? 'mínimo' : 'máximo'} (${fmt(next)})`);
    return change === 'normal'
      ? `The speed was already normal (${next}×).`
      : `The speed is already at the ${next <= MIN_RATE ? 'slowest' : 'fastest'} setting (${next}×), so it could not change. Tell the student briefly.`;
  }
  toast(`${next < before ? '🐢 Más despacio' : '🐇 Más rápido'}: ${fmt(next)}`);
  return `Done. Your voice now speaks at ${next}× (it was ${before}×; 1× is the normal speed).`;
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function gainXP(n) {
  const { reachedGoal } = S.addXP(n);
  if (reachedGoal) toast(`🎉 ¡Objetivo diario cumplido! Racha: ${S.currentStreak()} 🔥`);
}

// ---------- Navegación ----------

const TABS = ['home', 'tutor', 'cards', 'practice', 'progress'];
let current = { name: 'home', params: {} };
let backTarget = null;
let cleanup = null;

function go(name, params = {}) {
  cleanup?.();
  cleanup = null;
  stopAllVoices();
  current = { name, params };
  const tab = SCREENS[name].tab || name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.go === tab));
  backTarget = SCREENS[name].back || null;
  $back.hidden = !backTarget;
  $title.textContent = SCREENS[name].title?.() ?? 'Fluir';
  $screen.innerHTML = '';
  SCREENS[name].render(params);
  window.scrollTo(0, 0);
}

$back.addEventListener('click', () => backTarget && go(backTarget));
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => go(t.dataset.go)));

function renderLangSwitch() {
  document.querySelectorAll('.lang-btn').forEach((b) => b.classList.toggle('active', b.dataset.lang === state.lang));
}
document.querySelectorAll('.lang-btn').forEach((b) =>
  b.addEventListener('click', () => {
    if (state.lang === b.dataset.lang) return;
    state.lang = b.dataset.lang;
    save();
    renderLangSwitch();
    const tab = SCREENS[current.name].tab || current.name;
    go(TABS.includes(tab) ? tab : 'home');
  }),
);

function html(str) {
  $screen.insertAdjacentHTML('beforeend', str);
}
const on = (sel, ev, fn) => $screen.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, fn));

// ---------- Inicio ----------

function renderHome() {
  const streak = S.currentStreak();
  const xp = S.todayXP();
  const goal = state.settings.dailyGoal;
  const pct = Math.min(100, Math.round((xp / goal) * 100));
  const due = S.countDue(state.lang);
  const L = LANGS[state.lang];
  const hi = state.settings.name ? `¡Hola, ${esc(state.settings.name)}!` : '¡Hola!';

  html(`
    <div class="card">
      <div class="hero">
        <div class="flame ${xp > 0 ? '' : 'off'}">🔥</div>
        <div class="grow">
          <div class="row"><span class="streak-num">${streak}</span><span class="muted">${streak === 1 ? 'día seguido' : 'días seguidos'}</span></div>
          <div class="muted">${xp > 0 ? 'Hoy ya has practicado 💪' : 'Practica hoy para no perder la racha'}</div>
        </div>
      </div>
      <div style="margin-top:14px">
        <div class="row" style="justify-content:space-between;margin-bottom:6px">
          <b>Objetivo de hoy</b><span class="muted">${xp} / ${goal} XP</span>
        </div>
        <div class="bar ${pct >= 100 ? 'good' : ''}"><div style="width:${pct}%"></div></div>
      </div>
    </div>
    <p class="muted" style="margin:4px 2px 12px">${hi} Estás practicando <b>${L.flag} ${L.name}</b>. Cambia de idioma arriba a la derecha.</p>
    ${state.settings.apiKey ? '' : `
      <button class="tile" data-act="settings" style="border-color:var(--primary)">
        <div class="emoji">🔑</div>
        <div class="grow"><strong>Activa el tutor con IA</strong><span class="muted">Añade tu clave de la API en Ajustes</span></div>
      </button>`}
    <button class="tile" data-act="tutor">
      <div class="emoji">💬</div>
      <div class="grow"><strong>Hablar con el tutor</strong><span class="muted">Conversa por voz o texto y recibe correcciones</span></div>
    </button>
    <button class="tile" data-act="cards">
      <div class="emoji">🃏</div>
      <div class="grow"><strong>Tarjetas</strong><span class="muted">Vocabulario con repaso inteligente</span></div>
      ${due ? `<span class="badge">${due}</span>` : ''}
    </button>
    <button class="tile" data-act="practice">
      <div class="emoji">✍️</div>
      <div class="grow"><strong>Lección rápida</strong><span class="muted">8 ejercicios de gramática, orden y escucha</span></div>
    </button>
    <button class="tile" data-act="settings">
      <div class="emoji">⚙️</div>
      <div class="grow"><strong>Ajustes</strong><span class="muted">Clave de la IA, objetivo diario, voz y copia de seguridad</span></div>
    </button>
  `);
  on('[data-act]', 'click', (e) => {
    const act = e.currentTarget.dataset.act;
    if (act === 'practice') go('lesson', { mode: 'mix' });
    else go(act);
  });
}

// ---------- Tutor ----------

function renderTutor() {
  const chat = state.chats[state.lang];
  if (chat) return renderChat(chat);
  html(`
    <p class="muted" style="margin-top:0">Elige una situación. El tutor te hablará en <b>${LANGS[state.lang].name.toLowerCase()}</b> y te corregirá con cariño.</p>
    <div class="scenarios">
      ${SCENARIOS.map((s) => `
        <button class="scenario" data-id="${s.id}">
          <span style="font-size:1.5rem">${s.emoji}</span>
          <b>${esc(s.name)}</b><small>${esc(s.desc)}</small>
        </button>`).join('')}
    </div>
  `);
  on('.scenario', 'click', (e) => {
    const scenario = e.currentTarget.dataset.id;
    state.chats[state.lang] = { scenario, messages: [{ role: 'user', content: AI.KICKOFF, hidden: true }] };
    save();
    go('tutor');
  });
}

function renderChat(chat) {
  const lang = state.lang;
  const scenario = SCENARIOS.find((s) => s.id === chat.scenario) || SCENARIOS[0];
  html(`
    <div class="row" style="margin-bottom:10px">
      <div class="grow"><b>${scenario.emoji} ${esc(scenario.name)}</b></div>
      <button class="btn ghost" id="auto-speak" title="Leer respuestas en voz alta">${state.settings.autoSpeak ? '🔊' : '🔇'}</button>
      <button class="btn secondary" id="new-chat" style="padding:8px 12px">Nueva</button>
    </div>
    ${canListen && canSpeak ? `
      <button class="btn block call-start" id="call">📞 Hablar como en una llamada</button>` : ''}
    <div class="chat" id="chat"></div>
    <div class="composer">
      <div class="composer-inner">
        ${canListen ? '<button class="mic" id="mic" aria-label="Hablar">🎤</button>' : ''}
        <textarea class="input" id="msg" rows="1" placeholder="${lang === 'en' ? 'Write in English…' : 'Escribe en español…'}"></textarea>
        <button class="btn send" id="send" aria-label="Enviar">➤</button>
      </div>
    </div>
  `);
  const $chat = document.getElementById('chat');
  const $msg = document.getElementById('msg');
  const $send = document.getElementById('send');
  let busy = false;
  let rec = null;

  function bubbleAI(text, { speakBtn = true } = {}) {
    const { reply, fixes } = AI.splitReply(text);
    if (fixes) $chat.insertAdjacentHTML('beforeend', `<div class="fix">✏️ ${esc(fixes)}</div>`);
    const el = document.createElement('div');
    el.className = 'msg ai';
    el.innerHTML = `<div class="txt">${esc(reply)}</div>${speakBtn ? '<div class="tools"><button data-say>🔊 Escuchar</button><button data-slow>🐢 Despacio</button></div>' : ''}`;
    el.querySelector('[data-say]')?.addEventListener('click', () => tutorSay(reply));
    el.querySelector('[data-slow]')?.addEventListener('click', () => tutorSay(reply, true));
    $chat.appendChild(el);
    return el;
  }

  function drawAll() {
    $chat.innerHTML = '';
    for (const m of chat.messages) {
      if (m.hidden) continue;
      if (m.role === 'user') {
        if (typeof m.content === 'string') $chat.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(m.content)}</div>`);
        continue;
      }
      const text = AI.messageText(m.content);
      if (text.trim()) bubbleAI(text);
    }
    scrollDown();
  }
  const scrollDown = () => window.scrollTo(0, document.body.scrollHeight);

  // Responde a lo último que ha dicho ella. Si falla, su mensaje se queda y se puede reintentar.
  async function askTutor() {
    busy = true;
    $send.disabled = true;
    $chat.querySelectorAll('.msg.err').forEach((el) => el.remove());
    const live = document.createElement('div');
    live.className = 'msg ai';
    live.innerHTML = '<span class="spinner"></span>';
    $chat.appendChild(live);
    scrollDown();
    try {
      const { text } = await AI.tutorTurn({
        lang,
        scenario,
        messages: chat.messages,
        onText: (acc) => {
          live.textContent = AI.splitReply(acc).reply;
          scrollDown();
        },
        onSpeed: applySpeed,
        commit: (msg) => {
          chat.messages.push(msg);
          save();
        },
      });
      live.remove();
      if (text.trim()) {
        bubbleAI(text);
        if (state.settings.autoSpeak) tutorSay(AI.splitReply(text).reply);
      }
      scrollDown();
      return true;
    } catch (err) {
      live.remove();
      const el = document.createElement('div');
      el.className = 'msg err';
      el.innerHTML = `${esc(AI.friendlyError(err))}<div class="tools"><button>🔄 Reintentar</button></div>`;
      el.querySelector('button').addEventListener('click', () => {
        if (!busy) askTutor();
      });
      $chat.appendChild(el);
      scrollDown();
      return false;
    } finally {
      busy = false;
      $send.disabled = false;
    }
  }

  async function send() {
    const text = $msg.value.trim();
    if (!text || busy) return;
    rec?.stop();
    stopAllVoices();
    speaker.unlock();
    $msg.value = '';
    chat.messages.push({ role: 'user', content: text });
    save();
    $chat.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(text)}</div>`);
    if (await askTutor()) {
      state.stats.tutorMessages += 1;
      gainXP(5);
    }
  }

  $send.addEventListener('click', send);
  $msg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  $msg.addEventListener('input', () => {
    $msg.style.height = 'auto';
    $msg.style.height = `${Math.min(120, $msg.scrollHeight)}px`;
  });

  const $mic = document.getElementById('mic');
  $mic?.addEventListener('click', async () => {
    if (rec) {
      rec.stop();
      return;
    }
    stopAllVoices();
    speaker.unlock();
    unlockMic();
    const before = $msg.value ? `${$msg.value.trim()} ` : '';
    $mic.classList.add('on');
    if (cloudEars()) {
      // Graba hasta que se calla (o vuelve a tocar el micro) y ElevenLabs lo pasa a texto.
      const placeholder = $msg.placeholder;
      $msg.placeholder = 'Te escucho…';
      const take = record({ endSilenceMs: 1600, maxWaitMs: 12000, onLevel: (v) => $mic.style.setProperty('--level', v.toFixed(2)) });
      rec = { stop: () => take.stop() };
      const { pcm, reason } = await take.result;
      rec = null;
      $mic.style.setProperty('--level', '0');
      try {
        if (pcm) {
          $msg.placeholder = 'Entendiendo…';
          const text = await transcribe(pcm, lang);
          if (text) $msg.value = before + text;
          else toast('No te he oído bien. Prueba otra vez.');
        } else if (reason === 'denied') {
          toast('Permite el micrófono en el navegador para hablar.');
        } else if (reason === 'no-audio' || reason === 'error') {
          earsFallback('device');
        }
      } catch (err) {
        if ([401, 403].includes(err?.status)) earsFallback('permission');
        else toast(err?.message || 'No he podido entenderte.');
      } finally {
        $msg.placeholder = placeholder;
        $mic.classList.remove('on');
      }
      return;
    }
    rec = listen(voice(), {
      onText: (t) => {
        $msg.value = before + t;
      },
      onError: (code) => {
        if (code === 'not-allowed') toast('Permite el micrófono en el navegador para hablar.');
        else if (code !== 'no-speech' && code !== 'aborted') toast('No se pudo usar el micrófono.');
      },
      onEnd: () => {
        rec = null;
        $mic.classList.remove('on');
      },
    });
  });

  document.getElementById('auto-speak').addEventListener('click', (e) => {
    state.settings.autoSpeak = !state.settings.autoSpeak;
    save();
    e.currentTarget.textContent = state.settings.autoSpeak ? '🔊' : '🔇';
    if (!state.settings.autoSpeak) stopAllVoices();
  });

  document.getElementById('new-chat').addEventListener('click', () => {
    state.chats[lang] = null;
    save();
    go('tutor');
  });

  document.getElementById('call')?.addEventListener('click', () => {
    if (busy) return toast('Espera a que el tutor termine de responder.');
    rec?.stop();
    stopAllVoices();
    speaker.unlock();
    unlockMic();
    if (state.settings.model !== 'claude-haiku-5-5') toast('💡 Para que el tutor conteste más rápido, elige «Claude Haiku 5.5» en Ajustes.');
    openCall({ chat, scenario, lang, onClose: () => go('tutor') });
  });

  cleanup = () => rec?.stop();
  drawAll();
  // Si lo último es de ella (o falta la respuesta tras cambiar la velocidad), el tutor contesta.
  const last = chat.messages[chat.messages.length - 1];
  if (last?.role === 'user') askTutor();
}

// ---------- Modo llamada ----------
// Bucle manos libres: escuchar → enviar al quedarse en silencio → el tutor habla → volver a escuchar.

function openCall({ chat, scenario, lang, onClose }) {
  const L = LANGS[lang];
  const overlay = document.createElement('div');
  overlay.className = 'call';
  overlay.innerHTML = `
    <div class="call-top">
      <b>${scenario.emoji} ${esc(scenario.name)}</b>
      <span id="call-time">00:00</span>
    </div>
    <button class="orb" id="orb" aria-label="Hablar o interrumpir"><span></span></button>
    <div class="call-status" id="call-status">Conectando…</div>
    <div class="call-subs" id="call-subs">
      <div class="call-you" id="call-you"></div>
      <div class="call-caption" id="call-caption"></div>
      <div class="call-fix" id="call-fix" hidden></div>
    </div>
    <div class="call-actions">
      <button class="call-btn" id="btn-subs">💬<small>Subtítulos</small></button>
      <button class="call-btn hang" id="btn-hang"><span class="ico">📞</span><small>Colgar</small></button>
      <button class="call-btn" id="btn-slow">🐢<small>Despacio</small></button>
    </div>`;
  document.body.appendChild(overlay);

  const $ = (id) => overlay.querySelector(`#${id}`);
  // Tiempos de escucha: 2 s de silencio tras hablar = ha terminado; nada en 8 s = se vuelve a intentar.
  const PAUSE_MS = 2000;
  const NO_SPEECH_MS = 8000;
  const MAX_SILENT_TRIES = 4;
  const AFTER_SPEECH_MS = 200; // para que el micro no oiga el final de la voz del tutor
  const END_SILENCE_MS = 1300; // con ElevenLabs: este silencio tras hablar = ha terminado
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Cada fase nueva (pensar, hablar, escuchar, pausa) sube `step`, y lo que llegue tarde de una
  // fase anterior se ignora: así nunca hay dos cosas a la vez ni estados colgados.
  let step = 0;
  let closed = false;
  let rec = null;
  let listenTimer = null;
  let silentTries = 0;
  let micDenied = false;
  let userStopped = false;
  let slow = false;
  let talk = null;
  let request = null; // respuesta en curso: { abort, done }
  let wakeLock = null;

  const started = Date.now();
  const clock = setInterval(() => {
    const s = Math.floor((Date.now() - started) / 1000);
    $('call-time').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
  const keepAwake = () => navigator.wakeLock?.request('screen').then((w) => (wakeLock = w)).catch(() => {});
  keepAwake();

  const setPhase = (phase, text) => {
    overlay.dataset.phase = phase;
    $('call-status').textContent = text;
  };
  // ¿Queda algo de ella sin responder?
  const unanswered = () => chat.messages[chat.messages.length - 1]?.role === 'user';

  function stopListening() {
    clearTimeout(listenTimer);
    const r = rec;
    rec = null;
    try {
      r?.abort();
    } catch {}
  }

  async function tutorTurn() {
    const my = ++step;
    stopListening();
    setPhase('thinking', 'Pensando…');
    if (request) await request.done; // que la respuesta anterior termine de guardarse
    if (my !== step || closed) return false;
    $('call-fix').hidden = true;
    $('call-caption').textContent = '';
    talk = speaker.begin(lang, { rateFactor: slow ? 0.8 : 1 });

    let fed = 0;
    const replyPart = (acc) => {
      const cut = acc.indexOf(AI.FIX_MARK);
      return cut === -1 ? acc.replace(/%$/, '') : acc.slice(0, cut);
    };
    // Pasa a la voz cada frase completa en cuanto llega, sin esperar al final de la respuesta.
    const feed = (reply, final) => {
      if (my !== step) return;
      for (;;) {
        let chunk = reply.slice(fed);
        if (!final) {
          const m = chunk.match(/^[\s\S]*?[.!?…]+(?=\s)/);
          if (!m) return;
          chunk = m[0];
        }
        fed += chunk.length;
        if (chunk.trim()) {
          if (overlay.dataset.phase === 'thinking') setPhase('speaking', 'Hablando… (toca para interrumpir)');
          talk.push(chunk);
        }
        if (final) return;
      }
    };

    const abort = new AbortController();
    const done = AI.tutorTurn({
      lang,
      scenario,
      messages: chat.messages,
      voice: true,
      signal: abort.signal,
      onText: (acc) => {
        if (my !== step) return;
        const reply = replyPart(acc);
        $('call-caption').textContent = reply.trim();
        feed(reply, false);
      },
      onSpeed: (change) => {
        const result = applySpeed(change);
        // Lo que diga a partir de aquí ya sale con la velocidad nueva.
        if (my === step) talk = speaker.begin(lang, { rateFactor: slow ? 0.8 : 1 });
        return result;
      },
      commit: (msg) => {
        chat.messages.push(msg);
        save();
      },
    });
    request = { abort, done: done.then(() => {}, () => {}) };
    try {
      const { text } = await done;
      if (my !== step || closed) return true;
      feed(replyPart(text), true);
      const { reply, fixes } = AI.splitReply(text);
      $('call-caption').textContent = reply;
      $('call-fix').textContent = fixes ? `✏️ ${fixes}` : '';
      $('call-fix').hidden = !fixes;
      await talk.finish();
      if (my !== step || closed) return true;
      await sleep(AFTER_SPEECH_MS);
      if (my === step && !closed) startListening();
      return true;
    } catch (err) {
      if (closed || my !== step || err?.message === 'ABORTED') return false;
      speaker.stop();
      setPhase('idle', `${AI.friendlyError(err)} Toca el círculo para reintentar.`);
      return false;
    } finally {
      if (request?.abort === abort) request = null;
    }
  }

  async function userTurn(text) {
    setPhase('thinking', 'Pensando…');
    if (request) await request.done; // su frase va detrás de la respuesta anterior
    if (closed) return;
    chat.messages.push({ role: 'user', content: text });
    save();
    if (await tutorTurn()) {
      state.stats.tutorMessages += 1;
      gainXP(5);
    }
  }

  function startListening() {
    if (closed) return;
    const my = ++step;
    stopListening();
    speaker.stop();
    let heard = '';
    userStopped = false;
    setPhase('listening', 'Te escucho… (toca el círculo para pausar)');
    $('call-you').textContent = '';
    if (cloudEars()) return listenCloud(my);
    const arm = (ms) => {
      clearTimeout(listenTimer);
      listenTimer = setTimeout(() => {
        if (my === step) rec?.stop();
      }, ms);
    };
    rec = listen(L.voice, {
      onText: (t) => {
        if (my !== step) return;
        heard = t;
        $('call-you').textContent = `«${t}»`;
        // Algunos móviles no cortan solos al quedarse en silencio: lo hacemos nosotros.
        arm(PAUSE_MS);
      },
      onError: (code) => {
        if (code === 'not-allowed' || code === 'service-not-allowed') micDenied = true;
      },
      onEnd: () => {
        if (my !== step || closed) return;
        clearTimeout(listenTimer);
        rec = null;
        const said = heard.trim();
        if (said) {
          silentTries = 0;
          userTurn(said);
        } else if (micDenied) {
          setPhase('idle', 'Permite el micrófono en el navegador y toca el círculo para hablar.');
        } else if (userStopped) {
          setPhase('idle', 'En pausa. Toca el círculo cuando quieras hablar.');
        } else if (++silentTries < MAX_SILENT_TRIES) {
          startListening();
        } else {
          const ios = navigator.standalone === true;
          setPhase('idle', `No te oigo. Toca el círculo para hablar.${ios ? ' Si sigue sin oírte, abre la app desde Safari.' : ''}`);
        }
      },
    });
    if (!rec) return setPhase('idle', 'Este navegador no permite usar el micrófono.');
    arm(NO_SPEECH_MS);
  }

  // Escucha con ElevenLabs: la app nota cuándo habla y cuándo calla (el círculo se mueve con su voz)
  // y después ElevenLabs pasa a texto lo que ha dicho.
  async function listenCloud(my) {
    const orb = $('orb');
    const take = record({
      endSilenceMs: END_SILENCE_MS,
      maxWaitMs: 15000,
      onLevel: (v) => my === step && orb.style.setProperty('--level', v.toFixed(2)),
      onSpeech: () => my === step && setPhase('listening', 'Te escucho… (toca el círculo para enviar ya)'),
    });
    rec = { stop: () => take.stop(), abort: () => take.cancel() };
    const { pcm, reason } = await take.result;
    orb.style.setProperty('--level', '0');
    if (my !== step || closed) return;
    rec = null;
    if (reason === 'no-audio' || reason === 'error') {
      earsFallback('device');
      return startListening();
    }
    if (reason === 'denied') return setPhase('idle', 'Permite el micrófono en el navegador y toca el círculo para hablar.');
    if (!pcm) {
      if (userStopped) return setPhase('idle', 'En pausa. Toca el círculo cuando quieras hablar.');
      if (++silentTries < MAX_SILENT_TRIES) return startListening();
      return setPhase('idle', 'No te oigo. Toca el círculo para hablar.');
    }
    setPhase('thinking', 'Entendiendo…');
    try {
      const text = await transcribe(pcm, lang);
      if (my !== step || closed) return;
      if (!text) return startListening(); // era ruido: seguimos escuchando
      silentTries = 0;
      $('call-you').textContent = `«${text}»`;
      userTurn(text);
    } catch (err) {
      if (my !== step || closed) return;
      if ([401, 403].includes(err?.status)) {
        earsFallback('permission');
        return setPhase('idle', 'No he podido entenderte. Toca el círculo y repítelo, por favor.');
      }
      setPhase('idle', `${err?.message || 'No he podido entenderte.'} Toca el círculo y repítelo, por favor.`);
    }
  }

  $('orb').addEventListener('click', () => {
    speaker.unlock();
    unlockMic();
    const phase = overlay.dataset.phase;
    if (phase === 'speaking') {
      // Corta al tutor y le toca a ella.
      startListening();
    } else if (phase === 'listening') {
      // Si ya ha dicho algo, lo envía; si no, deja la llamada en pausa.
      userStopped = true;
      if (rec) rec.stop();
      else startListening();
    } else if (phase === 'idle') {
      silentTries = 0;
      micDenied = false;
      if (unanswered()) tutorTurn();
      else startListening();
    }
  });

  $('btn-subs').addEventListener('click', (e) => {
    const hidden = $('call-subs').classList.toggle('off');
    e.currentTarget.classList.toggle('active', !hidden);
  });
  $('btn-subs').classList.add('active');

  $('btn-slow').addEventListener('click', (e) => {
    slow = !slow;
    e.currentTarget.classList.toggle('active', slow);
    toast(slow ? 'El tutor hablará más despacio' : 'Velocidad normal');
  });

  // Si sale de la app (o se bloquea el móvil), la llamada se pone en pausa y no se queda a medias.
  const onVisibility = () => {
    if (closed) return;
    if (document.visibilityState === 'hidden') {
      step++;
      request?.abort.abort();
      stopListening();
      speaker.stop();
      setPhase('idle', 'En pausa. Toca el círculo para seguir.');
    } else {
      keepAwake();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  // Colgar siempre cierra la pantalla, aunque el micrófono o el audio den problemas.
  $('btn-hang').addEventListener('click', () => {
    if (closed) return;
    closed = true;
    step++;
    overlay.remove();
    clearInterval(clock);
    document.removeEventListener('visibilitychange', onVisibility);
    for (const fn of [() => request?.abort.abort(), stopListening, () => speaker.stop(), () => wakeLock?.release().catch(() => {})]) {
      try {
        fn();
      } catch {}
    }
    onClose();
  });

  // Que el tutor salude al empezar la llamada (o conteste lo que quedara pendiente).
  if (!unanswered()) chat.messages.push({ role: 'user', content: AI.CALL_KICKOFF, hidden: true });
  tutorTurn();
}

// ---------- Tarjetas ----------

function renderCards() {
  const lang = state.lang;
  const total = S.countDue(lang);
  const st = S.cardStats(lang);
  html(`
    <div class="card">
      <div class="row">
        <div class="grow">
          <h2>${total ? `${total} tarjetas para hoy` : 'Todo al día ✅'}</h2>
          <div class="muted">${st.learned} aprendidas · ${st.mastered} dominadas · ${st.total} en total</div>
        </div>
      </div>
      <button class="btn block" id="review-all" style="margin-top:12px" ${total ? '' : 'disabled'}>Repasar ahora</button>
    </div>
    <h3 style="margin:18px 2px 10px">Mazos</h3>
    ${S.decksFor(lang).map((d) => {
      const n = S.countDue(lang, d.id);
      const size = d.id === 'custom' ? state.customCards[lang].length : DECKS[lang].find((x) => x.id === d.id).cards.length;
      return `
        <button class="tile" data-deck="${d.id}">
          <div class="emoji">${d.emoji}</div>
          <div class="grow"><strong>${esc(d.name)}</strong><span class="muted">${size} tarjetas</span></div>
          ${n ? `<span class="badge">${n}</span>` : ''}
        </button>`;
    }).join('')}
    <div class="grid2" style="margin-top:6px">
      <button class="btn secondary" id="add-card">➕ Añadir tarjeta</button>
      <button class="btn secondary" id="gen-cards">✨ Crear con IA</button>
    </div>
  `);
  document.getElementById('review-all').addEventListener('click', () => go('review', {}));
  on('[data-deck]', 'click', (e) => {
    const deck = e.currentTarget.dataset.deck;
    if (!S.countDue(lang, deck)) return toast('Este mazo no tiene tarjetas pendientes hoy.');
    go('review', { deck });
  });
  document.getElementById('add-card').addEventListener('click', () => go('addCard'));
  document.getElementById('gen-cards').addEventListener('click', () => go('genCards'));
}

function renderReview({ deck = null }) {
  const lang = state.lang;
  const queue = S.cardQueue(lang, deck);
  let done = 0;

  function next() {
    $screen.innerHTML = '';
    if (!queue.length) {
      html(`
        <div class="card empty">
          <div class="big">🎉</div>
          <h2>¡Sesión terminada!</h2>
          <p class="muted">Has repasado ${done} tarjeta${done === 1 ? '' : 's'}. Vuelve mañana para las siguientes.</p>
          <button class="btn block" id="finish">Volver a tarjetas</button>
        </div>`);
      document.getElementById('finish').addEventListener('click', () => go('cards'));
      return;
    }
    const card = queue[0];
    const isNew = !state.cards[lang][card.id];
    html(`
      <div class="row" style="margin-bottom:8px">
        <span class="muted grow">${isNew ? '🆕 Nueva' : '🔁 Repaso'}</span>
        <span class="muted">Quedan ${queue.length}</span>
      </div>
      <div class="card flash" id="flash">
        <div class="row" style="justify-content:center">
          <div class="front">${esc(card.front)}</div>
          <button class="speak" id="say-front">🔊</button>
        </div>
        <div id="reveal" hidden>
          <div class="back">${esc(card.back)}</div>
          ${card.example ? `<div class="row" style="justify-content:center;margin-top:10px"><div class="example">${esc(card.example)}</div><button class="speak" id="say-ex">🔊</button></div>` : ''}
        </div>
      </div>
      <button class="btn block" id="show">Mostrar respuesta</button>
      <div class="rate" id="rate" hidden>
        ${['Otra vez', 'Difícil', 'Bien', 'Fácil'].map((label, i) => `
          <button class="btn ${['again', 'hard', 'goodr', 'easy'][i]}" data-r="${i}">${label}<small>${S.previewInterval(lang, card.id, i)}</small></button>`).join('')}
      </div>
    `);
    say(card.front);
    document.getElementById('say-front').addEventListener('click', (e) => {
      e.stopPropagation();
      say(card.front);
    });
    const show = () => {
      document.getElementById('reveal').hidden = false;
      document.getElementById('show').hidden = true;
      document.getElementById('rate').hidden = false;
      document.getElementById('say-ex')?.addEventListener('click', () => say(card.example));
    };
    document.getElementById('show').addEventListener('click', show);
    document.getElementById('flash').addEventListener('click', show);
    on('[data-r]', 'click', (e) => {
      const r = Number(e.currentTarget.dataset.r);
      S.rateCard(lang, card.id, r);
      queue.shift();
      if (r === 0) queue.push(card); // vuelve a salir en esta misma sesión
      else done++;
      gainXP(2);
      next();
    });
  }
  next();
}

function renderAddCard() {
  const lang = state.lang;
  const meaning = LANGS[LANGS[lang].meaningLang].name.toLowerCase();
  html(`
    <div class="card">
      <label class="field"><span>Palabra o expresión en ${LANGS[lang].name.toLowerCase()}</span><input class="input" id="f" autocomplete="off"></label>
      <label class="field"><span>Significado (en ${meaning})</span><input class="input" id="b" autocomplete="off"></label>
      <label class="field"><span>Ejemplo (opcional)</span><input class="input" id="x" autocomplete="off"></label>
      <button class="btn block" id="save">Guardar tarjeta</button>
    </div>
    ${state.customCards[lang].length ? `
      <h3 style="margin:18px 2px 10px">Mis tarjetas</h3>
      <div class="card">
        ${state.customCards[lang].map((c) => `
          <div class="row" style="padding:6px 0;border-bottom:1px solid var(--border)">
            <div class="grow"><b>${esc(c.front)}</b> <span class="muted">— ${esc(c.back)}</span></div>
            <button class="btn ghost" data-del="${c.id}" aria-label="Borrar">🗑️</button>
          </div>`).join('')}
      </div>` : ''}
  `);
  document.getElementById('save').addEventListener('click', () => {
    const front = document.getElementById('f').value.trim();
    const back = document.getElementById('b').value.trim();
    if (!front || !back) return toast('Rellena la palabra y su significado.');
    S.addCustomCards(lang, [{ front, back, example: document.getElementById('x').value }]);
    toast('Tarjeta guardada ⭐');
    go('addCard');
  });
  on('[data-del]', 'click', (e) => {
    S.deleteCustomCard(lang, e.currentTarget.dataset.del);
    go('addCard');
  });
}

function renderGenCards() {
  const lang = state.lang;
  html(`
    <div class="card">
      <p class="muted" style="margin-top:0">Escribe un tema y la IA te prepara 10 tarjetas nuevas.</p>
      <label class="field"><span>Tema</span><input class="input" id="topic" placeholder="Ej: cocina, viajes en avión, emociones, phrasal verbs con «get»…"></label>
      <button class="btn block" id="go">✨ Generar</button>
    </div>
    <div id="result"></div>
  `);
  const $go = document.getElementById('go');
  $go.addEventListener('click', async () => {
    const topic = document.getElementById('topic').value.trim();
    if (!topic) return toast('Escribe un tema.');
    $go.disabled = true;
    $go.innerHTML = '<span class="spinner"></span> Generando…';
    const $r = document.getElementById('result');
    try {
      const cards = await AI.generateCards(lang, topic);
      $r.innerHTML = `
        <div class="card">
          ${cards.map((c) => `<div style="padding:6px 0;border-bottom:1px solid var(--border)"><b>${esc(c.front)}</b> — ${esc(c.back)}<div class="muted"><i>${esc(c.example)}</i></div></div>`).join('')}
          <button class="btn block" id="add-all" style="margin-top:12px">Añadir las ${cards.length} a «Mis tarjetas»</button>
        </div>`;
      document.getElementById('add-all').addEventListener('click', () => {
        S.addCustomCards(lang, cards);
        toast(`${cards.length} tarjetas añadidas ⭐`);
        go('cards');
      });
    } catch (err) {
      $r.innerHTML = `<div class="feedback ko">${esc(AI.friendlyError(err))}</div>`;
    } finally {
      $go.disabled = false;
      $go.textContent = '✨ Generar';
    }
  });
}

// ---------- Ejercicios ----------

function renderPractice() {
  const lang = state.lang;
  const ai = state.aiExercises[lang].length;
  html(`
    <button class="tile" data-mode="mix">
      <div class="emoji">⚡</div>
      <div class="grow"><strong>Lección rápida</strong><span class="muted">8 ejercicios variados</span></div>
    </button>
    <button class="tile" data-mode="choice">
      <div class="emoji">🔤</div>
      <div class="grow"><strong>Completar huecos</strong><span class="muted">Gramática y vocabulario</span></div>
    </button>
    <button class="tile" data-mode="order">
      <div class="emoji">🧱</div>
      <div class="grow"><strong>Ordenar frases</strong><span class="muted">Construye la frase correcta</span></div>
    </button>
    <button class="tile" data-mode="listen">
      <div class="emoji">🎧</div>
      <div class="grow"><strong>Escuchar y escribir</strong><span class="muted">Entrena el oído</span></div>
    </button>
    <div class="card" style="margin-top:16px">
      <h3>✨ Ejercicios nuevos con IA</h3>
      <p class="muted" style="margin-top:0">Genera 8 ejercicios sobre lo que quieras repasar${ai ? ` (llevas ${ai} creados)` : ''}.</p>
      <label class="field"><input class="input" id="topic" placeholder="Ej: preposiciones, subjuntivo, condicionales… (opcional)"></label>
      <button class="btn block" id="gen">Generar y empezar</button>
    </div>
  `);
  on('[data-mode]', 'click', (e) => go('lesson', { mode: e.currentTarget.dataset.mode }));
  const $gen = document.getElementById('gen');
  $gen.addEventListener('click', async () => {
    $gen.disabled = true;
    $gen.innerHTML = '<span class="spinner"></span> Generando…';
    try {
      const list = await AI.generateExercises(lang, document.getElementById('topic').value.trim());
      state.aiExercises[lang].push(...list);
      save();
      go('lesson', { mode: 'custom', items: list });
    } catch (err) {
      toast(AI.friendlyError(err));
      $gen.disabled = false;
      $gen.textContent = 'Generar y empezar';
    }
  });
}

function renderLesson({ mode, items }) {
  const lang = state.lang;
  const pool = [...EXERCISES[lang], ...state.aiExercises[lang]];
  const list = items || shuffle(mode === 'mix' ? pool : pool.filter((e) => e.type === mode)).slice(0, 8);
  let i = 0;
  let correct = 0;

  function finish() {
    $screen.innerHTML = '';
    const pct = Math.round((correct / list.length) * 100);
    html(`
      <div class="card empty">
        <div class="big">${pct >= 80 ? '🏆' : pct >= 50 ? '👏' : '💪'}</div>
        <h2>${correct} de ${list.length} correctas</h2>
        <p class="muted">${pct >= 80 ? '¡Genial!' : pct >= 50 ? '¡Bien hecho, sigue así!' : 'Cada error es un paso más. ¡A por otra!'}</p>
        <div class="grid2">
          <button class="btn secondary" id="menu">Menú</button>
          <button class="btn" id="again">Otra lección</button>
        </div>
      </div>`);
    document.getElementById('menu').addEventListener('click', () => go('practice'));
    document.getElementById('again').addEventListener('click', () => go('lesson', { mode: mode === 'custom' ? 'mix' : mode }));
  }

  function result(ok, detail) {
    state.stats.exercisesDone += 1;
    if (ok) {
      state.stats.exercisesCorrect += 1;
      correct++;
    }
    gainXP(ok ? 10 : 2);
    document.getElementById('area').insertAdjacentHTML('beforeend', `
      <div class="feedback ${ok ? 'ok' : 'ko'}">
        <b>${ok ? '✅ ¡Correcto!' : '❌ Casi…'}</b>
        ${detail ? `<p>${detail}</p>` : ''}
      </div>
      <button class="btn block" id="next" style="margin-top:12px">${i + 1 < list.length ? 'Continuar' : 'Ver resultado'}</button>`);
    document.getElementById('next').addEventListener('click', () => {
      i++;
      i < list.length ? draw() : finish();
    });
    document.getElementById('next').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function draw() {
    $screen.innerHTML = '';
    const ex = list[i];
    html(`
      <div class="bar" style="margin-bottom:16px"><div style="width:${(i / list.length) * 100}%"></div></div>
      <div id="area"></div>`);
    const $a = document.getElementById('area');

    if (ex.type === 'choice') {
      $a.innerHTML = `
        <p class="muted">Elige la opción correcta</p>
        <p class="prompt-text">${esc(ex.q).replace('___', '<u>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</u>')}</p>
        <div class="options">${ex.options.map((o, k) => `<button class="option" data-k="${k}">${esc(o)}</button>`).join('')}</div>`;
      $a.querySelectorAll('.option').forEach((b) =>
        b.addEventListener('click', () => {
          const k = Number(b.dataset.k);
          $a.querySelectorAll('.option').forEach((x) => {
            x.disabled = true;
            if (Number(x.dataset.k) === ex.answer) x.classList.add('correct');
          });
          if (k !== ex.answer) b.classList.add('wrong');
          say(ex.q.replace('___', ex.options[ex.answer]));
          result(k === ex.answer, esc(ex.why));
        }),
      );
    }

    if (ex.type === 'order') {
      const target = ex.words.split(' ').map((w) => w.replace(/[¿?¡!.,]/g, ''));
      const chips = shuffle(target.map((w, k) => ({ w, k })));
      const picked = [];
      $a.innerHTML = `
        <p class="muted">Ordena la frase</p>
        <p class="prompt-text">${esc(ex.meaning)}</p>
        <div class="chips answer-zone" id="ans"></div>
        <div class="chips" id="bank">${chips.map((c, n) => `<button class="chip" data-n="${n}">${esc(c.w)}</button>`).join('')}</div>
        <button class="btn block" id="check" style="margin-top:16px" disabled>Comprobar</button>`;
      const $ans = $a.querySelector('#ans');
      const $check = $a.querySelector('#check');
      const redraw = () => {
        $ans.innerHTML = picked.map((n) => `<button class="chip" data-p="${n}">${esc(chips[n].w)}</button>`).join('');
        $a.querySelectorAll('#bank .chip').forEach((b) => b.classList.toggle('used', picked.includes(Number(b.dataset.n))));
        $check.disabled = picked.length !== chips.length;
        $ans.querySelectorAll('.chip').forEach((b) =>
          b.addEventListener('click', () => {
            picked.splice(picked.indexOf(Number(b.dataset.p)), 1);
            redraw();
          }),
        );
      };
      $a.querySelectorAll('#bank .chip').forEach((b) =>
        b.addEventListener('click', () => {
          const n = Number(b.dataset.n);
          if (!picked.includes(n)) picked.push(n);
          redraw();
        }),
      );
      $check.addEventListener('click', () => {
        $check.remove();
        $a.querySelectorAll('.chip').forEach((b) => (b.disabled = true));
        const ok = normalize(picked.map((n) => chips[n].w).join(' ')) === normalize(target.join(' '));
        say(ex.words);
        result(ok, ok ? '' : `Respuesta: <b>${esc(ex.words)}</b>`);
      });
    }

    if (ex.type === 'listen') {
      $a.innerHTML = `
        <p class="muted">Escucha y escribe lo que oyes</p>
        <div class="row" style="justify-content:center;gap:16px;margin:20px 0">
          <button class="speak" id="play" style="width:72px;height:72px;font-size:2rem">🔊</button>
          <button class="speak" id="slow" style="width:56px;height:56px;font-size:1.4rem">🐢</button>
        </div>
        <textarea class="input" id="typed" rows="2" placeholder="Escribe aquí…"></textarea>
        <button class="btn block" id="check" style="margin-top:12px">Comprobar</button>`;
      $a.querySelector('#play').addEventListener('click', () => say(ex.text));
      $a.querySelector('#slow').addEventListener('click', () => say(ex.text, true));
      setTimeout(() => say(ex.text), 300);
      $a.querySelector('#check').addEventListener('click', (e) => {
        const typed = $a.querySelector('#typed').value;
        if (!typed.trim()) return toast('Escribe lo que has oído.');
        e.currentTarget.remove();
        $a.querySelector('#typed').disabled = true;
        const ok = normalize(typed) === normalize(ex.text);
        result(ok, `${ok ? '' : `Era: <b>${esc(ex.text)}</b><br>`}<span class="muted">${esc(ex.meaning)}</span>`);
      });
    }
  }

  if (!list.length) {
    html('<div class="card empty"><div class="big">🤷</div><p>No hay ejercicios de este tipo todavía.</p></div>');
    return;
  }
  draw();
}

// ---------- Progreso ----------

function renderProgress() {
  const days = S.lastDays(7);
  const max = Math.max(state.settings.dailyGoal, ...days.map((d) => d.xp));
  const names = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
  const acc = state.stats.exercisesDone ? Math.round((state.stats.exercisesCorrect / state.stats.exercisesDone) * 100) : 0;
  const langCard = (l) => {
    const st = S.cardStats(l);
    return `
      <div class="card">
        <h3>${LANGS[l].flag} ${LANGS[l].name}</h3>
        <div class="muted" style="margin-bottom:6px">${st.learned} de ${st.total} tarjetas aprendidas · ${st.mastered} dominadas</div>
        <div class="bar good"><div style="width:${st.total ? (st.learned / st.total) * 100 : 0}%"></div></div>
      </div>`;
  };
  html(`
    <div class="grid2">
      <div class="card stat"><div class="num">🔥 ${S.currentStreak()}</div><div class="muted">Racha actual</div></div>
      <div class="card stat"><div class="num">🏅 ${state.bestStreak}</div><div class="muted">Mejor racha</div></div>
      <div class="card stat"><div class="num">${S.totalXP()}</div><div class="muted">XP total</div></div>
      <div class="card stat"><div class="num">${S.todayXP()}</div><div class="muted">XP hoy</div></div>
    </div>
    <div class="card">
      <h3>Últimos 7 días</h3>
      <div class="week">
        ${days.map((d) => `
          <div class="col">
            <small>${d.xp || ''}</small>
            <div class="colbar ${d.xp >= state.settings.dailyGoal ? 'met' : ''}" style="height:${(d.xp / max) * 85}%"></div>
            <small>${names[d.date.getDay()]}</small>
          </div>`).join('')}
      </div>
      <p class="muted" style="margin-bottom:0">En verde, los días en que cumpliste el objetivo (${state.settings.dailyGoal} XP).</p>
    </div>
    ${langCard('en')}
    ${langCard('es')}
    <div class="grid2">
      <div class="card stat"><div class="num">${acc}%</div><div class="muted">Aciertos en ${state.stats.exercisesDone} ejercicios</div></div>
      <div class="card stat"><div class="num">${state.stats.tutorMessages}</div><div class="muted">Mensajes al tutor</div></div>
    </div>
  `);
}

// ---------- Ajustes ----------

function renderSettings() {
  const s = state.settings;
  html(`
    <div class="card">
      <label class="field"><span>Tu nombre (para que el tutor te llame por él)</span><input class="input" id="name" value="${esc(s.name)}"></label>
    </div>
    <div class="card">
      <h3>🤖 Tutor con IA</h3>
      <p class="muted" style="margin-top:0">Necesita una clave de la API de Anthropic. Se crea en <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a> y se paga por uso. La clave se guarda solo en este móvil.</p>
      <label class="field"><span>Clave de la API</span>
        <div class="row">
          <input class="input grow" id="key" type="password" placeholder="sk-ant-…" value="${esc(s.apiKey)}" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button class="speak" id="key-eye" aria-label="Mostrar u ocultar la clave">👁️</button>
        </div>
      </label>
      <p class="muted" id="key-hint" style="color:var(--bad);margin-top:-6px" hidden></p>
      <button class="btn secondary block" id="key-test" style="margin-bottom:14px">Probar clave</button>
      <label class="field"><span>Modelo</span>
        <select class="input" id="model">
          ${AI.MODELS.map((m) => `<option value="${m.id}" ${m.id === s.model ? 'selected' : ''}>${m.name} — ${m.note}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="card">
      <h3>🎯 Objetivos</h3>
      <label class="field"><span>Objetivo diario</span>
        <select class="input" id="goal">
          ${[20, 50, 100, 150].map((g) => `<option value="${g}" ${g === s.dailyGoal ? 'selected' : ''}>${g} XP${g === 20 ? ' (relajado)' : g === 50 ? ' (normal)' : g === 100 ? ' (serio)' : ' (intenso)'}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>Tarjetas nuevas por día</span>
        <select class="input" id="newpd">
          ${[5, 10, 15, 20, 30].map((n) => `<option value="${n}" ${n === s.newPerDay ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
      </label>
    </div>
    <div class="card">
      <h3>🎙️ Voz realista del tutor (ElevenLabs)</h3>
      <p class="muted" style="margin-top:0">Opcional. El tutor habla con una voz casi humana. Se paga con créditos de ElevenLabs; las tarjetas y los ejercicios siguen usando la voz gratis del móvil.</p>
      <label class="row field"><input type="checkbox" id="el-on" ${s.eleven.enabled ? 'checked' : ''}> <span style="margin:0"><b>Usar ElevenLabs para el tutor</b></span></label>
      <div id="el-box" ${s.eleven.enabled ? '' : 'hidden'}>
        <label class="field"><span>Clave de ElevenLabs</span><input class="input" id="el-key" type="password" placeholder="sk_…" value="${esc(s.eleven.key)}" autocomplete="off"></label>
        <label class="field"><span>Modelo</span>
          <select class="input" id="el-model">
            ${EL.EL_MODELS.map((m) => `<option value="${m.id}" ${m.id === s.eleven.model ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
          </select>
        </label>
        <label class="row field"><input type="checkbox" id="el-stt" ${s.eleven.stt !== false ? 'checked' : ''}> <span style="margin:0"><b>Entender tu voz con ElevenLabs</b> — mucho más preciso que el dictado del móvil (necesita el permiso <b>Speech to Text</b> en la clave)</span></label>
        <button class="btn secondary block" id="el-load">Cargar mis voces</button>
        <div id="el-voices" style="margin-top:14px"></div>
        <p class="muted" id="el-usage" style="margin-bottom:0"></p>
        <details style="margin-top:10px">
          <summary class="muted" style="cursor:pointer">¿Dónde consigo la clave?</summary>
          <p class="muted">En elevenlabs.io → abajo a la izquierda, tu perfil → <b>API Keys</b> → <b>Create API Key</b>. Dale permiso a <b>Text to Speech</b>, <b>Speech to Text</b>, <b>Voices (leer)</b> y <b>User (leer)</b>. Si ya tienes una clave, puedes editarla y añadirle el permiso que falte. Si quieres, ponle un límite de créditos.</p>
          <p class="muted" style="margin-bottom:0">Para tener más voces, añádelas desde la <b>Voice Library</b> de ElevenLabs y pulsa otra vez «Cargar mis voces».</p>
        </details>
      </div>
    </div>
    <div class="card">
      <h3>🔊 Voz</h3>
      ${canSpeak ? `
        <div id="voice-pickers"></div>
        <details style="margin-bottom:14px">
          <summary class="muted" style="cursor:pointer">¿Suena robótica? Descarga una voz mejor (gratis)</summary>
          <p class="muted"><b>iPhone:</b> Ajustes → Accesibilidad → Contenido leído → Voces → elige el idioma y descarga una voz «Mejorada» o «Premium».</p>
          <p class="muted"><b>Android:</b> Ajustes → busca «Salida de texto a voz» → Motor de Google → ⚙️ → Instalar datos de voz → descarga inglés y español.</p>
          <p class="muted" style="margin-bottom:0">Después cierra y vuelve a abrir la app, y elige la voz nueva aquí arriba.</p>
        </details>` : '<p class="muted">Este navegador no permite leer en voz alta.</p>'}
      <label class="field"><span>Velocidad: <b id="rate-val">${s.rate.toFixed(2)}×</b></span><input type="range" id="rate" min="0.6" max="1.3" step="0.05" value="${s.rate}" style="width:100%"></label>
      <label class="row field"><input type="checkbox" id="auto" ${s.autoSpeak ? 'checked' : ''}> <span style="margin:0">Leer en voz alta las respuestas del tutor</span></label>
    </div>
    <div class="card">
      <h3>💾 Copia de seguridad</h3>
      <p class="muted" style="margin-top:0">Tu progreso se guarda en este móvil. Haz una copia si vas a cambiar de móvil o borrar datos del navegador.</p>
      <div class="grid2">
        <button class="btn secondary" id="export">Descargar copia</button>
        <button class="btn secondary" id="import">Restaurar copia</button>
      </div>
      <input type="file" id="import-file" accept="application/json" hidden>
      <button class="btn danger block" id="reset" style="margin-top:12px">Borrar todo el progreso</button>
    </div>
  `);
  const bind = (id, ev, fn) => document.getElementById(id).addEventListener(ev, fn);
  bind('name', 'change', (e) => { s.name = e.target.value.trim(); save(); });
  const showKeyHint = () => {
    const problem = AI.keyProblem(s.apiKey);
    const $h = document.getElementById('key-hint');
    $h.textContent = problem ? `⚠️ ${problem}` : '';
    $h.hidden = !problem;
  };
  bind('key', 'input', (e) => {
    s.apiKey = AI.cleanKey(e.target.value);
    save();
    showKeyHint();
  });
  bind('key', 'change', (e) => {
    e.target.value = s.apiKey;
    toast('Clave guardada');
  });
  bind('key-eye', 'click', (e) => {
    e.preventDefault();
    const $k = document.getElementById('key');
    $k.type = $k.type === 'password' ? 'text' : 'password';
  });
  bind('key-test', 'click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Comprobando…';
    try {
      await AI.checkKey();
      toast('✅ La clave de Claude funciona');
    } catch (err) {
      toast(`❌ ${AI.friendlyError(err)}`);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Probar clave';
    }
  });
  showKeyHint();
  bind('model', 'change', (e) => { s.model = e.target.value; save(); });
  bind('goal', 'change', (e) => { s.dailyGoal = Number(e.target.value); save(); });
  bind('newpd', 'change', (e) => { s.newPerDay = Number(e.target.value); save(); });
  bind('rate', 'input', (e) => {
    s.rate = Number(e.target.value);
    document.getElementById('rate-val').textContent = `${s.rate.toFixed(2)}×`;
    save();
  });
  bind('auto', 'change', (e) => { s.autoSpeak = e.target.checked; save(); });
  const SAMPLE = { en: 'Hi! Shall we practise a little today?', es: '¡Hola! ¿Practicamos un poco hoy?' };
  const drawVoicePickers = () => {
    const $p = document.getElementById('voice-pickers');
    if (!$p) return;
    $p.innerHTML = ['en', 'es'].map((l) => {
      const list = voicesFor(LANGS[l].voice);
      const chosen = list.some((v) => v.voiceURI === s.voices[l]) ? s.voices[l] : '';
      return `
        <label class="field"><span>Voz para ${LANGS[l].flag} ${LANGS[l].name.toLowerCase()}</span>
          <div class="row">
            <select class="input grow" data-voice="${l}" ${list.length ? '' : 'disabled'}>
              ${list.length
                ? `<option value="" ${chosen ? '' : 'selected'}>Automática (${esc(list[0].name)})</option>` +
                  list.map((v) => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === chosen ? 'selected' : ''}>${isGoodVoice(v) ? '⭐ ' : ''}${esc(v.name)} (${esc(v.lang)})</option>`).join('')
                : '<option>No hay voces de este idioma en el móvil</option>'}
            </select>
            <button class="speak" data-test="${l}" aria-label="Probar voz" ${list.length ? '' : 'disabled'}>▶️</button>
          </div>
        </label>`;
    }).join('') + '<p class="muted" style="margin-top:-6px">⭐ = voz de buena calidad.</p>';
    $p.querySelectorAll('[data-voice]').forEach((sel) =>
      sel.addEventListener('change', () => {
        s.voices[sel.dataset.voice] = sel.value;
        save();
        say(SAMPLE[sel.dataset.voice], false, sel.dataset.voice);
      }),
    );
    $p.querySelectorAll('[data-test]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.preventDefault();
        say(SAMPLE[b.dataset.test], false, b.dataset.test);
      }),
    );
  };
  drawVoicePickers();
  cleanup = onVoicesChanged(drawVoicePickers);

  // ElevenLabs
  const el = s.eleven;
  const drawElevenVoices = () => {
    const $v = document.getElementById('el-voices');
    if (!el.voiceList.length) {
      $v.innerHTML = el.key ? '<p class="muted" style="margin:0">Pulsa «Cargar mis voces» para elegir la voz del tutor.</p>' : '';
      return;
    }
    const label = (v) => [v.name, [v.accent, v.gender].filter(Boolean).join(', ')].filter(Boolean).join(' — ');
    $v.innerHTML = ['en', 'es'].map((l) => `
      <label class="field"><span>Voz del tutor en ${LANGS[l].flag} ${LANGS[l].name.toLowerCase()}</span>
        <div class="row">
          <select class="input grow" data-elvoice="${l}">
            <option value="">— Elige una voz —</option>
            ${el.voiceList.map((v) => `<option value="${esc(v.id)}" ${v.id === el.voices[l] ? 'selected' : ''}>${esc(label(v))}</option>`).join('')}
          </select>
          <button class="speak" data-eltest="${l}" aria-label="Probar voz">▶️</button>
        </div>
      </label>`).join('');
    $v.querySelectorAll('[data-elvoice]').forEach((sel) =>
      sel.addEventListener('change', () => {
        el.voices[sel.dataset.elvoice] = sel.value;
        save();
      }),
    );
    $v.querySelectorAll('[data-eltest]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.preventDefault();
        const l = b.dataset.eltest;
        if (!el.voices[l]) return toast('Primero elige una voz.');
        speaker.unlock();
        const talk = speaker.begin(l, {
          override: { key: el.key, model: el.model, voiceId: el.voices[l] },
          onError: (err) => toast(err.message),
        });
        talk.push(SAMPLE[l]);
        talk.finish().then(showUsage);
      }),
    );
  };
  const showUsage = async () => {
    if (!el.key) return;
    try {
      const u = await EL.getUsage(el.key);
      document.getElementById('el-usage').textContent = `Créditos usados este mes: ${u.used.toLocaleString('es')} de ${u.limit.toLocaleString('es')}.`;
    } catch {
      // Si la clave no tiene permiso de "User", simplemente no se muestra.
    }
  };
  // Si no hay voz elegida, propone una que hable ese idioma.
  const autoPick = () => {
    for (const l of ['en', 'es']) {
      if (el.voices[l] && el.voiceList.some((v) => v.id === el.voices[l])) continue;
      const native = el.voiceList.find((v) => v.language === l);
      el.voices[l] = (native || el.voiceList[0])?.id || '';
    }
  };
  bind('el-on', 'change', (e) => {
    el.enabled = e.target.checked;
    document.getElementById('el-box').hidden = !el.enabled;
    save();
  });
  bind('el-key', 'change', (e) => {
    el.key = AI.cleanKey(e.target.value);
    e.target.value = el.key;
    if (el.key.startsWith('sk-ant-')) toast('⚠️ Esa es la clave de Claude, no la de ElevenLabs.');
    el.voiceList = [];
    cloudEarsOff = false;
    save();
    drawElevenVoices();
    if (el.key) document.getElementById('el-load').click();
  });
  bind('el-stt', 'change', (e) => {
    el.stt = e.target.checked;
    cloudEarsOff = false; // volver a intentarlo (por ejemplo, tras añadir el permiso a la clave)
    save();
  });
  bind('el-model', 'change', (e) => {
    el.model = e.target.value;
    save();
  });
  bind('el-load', 'click', async (e) => {
    if (!el.key) return toast('Pega primero tu clave de ElevenLabs.');
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Cargando…';
    try {
      el.voiceList = (await EL.listVoices(el.key)).sort((a, b) => a.name.localeCompare(b.name));
      autoPick();
      save();
      drawElevenVoices();
      showUsage();
      toast(`${el.voiceList.length} voces cargadas`);
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Cargar mis voces';
    }
  });
  drawElevenVoices();
  showUsage();
  bind('export', 'click', () => {
    const blob = new Blob([S.exportData()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fluir-copia-${S.dayKey()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  bind('import', 'click', () => document.getElementById('import-file').click());
  bind('import-file', 'change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      S.importData(await file.text());
      renderLangSwitch();
      toast('Copia restaurada ✅');
      go('home');
    } catch {
      toast('Ese archivo no es una copia válida.');
    }
  });
  let armed = false;
  bind('reset', 'click', (e) => {
    if (!armed) {
      armed = true;
      e.currentTarget.textContent = 'Pulsa otra vez para confirmar';
      return;
    }
    S.resetAll();
    renderLangSwitch();
    toast('Progreso borrado');
    go('home');
  });
}

// ---------- Pantallas ----------

const SCREENS = {
  home: { title: () => 'Fluir', render: renderHome },
  tutor: { title: () => 'Tutor', render: renderTutor },
  cards: { title: () => 'Tarjetas', render: renderCards },
  review: { title: () => 'Repaso', render: renderReview, tab: 'cards', back: 'cards' },
  addCard: { title: () => 'Nueva tarjeta', render: renderAddCard, tab: 'cards', back: 'cards' },
  genCards: { title: () => 'Crear con IA', render: renderGenCards, tab: 'cards', back: 'cards' },
  practice: { title: () => 'Ejercicios', render: renderPractice },
  lesson: { title: () => 'Lección', render: renderLesson, tab: 'practice', back: 'practice' },
  progress: { title: () => 'Progreso', render: renderProgress },
  settings: { title: () => 'Ajustes', render: renderSettings, tab: 'home', back: 'home' },
};

renderLangSwitch();
go('home');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
