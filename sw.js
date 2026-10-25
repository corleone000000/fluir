// Guarda la app en el móvil para que abra rápido y funcione sin conexión
// (el tutor con IA sí necesita internet).
const CACHE = 'fluir-v9';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'data.js',
  'store.js',
  'speech.js',
  'ai.js',
  'elevenlabs.js',
  'voice.js',
  'hearing.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Primero la red (para recibir actualizaciones); si no hay conexión, la copia guardada.
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET' || request.url.includes('api.anthropic.com')) return;
  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok && (request.url.startsWith(self.location.origin) || request.url.includes('cdn.jsdelivr.net'))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request)),
  );
});
