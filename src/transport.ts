/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { lookup as resolveHost } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import type { IncomingMessage, ClientRequest } from 'node:http';
import ipaddr from 'ipaddr.js';
import { BiliError } from './errors.ts';

export interface TransportOptions {
  method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string;
  signal?: AbortSignal; timeoutMs: number; maxBytes: number;
  // Observer-only context; never sent as an HTTP header or query parameter.
  diagnosticPurpose?: 'search_keys';
}
export interface TransportResponse { status: number; headers: Record<string, string | string[]>; body: Buffer; url: string }
export interface Transport { request(url: string, options: TransportOptions): Promise<TransportResponse>; dispose(): void | Promise<void> }
export interface TransportDependencies {
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  request?: (url: URL, options: Record<string, unknown>, callback: (response: IncomingMessage) => void) => ClientRequest;
}
export class TransportError extends BiliError {
  readonly submitted: boolean;
  constructor(code: string, submitted: boolean) { super(code); this.submitted = submitted; }
}
const COOKIE_HOSTS = new Set(['api.bilibili.com', 'www.bilibili.com', 'passport.bilibili.com']);
export function publicAddress(address: string): boolean {
  try { return ipaddr.parse(address).range() === 'unicast'; } catch { return false; }
}
export function safeUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new BiliError('unsafe_url'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash
    || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) throw new BiliError('unsafe_url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host.endsWith('.') || host === 'localhost' || host.endsWith('.localhost') || !host.includes('.') && !isIP(host)
    || isIP(host) && !publicAddress(host)) throw new BiliError('unsafe_url');
  return url;
}

