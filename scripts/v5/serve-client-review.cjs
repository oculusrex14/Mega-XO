// Static server for the V5 client bundle (the native app UI) - annotation review only.
const http = require('http'), fs = require('fs'), path = require('path');
/* The directory and port are parameterizable so a fresh bundle can be reviewed without
   touching an older annotation session; defaults preserve the original 4197 view. */
const ROOT = process.env.MEGA_REVIEW_ROOT || '/Users/oculus/Downloads/Test XO/.artifacts/v5-client-review';
const PORT = Number(process.env.MEGA_REVIEW_PORT || 4197);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/' || p === '/index.html') p = '/bundle-index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log('client UI: http://127.0.0.1:' + PORT + '/bundle-index.html'));
