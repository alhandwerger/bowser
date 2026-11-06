// @vitest-environment node
/** Verify actual development HTTP forwarding, including polygon POST bodies. */
import { createServer as createHttpServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'vite';

let vite;
let base;
let previousTarget;
const backend = createHttpServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ method: request.method, path: request.url,
    body: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
});

beforeAll(async () => {
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  previousTarget = process.env.VITE_API_URL;
  process.env.VITE_API_URL = `http://127.0.0.1:${backend.address().port}`;
  // Load the repository's real proxy configuration; do not reconstruct its routes.
  vite = await createServer({ logLevel: 'silent', server: { host: '127.0.0.1', port: 0,
    strictPort: false, hmr: false, preTransformRequests: false } });
  await vite.listen();
  base = `http://127.0.0.1:${vite.httpServer.address().port}`;
});

afterAll(async () => {
  if (vite) await vite.close();
  await new Promise((resolve, reject) => backend.close(error => error ? reject(error) : resolve()));
  if (previousTarget === undefined) delete process.env.VITE_API_URL;
  else process.env.VITE_API_URL = previousTarget;
});

describe('development API proxy', () => {
  it.each(['/polygon_timeseries', '/polygon_timeseries?dataset=example', '/multi_point', '/buffer_timeseries'])(
    'forwards POST %s and its JSON body to the configured backend', async path => {
      const body = { variable: 'displacement', support: 'common', percentiles: [10, 90] };
      const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({ method: 'POST', path, body });
    });

  it('keeps similar frontend paths out of the polygon API proxy', async () => {
    const response = await fetch(base + '/polygon_timeseries_notes', { method: 'POST', body: '{}' });
    expect(response.status).toBe(404);
  });
});
