---
name: verify
description: Run the reader against fake Audiobookshelf and AnkiConnect servers to observe a change in the real app. Use when verifying reader, sync, highlight, or Anki-mining changes.
---

# Verifying the read-along reader

The app is a static SPA that talks to two things it does not own: an
Audiobookshelf server and (for mining) AnkiConnect. Both are stubbed here so
verification needs no credentials, no real book, and no running Anki.

## Handle

```bash
cd .claude/skills/verify
npm i playwright@1.62.0        # first time only
node gen-audio.mjs             # writes tone.wav
ffmpeg -y -i tone.wav -c:a aac -b:a 96k book.m4b
node fake-abs.mjs &            # :13999 — item, play session, SRT, ranged audio
node fake-anki.mjs &           # :8765  — AnkiConnect protocol, media to ./ankimedia
```

Point the dev proxy at the fake ABS, **and put it back afterwards** — the real
value is a live server:

```bash
cp ../../../.env.local /tmp/env.backup
echo 'PUBLIC_ABS_ORIGIN=http://localhost:13999' > ../../../.env.local
npm run dev                    # note the port, it is 5174 when 5173 is taken
# ... verify ...
mv /tmp/env.backup ../../../.env.local
```

Then `node drive.mjs` — it seeds `reader-connection` and `reader-settings` in
localStorage, opens `/read/test`, plays, and clicks Mine.

## The trick that makes audio verifiable

`gen-audio.mjs` writes 60s where **second _s_ is a pure tone at 300 + 100·_s_ Hz**.
A mined clip's frequency content therefore names the exact seconds it came
from, which is the only way to prove the capture→clip timing is right rather
than merely plausible. Decode the stored file and run a Goertzel sweep over the
candidate tones (see the verify transcript for `analyze.mjs`).

Cue boundaries in the fake SRT land on whole seconds (5–8, 8–11, 20–23, 30–33)
so expected frequencies are easy to state.

## Gotchas

- **Playwright's Chromium has no AAC** in some builds. This one played the M4B
  fine, but if playback silently stalls, re-encode the fixture as MP3 — the
  capture path taps decoded PCM, so the container is not what is under test.
- The player's `HTMLAudioElement` is a **singleton that is never appended to
  the DOM**. Do not look for `<audio>` in the page; drive playback through the
  app's own controls and read `[aria-label="Seek"]`.
- On Chromium the highlighter uses the **CSS Highlight API**, so there are no
  `.hl-active` elements to assert on. Check `reader.activeSentenceId` effects
  through behaviour, not classes.
- Anki mining re-plays the range on its own hidden element, so a clip can be
  taken for any timestamp whether or not it has been listened to. A capture
  takes about as long as the sentence — poll for the toast rather than
  sleeping a fixed amount.
- `npm run format` reformats the whole repo — it was never fully
  prettier-clean. Use `npx prettier --write <paths>` on the files you touched.

## Flows worth driving

Reader/sync changes: play, watch the highlight track, seek, change speed.
Mining changes: both `update-last` and `create` modes, plus the failure paths
(field missing, Anki down, line not yet heard) — the fake AnkiConnect logs
every action it receives to stdout.
