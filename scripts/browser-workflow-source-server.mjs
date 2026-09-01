import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, request as createProxyRequest } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import process from 'node:process';

const rootDir = resolve(process.env.BROWSER_WORKFLOW_SOURCE_ROOT || process.cwd());
const port = Number(process.env.BROWSER_WORKFLOW_FRONTEND_PORT || 5175);
const backendBase = new URL(process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8000');

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp']
]);

function sendText(response, status, message) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8'
  });
  response.end(message);
}

function proxyRequest(request, response) {
  const requestUrl = request.url || '/';
  const upstreamPath = requestUrl.replace(/^\/api(?=\/|\?|#|$)/, '') || '/';
  const upstreamUrl = new URL(upstreamPath, backendBase);
  const headers = { ...request.headers, host: upstreamUrl.host };
  const upstream = createProxyRequest({
    protocol: upstreamUrl.protocol,
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port,
    method: request.method,
    path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
    headers
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });

  upstream.on('error', (error) => {
    if (!response.headersSent) sendText(response, 502, `Backend proxy failed: ${error.message}`);
    else response.destroy(error);
  });
  request.on('aborted', () => upstream.destroy());
  request.pipe(upstream);
}

function isInsideRoot(filePath) {
  return filePath === rootDir || filePath.startsWith(`${rootDir}${sep}`);
}

async function transformedSource(filePath) {
  if (filePath === resolve(rootDir, 'index.html')) {
    const html = await readFile(filePath, 'utf8');
    return Buffer.from(html.replace(
      '</head>',
      '    <link rel="stylesheet" href="/node_modules/leaflet/dist/leaflet.css" data-browser-workflow-only />\n  </head>'
    ));
  }

  if (extname(filePath).toLowerCase() === '.js') {
    const source = await readFile(filePath, 'utf8');
    if (!source.includes("'leaflet")) return null;
    return Buffer.from(source
      .replaceAll("import L from 'leaflet';", "import * as L from '/node_modules/leaflet/dist/leaflet-src.esm.js';")
      .replace(/^import 'leaflet\/dist\/leaflet\.css';?\r?\n/gm, ''));
  }

  return null;
}

async function serveStatic(request, response, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    sendText(response, 400, 'Invalid URL path');
    return;
  }

  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let filePath = resolve(rootDir, relativePath);
  if (!isInsideRoot(filePath)) {
    sendText(response, 403, 'Path is outside the browser workflow root');
    return;
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      filePath = resolve(filePath, 'index.html');
      fileStat = await stat(filePath);
    }
  } catch {
    if (!String(request.headers.accept || '').includes('text/html')) {
      sendText(response, 404, 'Not found');
      return;
    }
    filePath = resolve(rootDir, 'index.html');
    fileStat = await stat(filePath);
  }

  if (!fileStat.isFile()) {
    sendText(response, 404, 'Not found');
    return;
  }

  const transformed = await transformedSource(filePath);
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-length': transformed?.length ?? fileStat.size,
    'content-type': contentTypes.get(extname(filePath).toLowerCase()) || 'application/octet-stream'
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  if (transformed) {
    response.end(transformed);
    return;
  }

  const stream = createReadStream(filePath);
  stream.on('error', (error) => response.destroy(error));
  stream.pipe(response);
}

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
    proxyRequest(request, response);
    return;
  }
  void serveStatic(request, response, url).catch((error) => {
    if (!response.headersSent) sendText(response, 500, `Static server failed: ${error.message}`);
    else response.destroy(error);
  });
});

server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Browser workflow source server listening on http://127.0.0.1:${port}`);
});
