import http from 'http';
import { statSync, createReadStream, readFileSync } from 'fs';

const AUDIO = 'book.m4b';
const size = statSync(AUDIO).size;

// Cue boundaries deliberately land on whole seconds so a mined clip's tone
// frequency (300 + 100*second Hz) identifies exactly which seconds were cut.
const SRT = `1
00:00:05,000 --> 00:00:08,000
これは五秒から八秒までの文です。

2
00:00:08,000 --> 00:00:11,000
つぎは八秒から十一秒までの文。

3
00:00:20,000 --> 00:00:23,000
二十秒から二十三秒までの文です。

4
00:00:30,000 --> 00:00:33,000
三十秒からの最後の文。
`;

const item = {
  id: 'test',
  media: {
    metadata: { title: 'Tone Book', authorName: 'Verifier' },
    coverPath: '',
    audioFiles: [],
    tracks: [{ contentUrl: '/audio/book.m4b' }],
    libraryFiles: [{ ino: 'sub1', metadata: { filename: 'book.srt', size: SRT.length } }],
    chapters: [
      { id: 0, start: 0, end: 30, title: 'One' },
      { id: 1, start: 30, end: 60, title: 'Two' }
    ]
  }
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  console.log(req.method, p, req.headers.range || '');

  if (p === '/audio/book.m4b') {
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m[1] ? parseInt(m[1]) : 0;
      const end = m[2] ? parseInt(m[2]) : size - 1;
      res.writeHead(206, {
        'Content-Type': 'audio/mp4',
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1
      });
      createReadStream(AUDIO, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': size });
      createReadStream(AUDIO).pipe(res);
    }
    return;
  }
  if (p === '/api/items/test/file/sub1') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(SRT);
    return;
  }
  if (p === '/api/items/test' || p === '/api/items/test/play') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(p.endsWith('/play') ? { libraryItem: item } : item));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"not found"}');
}).listen(13999, () => console.log('fake ABS on 13999'));
