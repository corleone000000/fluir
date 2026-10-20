// Estado de la app guardado en el propio móvil (localStorage).
import { DECKS } from './data.js';

const KEY = 'fluir-state-v1';
const DAY = 86400000;

const DEFAULT_STATE = {
  version: 1,
  lang: 'en',
  settings: {
    name: '',
    apiKey: '',
    model: 'claude-opus-5-5',
    dailyGoal: 50,
    newPerDay: 10,
    rate: 0.95,
    autoSpeak: true,
    voices: { en: '', es: '' }, // voz elegida por idioma ('' = la mejor automáticamente)
    eleven: {
      enabled: false,
      key: '',
      model: 'eleven_v4_turbo',
      voices: { en: '', es: '' },
      voiceList: [],
    },
  },
  xpByDay: {},
  bestStreak: 0,
  cards: { en: {}, es: {} },
  customCards: { en: [], es: [] },
  aiExercises: { en: [], es: [] },
  newSeen: {},
  stats: { exercisesDone: 0, exercisesCorrect: 0, tutorMessages: 0, reviews: 0 },
  chats: { en: null, es: null },
};

function mergeEleven(base, saved) {
  return { ...structuredClone(base), ...saved, voices: { ...base.voices, ...saved?.voices } };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const saved = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULT_STATE),
      ...saved,
      settings: {
        ...DEFAULT_STATE.settings,
        ...saved.settings,
        voices: { ...DEFAULT_STATE.settings.voices, ...saved.settings?.voices },
        eleven: mergeEleven(DEFAULT_STATE.settings.eleven, saved.settings?.eleven),
      },
      stats: { ...DEFAULT_STATE.stats, ...saved.stats },
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

export const state = load();

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Sin almacenamiento (modo privado): la app sigue funcionando en memoria.
  }
}

export function exportData() {
  return JSON.stringify(state, null, 2);
}

export function importData(json) {
  const data = JSON.parse(json);
  if (!data || data.version !== 1) throw new Error('Archivo no válido');
  Object.keys(state).forEach((k) => delete state[k]);
  const base = structuredClone(DEFAULT_STATE);
  Object.assign(state, base, data, {
    settings: {
      ...base.settings,
      ...data.settings,
      voices: { ...base.settings.voices, ...data.settings?.voices },
      eleven: mergeEleven(base.settings.eleven, data.settings?.eleven),
    },
    stats: { ...base.stats, ...data.stats },
  });
  save();
}

export function resetAll() {
  const keep = { apiKey: state.settings.apiKey, name: state.settings.name, eleven: state.settings.eleven };
  Object.keys(state).forEach((k) => delete state[k]);
  Object.assign(state, structuredClone(DEFAULT_STATE));
  Object.assign(state.settings, keep);
  save();
}

// ---------- Días, XP y racha ----------

