# Read-Along Reader

A self-hosted audiobook player with synchronized transcript highlighting for [Audiobookshelf](https://audiobookshelf.org).

## Features

- **Synchronized highlighting** — text follows audio progress sentence by sentence
- **Transcript support** — parses SRT and VTT subtitle files attached to your audiobooks
- **CSS Highlight API** — smooth, zero-layout-shift highlighting with class fallback
- **Chapter navigation** — prev/next buttons, dropdown menu with timestamps
- **Keyboard shortcuts** — vim-style (`h/j/k/l/n/p`) and arrow keys for playback
- **Dark mode** — Light, Dark, Sepia, OLED themes with persistent settings
- **Customizable reader** — font size, line height, margins, highlight colors
- **Mobile friendly** — responsive player bar, touch-sized controls, dynamic viewport height
- **SPA** — single-page app, works behind any reverse proxy

## Prerequisites

- [Node.js](https://nodejs.org) 20+
- An [Audiobookshelf](https://audiobookshelf.org) instance (v2.0+)
- An ABS API token (generated from **Settings → API Token** in the ABS admin panel)

## Quick Start (Local Dev)

```bash
git clone https://github.com/lambob01/read-along.git
cd read-along
cp .env.example .env.local
```

Edit `.env.local` — set `PUBLIC_ABS_ORIGIN` to your Audiobookshelf server URL:

```env
PUBLIC_ABS_ORIGIN=https://your-abs-server.com
```

```bash
npm install
npm run dev
```

Open http://localhost:5173, enter your ABS server URL and API token, click **Connect**.

## Docker Deployment

The docker setup uses [Caddy](https://caddyserver.com) for auto-provisioned HTTPS via Let's Encrypt.

### 1. Set your domain

Create an A/AAAA record pointing your domain to your server's IP.

### 2. Configure environment

```bash
export SITE_DOMAIN=reader.your-domain.com
export ABS_ORIGIN=https://your-abs-server.com
```

| Variable      | Required        | Default                  | Description             |
| ------------- | --------------- | ------------------------ | ----------------------- |
| `SITE_DOMAIN` | Yes (for HTTPS) | `reader.localhost`       | Domain Caddy serves on  |
| `ABS_ORIGIN`  | Yes             | `http://localhost:13378` | Your Audiobookshelf URL |

### 3. Start

```bash
docker compose up -d
```

The app will be available at `https://reader.your-domain.com` with automatic TLS.

### Updating

```bash
git pull
docker compose up -d --build
```

## Configuration

### Environment Variables (Dev)

| Variable            | Description                               |
| ------------------- | ----------------------------------------- |
| `PUBLIC_ABS_ORIGIN` | ABS server URL the Vite proxy forwards to |

### Environment Variables (Docker)

| Variable      | Description                              |
| ------------- | ---------------------------------------- |
| `SITE_DOMAIN` | Domain Caddy serves (for TLS)            |
| `ABS_ORIGIN`  | ABS server URL Caddy proxies `/abs/*` to |

## Keyboard Shortcuts

| Key           | Action           |
| ------------- | ---------------- |
| `Space` / `k` | Play / Pause     |
| `←` / `h`     | Rewind 5s / 10s  |
| `→` / `l`     | Forward 10s      |
| `j`           | Rewind 10s       |
| `n`           | Next chapter     |
| `p`           | Previous chapter |

## Tech Stack

- [SvelteKit](https://kit.svelte.dev) (SPA, adapter-static)
- [Tailwind CSS v4](https://tailwindcss.com)
- TypeScript
- Vite
- Vitest (unit tests)
- Caddy (Docker deployment)

## License

MIT
