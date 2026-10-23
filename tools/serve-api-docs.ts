import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// Builds a static Redoc page for docs/api/openapi.yaml into dist-docs/, serves it on loopback and
// opens it in the browser. The viewer script comes from a CDN (pinned version), so viewing needs
// internet access; nothing is added to the service's dependencies.
const REDOC_URL = 'https://cdn.jsdelivr.net/npm/redoc@2.1.5/bundles/redoc.standalone.js';
const root = resolve(__dirname, '..');
const specSource = join(root, 'docs', 'api', 'openapi.yaml');
const outDir = join(root, 'dist-docs');

const { values } = parseArgs({
  options: { port: { type: 'string', default: '8080' }, 'no-open': { type: 'boolean' } },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('--port must be an integer from 0 to 65535');
  process.exit(2);
}

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Rate Limiter API</title>
  </head>
  <body>
    <redoc spec-url="openapi.yaml"></redoc>
    <script src="${REDOC_URL}"></script>
  </body>
</html>
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), html);
copyFileSync(specSource, join(outDir, 'openapi.yaml'));

// Only these two fixed paths are served, so no request can reach any other file.
const files = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/openapi.yaml', { file: 'openapi.yaml', type: 'application/yaml; charset=utf-8' }],
]);

const server = createServer((req, res) => {
  const entry = files.get(new URL(String(req.url), 'http://localhost').pathname);
  if (req.method !== 'GET' || entry === undefined) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': entry.type });
  res.end(readFileSync(join(outDir, entry.file)));
});

const openInBrowser = (url: string) => {
  const isWsl = process.platform === 'linux' && 'WSL_DISTRO_NAME' in process.env;
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : isWsl
          ? ['cmd.exe', ['/c', 'start', '', url]]
          : ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {
    console.log('Could not open a browser; open the URL above yourself.');
  });
  child.unref();
};

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const url = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : port)}/`;
  console.log(`API docs built in ${outDir}\nServing ${url} (Ctrl-C to stop)`);
  if (values['no-open'] !== true) openInBrowser(url);
});
