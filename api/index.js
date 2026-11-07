'use strict';

const config = require('../lib/config');
const source = require('../lib/edition');
const categories = require('../lib/categories');
const { proxy } = require('../lib/proxy');
const { presentMeta, serveImage } = require('../lib/images');

const manifest = {
  id: 'org.hfip.shoofsub', version: '1.1.0', name: config.name,
  description: 'أفلام ومسلسلات شوف لايف مع اكتشاف السيرفرات والجودات تلقائياً.',
  resources: ['catalog', 'meta', 'stream'], types: ['movie', 'series'],
  idPrefixes: ['shoofsub_'],
  catalogs: [
    { type: 'series', id: 'shoof-latest', name: 'شوف لايف • آخر الحلقات', extra: [{ name: 'search' }, { name: 'skip' }] },
    ...['shoof-arabic-series', 'shoof-arabic-movies', 'shoof-turkish-series', 'shoof-turkish-movies',
      'shoof-foreign-series', 'shoof-foreign-movies', 'shoof-ramadan-2026',
      'shoof-asian-series', 'shoof-asian-movies', 'shoof-indian-movies', 'shoof-short-series']
      .map(id => categories.find(category => category.id === id))
      .map(({ type, id, name }) => ({ type, id, name, extra: [{ name: 'search' }, { name: 'skip' }] })),
    { type: 'series', id: 'shoof-series', name: 'شوف لايف • المسلسلات', extra: [{ name: 'search' }, { name: 'skip' }] },
    { type: 'movie', id: 'shoof-movies', name: 'شوف لايف • الأفلام', extra: [{ name: 'search' }, { name: 'skip' }] }
  ],
  behaviorHints: { configurable: false, configurationRequired: false }
};

// Catalog routes also have their own namespace to avoid legacy cache reuse.
manifest.catalogs.forEach(c => { c.id = c.id.replace(/^shoof-/, 'shoofsub-'); });

function send(res, payload, code = 200, seconds = 0) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', seconds ? `public, max-age=${seconds}` : 'no-store');
  res.end(JSON.stringify(payload));
}

function createHandler({ enableProxy = false } = {}) {
  return async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, If-Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { send(res, { error: 'Method not allowed' }, 405); return; }
    const url = new URL(req.url, 'http://localhost');
    // Vercel can replace req.url with the rewrite destination. Carry the
    // original route explicitly; direct VPS requests still use pathname.
    const routed = req.query?.route ?? url.searchParams.get('route');
    const originalRoute = Array.isArray(routed) ? routed[0] : routed;
    const path = typeof originalRoute === 'string' ? '/' + originalRoute.replace(/^\/+/, '') : url.pathname;
    if (path === '/' || path === '/manifest.json') return send(res, manifest, 200, 3600);
    if (path === '/health' || path === '/healthz') return send(res, { status: 'ok', version: manifest.version, tmdbEnabled: !!config.tmdbKey, proxyEnabled: enableProxy && config.proxySecret.length >= 32 });
    const host = req.headers?.['x-forwarded-host'] || req.headers?.host;
    const forwarded = req.headers?.['x-forwarded-proto'];
    const protocol = forwarded === 'https' ? 'https' : forwarded === 'http' || req.socket?.encrypted === false ? 'http' : 'https';
    const origin = typeof host === 'string' && /^[a-z0-9.-]+(?::\d+)?$/i.test(host) ? `${protocol}://${host}` : null;
    const image = path.match(/^\/image\/([A-Za-z0-9_-]+)\.jpg$/);
    if (image) return serveImage(req, res, image[1]);
    if (path === '/proxy/mp4') {
      if (!enableProxy) return send(res, { error: 'Video proxy requires a separate VPS endpoint' }, 404);
      return proxy(req, res, url.searchParams.get('token'));
    }
    const catalog = path.match(/^\/catalog\/(movie|series)\/([^/]+)(?:\/(.+))?\.json$/);
    const meta = path.match(/^\/meta\/(movie|series)\/([^/]+)\.json$/);
    const stream = path.match(/^\/stream\/(movie|series)\/([^/]+)\.json$/);
    try {
      if (catalog) {
        const [, type, id, extra = ''] = catalog;
        if (!manifest.catalogs.some(c => c.id === id && c.type === type)) return send(res, { metas: [] }, 404);
        const args = new URLSearchParams(extra);
        const skip = Number(args.get('skip') || 0);
        if (!Number.isSafeInteger(skip) || skip < 0) return send(res, { error: 'Invalid skip' }, 400);
        return send(res, { metas: (await source.catalog(type, id, args.get('search') || '', skip)).map(meta => presentMeta(meta, origin)) }, 200, 300);
      }
      if (meta) return send(res, { meta: presentMeta(await source.meta(meta[1], decodeURIComponent(meta[2])), origin) }, 200, 300);
      // Signed source URLs can expire; do not cache stream JSON at shared edges.
      if (stream) return send(res, { streams: await source.streams(stream[1], decodeURIComponent(stream[2])) });
    } catch (error) {
      console.warn(`[${catalog ? 'catalog' : meta ? 'meta' : 'stream'}] ${error.response?.status || error.code || error.name}`);
      if (catalog) return send(res, { metas: [] });
      if (meta) return send(res, { meta: null });
      if (stream) return send(res, { streams: [] });
    }
    return send(res, { error: 'Not found' }, 404);
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.manifest = manifest;
