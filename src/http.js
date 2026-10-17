import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { operations } from './protocol.js';
import { ControlError } from './errors.js';

function authenticated(header, token) {
  if (typeof header !== 'string') return false;
  const received = Buffer.from(header); const expected = Buffer.from(`Bearer ${token}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}
async function readJson(request) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 256 * 1024) throw new ControlError('body-too-large', 'Request exceeds 256 KiB.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ControlError('invalid-json', 'Expected a JSON request body.'); }
}
export async function startServer(controller, token, port = 0) {
  const server = createServer(async (request, response) => {
    const abort = new AbortController();
    response.on('close', () => abort.abort());
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, value) => { if (!response.destroyed) { response.writeHead(status); response.end(JSON.stringify(value)); } };
    try {
      const address = server.address();
      if (request.headers.host !== `127.0.0.1:${address.port}` || request.headers.origin !== undefined)
        throw new ControlError('origin-denied', 'Only local non-browser requests are accepted.', 403);
      if (!authenticated(request.headers.authorization, token)) throw new ControlError('unauthorized', 'Missing or invalid bridge credential.', 401);
      if (request.method !== 'POST') throw new ControlError('method-denied', 'Use POST.', 405);
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new ControlError('media-type', 'Use application/json.', 415);
      const operation = operations[request.url?.replace(/^\/v1\//, '')];
      if (!request.url?.startsWith('/v1/') || !Object.hasOwn(operations, request.url.slice(4)) || !operation)
        throw new ControlError('not-found', 'Unknown bridge operation.', 404);
      const parsed = operation.schema.safeParse(await readJson(request));
      if (!parsed.success) throw new ControlError('invalid-input', 'Input does not match the operation schema.');
      const result = await controller[operation.method](parsed.data, abort.signal);
      reply(200, { ok: true, result });
    } catch (error) {
      reply(error instanceof ControlError ? error.status : 500, { ok: false,
        error: { code: error instanceof ControlError ? error.code : 'internal',
          message: error instanceof ControlError ? error.message : 'Bridge operation failed. Check the local Host log.' } });
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.maxHeadersCount = 32;
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  return { url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((accept, reject) => { server.close(error => error ? reject(error) : accept()); server.closeAllConnections(); }) };
}