export function createTransport(dependencies: TransportDependencies = {}): Transport {
  const resolve = dependencies.lookup ?? (host => resolveHost(host, { all: true, verbatim: true }));
  const send = dependencies.request ?? ((url, options, callback) => httpsRequest(url, options, callback));
  const lifetime = new AbortController();
  return {
    async request(input, options) {
      let submitted = false;
      const deadline = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const signal = AbortSignal.any([lifetime.signal, deadline.signal, ...(options.signal ? [options.signal] : [])]);
      const reason = () => lifetime.signal.aborted ? 'stopped' : options.signal?.aborted ? 'cancelled' : deadline.signal.aborted ? 'timeout' : 'network_error';
      const abortError = () => new TransportError(reason(), submitted);
      try {
        if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 64 * 1024 * 1024
          || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 240000) throw new BiliError('invalid_input');
        const method = options.method ?? 'GET';
        if (method !== 'GET' && method !== 'POST' || method === 'GET' && options.body !== undefined
          || options.body !== undefined && (typeof options.body !== 'string' || Buffer.byteLength(options.body) > 32768)) throw new BiliError('invalid_input');
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(options.headers ?? {})) {
          const name = key.toLowerCase();
          if (!['accept', 'accept-encoding', 'user-agent', 'referer', 'content-type', 'cookie', 'range', 'origin', 'x-csrf-token'].includes(name)
            || ['range', 'origin', 'x-csrf-token'].includes(name) && Object.hasOwn(headers, name)
            || typeof value !== 'string' || /[\r\n\x00]/.test(value) || value.length > 16384) throw new BiliError('invalid_input');
          headers[name] = value;
        }
        if (headers.range !== undefined) {
          // Only the full representation from byte zero is supported; never multipart or arbitrary slices.
          if (method !== 'GET' || headers.range !== 'bytes=0-'
            || headers['accept-encoding'] !== undefined && headers['accept-encoding'] !== 'identity') throw new BiliError('invalid_input');
          headers['accept-encoding'] = 'identity';
        }
        let url = safeUrl(input);
        if (headers.origin !== undefined || headers['x-csrf-token'] !== undefined) {
          // These additional write headers must never reach media hosts, redirects or unrelated APIs.
          if (method !== 'POST' || url.hostname !== 'api.bilibili.com' || url.pathname !== '/x/v2/reply/add' || url.search)
            throw new BiliError('unsafe_url');
          if (headers.origin !== undefined && headers.origin !== 'https://www.bilibili.com') throw new BiliError('invalid_input');
          if (headers['x-csrf-token'] !== undefined) {
            const csrf = new URLSearchParams(options.body).getAll('csrf');
            if (!/^[A-Za-z0-9]{16,128}$/.test(headers['x-csrf-token']) || csrf.length !== 1 || csrf[0] !== headers['x-csrf-token'])
              throw new BiliError('invalid_input');
          }
        }
        if (headers.cookie && !COOKIE_HOSTS.has(url.hostname)) throw new BiliError('unsafe_url');
        const refreshPost = url.hostname === 'passport.bilibili.com' && !url.search
          && ['/x/passport-login/web/cookie/refresh', '/x/passport-login/web/confirm/refresh'].includes(url.pathname);
        if (method === 'POST' && url.hostname !== 'api.bilibili.com' && !refreshPost) throw new BiliError('unsafe_url');
        if (signal.aborted) throw abortError();
        timer = setTimeout(() => deadline.abort(), options.timeoutMs); timer.unref();
        for (let redirects = 0; ; redirects++) {
          const hostname = url.hostname.replace(/^\[|\]$/g, '');
          const addresses = await new Promise<{ address: string; family: number }[]>((accept, reject) => {
            const cancel = () => { cleanup(); reject(abortError()); };
            const cleanup = () => signal.removeEventListener('abort', cancel);
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) return cancel();
            Promise.resolve().then(() => isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : resolve(hostname))
              .then(value => { cleanup(); accept(value); }, error => { cleanup(); reject(error); });
          });
          if (signal.aborted) throw abortError();
          if (!addresses.length || addresses.some(item => ![4, 6].includes(item.family) || !publicAddress(item.address))) throw new BiliError('unsafe_url');
          const address = addresses[0];
          const response = await new Promise<TransportResponse>((accept, reject) => {
            let request: ClientRequest | undefined, incoming: IncomingMessage | undefined;
            let settled = false, decoder: ReturnType<typeof createGunzip> | undefined;
            const cleanup = () => signal.removeEventListener('abort', cancel);
            const fail = (error: unknown) => {
              if (settled) return; settled = true; cleanup();
              decoder?.destroy(); incoming?.destroy(); request?.destroy(); reject(error);
            };
            const cancel = () => fail(abortError());
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) return cancel();
            try {
              request = send(url, {
                method, headers, agent: false, servername: isIP(hostname) ? undefined : hostname,
                lookup: (_name: string, lookupOptions: { all?: boolean }, callback: (...args: any[]) => void) =>
                  lookupOptions.all ? callback(null, [address]) : callback(null, address.address, address.family),
              }, response => {
                incoming = response;
                if (settled) { response.destroy(); return; }
                void (async () => {
                  const status = response.statusCode ?? 0;
                  const resultHeaders: Record<string, string | string[]> = {};
                  for (const key of ['content-type', 'location', 'set-cookie', 'content-length', 'content-encoding', 'content-range']) {
                    const value = response.headers[key]; if (value !== undefined) resultHeaders[key] = value;
                  }
                  if (status < 200 || status >= 300) {
                    settled = true; cleanup(); response.destroy(); accept({ status, headers: resultHeaders, body: Buffer.alloc(0), url: url.href }); return;
                  }
                  const length = Number(response.headers['content-length']);
                  if (Number.isFinite(length) && length > options.maxBytes) throw new BiliError('too_large');
                  const encoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase().trim();
                  if (headers.range !== undefined && encoding !== 'identity') throw new BiliError('unsupported_media');
                  if (!['identity', 'gzip', 'deflate', 'br'].includes(encoding)) throw new BiliError('malformed_response');
                  let wire = 0;
                  response.on('data', chunk => { wire += chunk.length; if (wire > options.maxBytes) fail(new BiliError('too_large')); });
                  response.on('error', error => fail(error));
                  let stream: AsyncIterable<Buffer> = response;
                  if (encoding !== 'identity') {
                    decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : createBrotliDecompress();
                    response.pipe(decoder); stream = decoder;
                  }
                  const chunks: Buffer[] = []; let decoded = 0;
                  for await (const raw of stream) {
                    const chunk = Buffer.from(raw); decoded += chunk.length;
                    if (decoded > options.maxBytes) throw new BiliError('too_large');
                    chunks.push(chunk);
                  }
                  if (settled) return;
                  if (signal.aborted) throw abortError();
                  if (!response.complete) throw new BiliError('network_error');
                  settled = true; cleanup(); accept({ status, headers: resultHeaders, body: Buffer.concat(chunks, decoded), url: url.href });
                })().catch(fail);
              });
              request.on('error', fail);
              if (signal.aborted) return cancel();
              if (method === 'POST') submitted = true;
              request.end(options.body);
            } catch (error) { fail(error); }
          });
          if (![301, 302, 303, 307, 308].includes(response.status)) return response;
          if (method === 'POST') throw new TransportError('uncertain', submitted);
          if (redirects >= 5) throw new BiliError('access_blocked');
          const location = response.headers.location;
          if (typeof location !== 'string' || !location) throw new BiliError('malformed_response');
          let redirected: string; try { redirected = new URL(location, url).href; } catch { throw new BiliError('unsafe_url'); }
          url = safeUrl(redirected);
          delete headers.cookie;
        }
      } catch (error) {
        if (signal.aborted) throw abortError();
        throw error instanceof TransportError ? error : new TransportError(error instanceof BiliError ? error.code : 'network_error', submitted);
      } finally { if (timer) clearTimeout(timer); deadline.abort(); }
    },
    dispose() { lifetime.abort(); },
  };
}
