'use strict';

// Kirmizi's presentation layers: light catalog metadata, full title metadata,
// and season video objects. Source discovery remains in source.js.
const config = require('./config');
const http = require('./http');
const source = require('./source');
const { Cache } = require('./cache');
const cache = new Cache(700);
const image = (path, size = 'w500') => path ? `https://image.tmdb.org/t/p/${size}${path}` : '';
const date = value => value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;

async function request(path, params = '', timeout = 5000) {
  return http.json(`https://api.themoviedb.org/3/${path}?api_key=${encodeURIComponent(config.tmdbKey)}&language=ar-SA${params}`, timeout);
}
async function light(type, name, timeout = 1200) {
  if (!config.tmdbKey) return null;
  return cache.get(`light:${type}:${name}`, 86400000, async () => {
    const title = source.normalize(name);
    if (!title) return null;
    const kind = type === 'movie' ? 'movie' : 'tv';
    const data = await request(`search/${kind}`, `&query=${encodeURIComponent(title)}`, timeout);
    const year = name.match(/\s((?:19|20)\d{2})(?:\s|$)/)?.[1];
    const matches = (data.results || []).filter(x =>
      [x.name, x.original_name, x.title, x.original_title].filter(Boolean).some(n => source.normalize(n) === title) &&
      (type !== 'movie' || !year || (x.release_date || '').startsWith(year)));
    return matches.length === 1 ? matches[0] : null;
  });
}
function catalogObject(row, tmdb) {
  const poster = image(tmdb?.poster_path) || row.poster || '';
  const released = date(tmdb?.first_air_date || tmdb?.release_date);
  const result = {
    id: row.id, type: row.type, name: tmdb?.name || tmdb?.title || row.name,
    poster, background: image(tmdb?.backdrop_path, 'w1280') || poster,
    description: tmdb?.overview || row.description || row.name,
    releaseInfo: (tmdb?.first_air_date || tmdb?.release_date || '').slice(0, 4),
    genres: (tmdb?.genres || []).map(g => g.name).filter(Boolean), posterShape: 'poster'
  };
  if (released) result.released = released;
  if (tmdb?.vote_average) result.imdbRating = Number(tmdb.vote_average).toFixed(1);
  return result;
}
async function full(type, name) {
  const hit = await light(type, name, 5000);
  if (!hit) return null;
  const kind = type === 'movie' ? 'movie' : 'tv';
  return cache.get(`full:${kind}:${hit.id}`, 86400000, () => request(`${kind}/${hit.id}`,
    '&append_to_response=external_ids,credits,aggregate_credits,images,content_ratings,videos&include_image_language=ar,en,null'));
}
async function season(id, number) {
  return cache.get(`season:${id}:${number}`, 43200000, () => request(`tv/${id}/season/${number}`));
}
function enrichFull(row, tmdb) {
  const result = catalogObject(row, tmdb);
  const credits = (tmdb?.aggregate_credits?.cast ? tmdb.aggregate_credits : tmdb?.credits) || {};
  const cast = (credits.cast || []).slice(0, 12).map(c => c.name).filter(Boolean);
  const crew = credits.crew || [];
  const directors = crew.filter(c => c.job === 'Director' || c.jobs?.some(j => /Director/.test(j.job))).map(c => c.name);
  const writers = crew.filter(c => c.department === 'Writing').map(c => c.name);
  const logos = tmdb?.images?.logos || [];
  const logo = ['ar', 'en', null].map(language => logos.find(l => l.iso_639_1 === language)).find(Boolean);
  if (logo) result.logo = image(logo.file_path);
  const imdb = tmdb?.imdb_id || tmdb?.external_ids?.imdb_id;
  if (imdb) result.imdb_id = imdb;
  if (cast.length) result.cast = cast;
  if (directors.length) result.director = [...new Set(directors)].slice(0, 3);
  if (writers.length) result.writer = [...new Set(writers)].slice(0, 3);
  const trailers = (tmdb?.videos?.results || []).filter(v => v.site === 'YouTube' && ['Trailer', 'Teaser'].includes(v.type));
  if (trailers.length) result.trailers = trailers.slice(0, 3).map(v => ({source:v.key, type:'Trailer'}));
  return result;
}
module.exports = { light, full, season, catalogObject, enrichFull, date, image };