export function dayKey(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function todayXP() {
  return state.xpByDay[dayKey()] || 0;
}

export function addXP(amount) {
  const k = dayKey();
  const before = state.xpByDay[k] || 0;
  state.xpByDay[k] = before + amount;
  const streak = currentStreak();
  if (streak > state.bestStreak) state.bestStreak = streak;
  save();
  const goal = state.settings.dailyGoal;
  return { reachedGoal: before < goal && before + amount >= goal, streak };
}

export function currentStreak() {
  const d = new Date();
  if (!state.xpByDay[dayKey(d)]) d.setDate(d.getDate() - 1); // la racha sigue viva hasta que acabe hoy
  let n = 0;
  while (state.xpByDay[dayKey(d)] > 0) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

export function lastDays(count) {
  const out = [];
  const d = new Date();
  d.setDate(d.getDate() - (count - 1));
  for (let i = 0; i < count; i++) {
    out.push({ date: new Date(d), xp: state.xpByDay[dayKey(d)] || 0 });
    d.setDate(d.getDate() + 1);
  }
  return out;
}

export function totalXP() {
  return Object.values(state.xpByDay).reduce((a, b) => a + b, 0);
}

// ---------- Tarjetas con repaso espaciado ----------

export function allCards(lang) {
  const list = [];
  for (const deck of DECKS[lang]) {
    deck.cards.forEach(([front, back, example], i) => {
      list.push({ id: `${deck.id}:${i}`, deck: deck.id, front, back, example });
    });
  }
  for (const c of state.customCards[lang]) list.push({ ...c, deck: 'custom' });
  return list;
}

export function decksFor(lang) {
  const decks = DECKS[lang].map((d) => ({ id: d.id, name: d.name, emoji: d.emoji }));
  if (state.customCards[lang].length) decks.push({ id: 'custom', name: 'Mis tarjetas', emoji: '⭐' });
  return decks;
}

function newSeenToday(lang) {
  return state.newSeen[dayKey()]?.[lang] || 0;
}

export function cardQueue(lang, deckId = null) {
  const now = Date.now();
  const progress = state.cards[lang];
  const cards = allCards(lang).filter((c) => !deckId || c.deck === deckId);
  const due = cards
    .filter((c) => progress[c.id] && progress[c.id].due <= now)
    .sort((a, b) => progress[a.id].due - progress[b.id].due);
  const newLeft = Math.max(0, state.settings.newPerDay - newSeenToday(lang));
  const fresh = cards.filter((c) => !progress[c.id]).slice(0, newLeft);
  return [...due, ...fresh];
}

export function countDue(lang, deckId = null) {
  return cardQueue(lang, deckId).length;
}

// rating: 0 = otra vez, 1 = difícil, 2 = bien, 3 = fácil
export function previewInterval(lang, id, rating) {
  return schedule(state.cards[lang][id], rating).label;
}

function schedule(prev, rating) {
  const p = prev ? { ...prev } : { interval: 0, ease: 2.5, reps: 0, lapses: 0 };
  let ms;
  if (rating === 0) {
    p.reps = 0;
    p.interval = 0;
    p.lapses += 1;
    p.ease = Math.max(1.3, p.ease - 0.2);
    ms = 10 * 60000;
  } else {
    if (rating === 1) {
      p.interval = Math.max(1, Math.round((p.interval || 1) * 1.2));
      p.ease = Math.max(1.3, p.ease - 0.15);
    } else if (rating === 2) {
      p.interval = p.reps === 0 ? 1 : p.reps === 1 ? 3 : Math.round(p.interval * p.ease);
    } else {
      p.interval = p.reps === 0 ? 4 : Math.round(p.interval * p.ease * 1.3);
      p.ease += 0.15;
    }
    p.reps += 1;
    ms = p.interval * DAY;
  }
  p.due = Date.now() + ms;
  const label = rating === 0 ? '10 min' : p.interval === 1 ? '1 día' : `${p.interval} días`;
  return { next: p, label };
}

export function rateCard(lang, id, rating) {
  const isNew = !state.cards[lang][id];
  state.cards[lang][id] = schedule(state.cards[lang][id], rating).next;
  if (isNew) {
    const k = dayKey();
    state.newSeen[k] = state.newSeen[k] || {};
    state.newSeen[k][lang] = (state.newSeen[k][lang] || 0) + 1;
  }
  state.stats.reviews += 1;
  save();
}

export function cardStats(lang) {
  const all = allCards(lang);
  const progress = state.cards[lang];
  const learned = all.filter((c) => progress[c.id]?.reps > 0).length;
  const mastered = all.filter((c) => progress[c.id]?.interval >= 21).length;
  return { total: all.length, learned, mastered };
}

export function addCustomCards(lang, cards) {
  const stamp = Date.now();
  cards.forEach((c, i) => {
    state.customCards[lang].push({
      id: `custom:${stamp}-${i}`,
      front: c.front.trim(),
      back: c.back.trim(),
      example: (c.example || '').trim(),
    });
  });
  save();
}

export function deleteCustomCard(lang, id) {
  state.customCards[lang] = state.customCards[lang].filter((c) => c.id !== id);
  delete state.cards[lang][id];
  save();
}
