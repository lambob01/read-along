/// <reference types="@sveltejs/kit" />

import { build, files, version } from '$service-worker';

const CACHE = `read-along-${version}`;
const ASSETS = [...build, ...files];

self.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
	);
});

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	if (url.pathname.startsWith('/abs/')) return;

	event.respondWith(
		caches.match(event.request).then((cached) => {
			const fetched = fetch(event.request).then((response) => {
				if (response.ok && response.type === 'basic') {
					const clone = response.clone();
					caches.open(CACHE).then((cache) => cache.put(event.request, clone));
				}
				return response;
			});
			return cached || fetched;
		})
	);
});
