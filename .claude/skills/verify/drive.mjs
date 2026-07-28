import { chromium } from 'playwright';

const BASE = 'http://localhost:5174';

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream']
});
const page = await browser.newPage();
page.on('console', (m) => console.log('  [console.' + m.type() + ']', m.text().slice(0, 300)));
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

await page.evaluate(() => {
  localStorage.setItem('reader-connection', JSON.stringify({ url: 'http://localhost:13999', token: 'test-token', connected: true }));
  localStorage.setItem('reader-settings', JSON.stringify({
    ankiEnabled: true,
    ankiUrl: 'http://localhost:8765',
    ankiMode: 'update-last',
    ankiLastCardQuery: 'added:1',
    ankiAudioField: 'SentenceAudio',
    ankiSentenceField: 'Sentence',
    ankiUpdateSentence: true,
    ankiTags: 'read-along verify',
    ankiPadStart: 0.25,
    ankiPadEnd: 0.4,
    autoHideChrome: false
  }));
});

await page.goto(BASE + '/read/test', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const canPlay = await page.evaluate(async () => {
  const a = document.querySelector('audio') || [...document.querySelectorAll('*')].find(e => e.tagName === 'AUDIO');
  return { audioInDom: !!a };
});
console.log('audio element in DOM:', JSON.stringify(canPlay));

// The player owns a singleton Audio() that is never appended to the document,
// so drive playback through the app's own controls, like a user.
console.log('--- pressing play ---');
await page.getByLabel('Play', { exact: true }).click();
await page.waitForTimeout(1000);

const state = await page.evaluate(() => {
  const el = document.querySelector('[aria-label="Seek"]');
  return { seek: el ? el.value : null, max: el ? el.max : null };
});
console.log('after play:', JSON.stringify(state));

// Let it run past the 5-8s cue and into the 8-11s cue.
for (let i = 0; i < 14; i++) {
  await page.waitForTimeout(1000);
  const s = await page.evaluate(() => {
    const el = document.querySelector('[aria-label="Seek"]');
    const hl = document.querySelector('.hl-active, .reader-sentence');
    return { t: el ? Number(el.value).toFixed(2) : null,
             active: [...document.querySelectorAll('.hl-active')].map(e => e.textContent).join('|') };
  });
  console.log(`t=${s.t}s active="${s.active}"`);
  if (Number(s.t) > 12.5) break;
}

await page.screenshot({ path: 'reader-before-mine.png' });

console.log('--- clicking Mine ---');
await page.getByLabel('Mine this sentence to Anki').click();
await page.waitForTimeout(2500);

const toast = await page.evaluate(() => {
  const el = document.querySelector('[role="status"]');
  return el ? el.textContent.trim() : '(no toast)';
});
console.log('TOAST:', toast);
await page.screenshot({ path: 'reader-after-mine.png' });

await browser.close();
