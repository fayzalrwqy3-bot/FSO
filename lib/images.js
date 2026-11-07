'use strict';

const axios = require('axios');
const sharp = require('sharp');
const config = require('./config');
const http = require('./http');
const { Cache } = require('./cache');
const cache = new Cache(32);
const MAX_BYTES = 3 * 1024 * 1024;

function imageSource(value, canonical = true) {
  const url = new URL(value, config.base);
  const hosts = new Set([new URL(config.base).hostname, 'w8.shooflive.cyou', 's3.shooflive.cyou', 'shooflive.net']);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port || !hosts.has(url.hostname) ||
      !/^\/wp-content\/uploads\/[\w%/().,+@ -]+\.(?:webp|png|jpe?g|gif)$/i.test(url.pathname) || url.search.length > 200) {
    throw new Error('Invalid image source');
  }
  return canonical ? new URL(url.pathname + url.search, config.base).href : url.href;
}

function publicImage(value, origin) {
  if (!value || !origin) return value;
  try {
    const url = imageSource(value);
    return `${origin}/image/${Buffer.from(url).toString('base64url')}.jpg`;
  } catch { return value; }
}

function presentMeta(meta, origin) {
  if (!meta) return meta;
  const result = { ...meta };
  for (const field of ['poster', 'background', 'logo']) if (meta[field]) result[field] = publicImage(meta[field], origin);
  if (meta.videos) result.videos = meta.videos.map(video => ({ ...video, ...(video.thumbnail ? { thumbnail: publicImage(video.thumbnail, origin) } : {}) }));
  return result;
}

// Keep image fetching separate from the VPS video proxy. Only site uploads are
// accepted, redirects are validated, and image bodies have a strict size limit.
async function downloadImage(value) {
  const source = imageSource(value);
  return cache.get(source, 3600000, async () => {
    const candidates = [source];
    const original = source.replace(/-\d{2,4}x\d{2,4}(?=\.(?:webp|png|jpe?g|gif)(?:\?|$))/i, '');
    if (original !== source) candidates.push(original);
    let lastError;
    for (const candidate of candidates) {
      let url = candidate;
      try {
        for (let redirect = 0; redirect < 4; redirect++) {
          const response = await axios.get(url, {
            headers: http.headers(config.base + '/'), timeout: 6000, maxRedirects: 0,
            maxContentLength: MAX_BYTES, responseType: 'arraybuffer', validateStatus: status => status >= 200 && status < 400
          });
          if (response.status >= 300) {
            if (!response.headers.location) throw new Error('Missing image redirect');
            url = imageSource(new URL(response.headers.location, url).href, false);
            continue;
          }
          const body = Buffer.from(response.data);
          let mime;
          if (body.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) mime = 'image/jpeg';
          else if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = 'image/png';
          else if (body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WEBP') mime = 'image/webp';
          else if (/^GIF8[79]a$/.test(body.subarray(0, 6).toString())) mime = 'image/gif';
          if (!mime || body.length > MAX_BYTES) throw new Error('Invalid image body');
          const jpeg = await sharp(body, { limitInputPixels: 20000000 })
            .rotate().resize({ width: 1200, withoutEnlargement: true })
            .flatten({ background: '#111111' }).jpeg({ quality: 85 }).toBuffer();
          if (jpeg.length > MAX_BYTES) throw new Error('Image output too large');
          return { body: jpeg, mime: 'image/jpeg' };
        }
        throw new Error('Too many image redirects');
      } catch (error) {
        lastError = error;
        if (error.response?.status !== 404) break;
      }
    }
    throw lastError;
  });
}

async function serveImage(req, res, token) {
  try {
    if (!/^[A-Za-z0-9_-]{1,4000}$/.test(token)) throw new Error('Invalid image ID');
    const value = Buffer.from(token, 'base64url').toString('utf8');
    imageSource(value);
    const { body, mime } = await downloadImage(value);
    res.statusCode = 200;
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', body.length);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    res.statusCode = 404;
    res.setHeader('Cache-Control', 'no-store');
    res.end();
  }
}

module.exports = { imageSource, publicImage, presentMeta, downloadImage, serveImage };
