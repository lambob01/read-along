import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({
				fallback: 'index.html'
			})
		})
	],
	server: {},
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: [
						'src/**/*.svelte.{test,spec}.{js,ts}',
						'src/**/*.dom.{test,spec}.{js,ts}'
					]
				}
			},
			{
				// EPUB parsing and alignment operate on real DOM nodes, so those
				// suites need a browser-like environment.
				extends: './vite.config.ts',
				test: {
					name: 'dom',
					environment: 'jsdom',
					include: ['src/**/*.dom.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
