'use strict';
const raw=require('./source'),http=require('./http'),config=require('./config');
const {Cache,mapLimit}=require('./cache');
const cache=new Cache(200);
const metadata=require('./metadata');
const cheerio=require('cheerio');
const {deflateRawSync,inflateRawSync}=require('node:zlib');
const dubbed=v=>/مدبلج|دبلج|dubbed/i.test(v);
function isDubbed(row){let path='';try{path=raw.decodePath(new URL(raw.decodeId(row.id.split(':')[0])).pathname);}catch{}return dubbed(row.name+' '+path);}
async function excluded(){return cache.get('excluded',900000,async()=>{
 const ids=new Set();for(let skip=0;skip<2000;skip+=100){const a=await raw.catalog('series','shoof-dubbed-series','',skip);a.forEach(x=>ids.add(x.id));if(a.length<100)break;}return ids;
});}
async function seriesParent(row){
  let url;try{url=raw.decodeId(row.id);}catch{return row;}
  if(!new URL(url).pathname.startsWith('/episode/'))return row;
  try{
    const page=await raw.content(url), key=raw.normalize(page.name);
    const $=cheerio.load(page.html), matches=new Map();
    $('a[href]').each((_,el)=>{
      try{
        const target=raw.sourceUrl(new URL($(el).attr('href'),url).href);
        const path=new URL(target).pathname;if(!path.startsWith('/series/'))return;
        const slug=raw.normalize(raw.decodePath(path).replace(/^\/series\//,'').replace(/[-_/]/g,' '));
        const title=raw.normalize($(el).attr('title')||$(el).text());
        if(slug===key||title===key)matches.set(target,target);
      }catch{}
    });
    if(matches.size!==1)return row;
    const parent=[...matches.values()][0];
    return {...row,id:raw.encodeId(parent),name:raw.displayTitle(page.name).replace(/\s*(?:الموسم|الحلقة)\s+.*$/,'').trim()};
  }catch(e){http.warn('series-parent',url,e);return row;}
}
async function catalog(type,id,search='',skip=0){
 if(id==='shoof-dubbed-series'||!Number.isSafeInteger(skip)||skip<0)return [];
 const deny=await excluded();
 const size=id==='shoof-latest'?24:search?24:100;
 const collected=[];
 for(let offset=0;offset<=skip+1000;offset+=size){
  const rows=await raw.catalog(type,id,search,offset);
  collected.push(...rows.filter(x=>!deny.has(x.id)&&!isDubbed(x)));
  if(collected.length>=skip+size||rows.length<size)break;
 }
 const selected=collected.slice(skip,skip+size);
 if(id!=='shoof-latest')return selected;
 const parents=await mapLimit(selected,8,seriesParent);
 return [...new Map(parents.filter(row=>!deny.has(row.id)&&!isDubbed(row)).map(row=>[row.id,row])).values()];
}
async function api(path,extra=''){return http.json(`https://api.themoviedb.org/3/${path}?api_key=${encodeURIComponent(config.tmdbKey)}${extra}`);}
const iso=value=>value&&!Number.isNaN(Date.parse(value))?new Date(value).toISOString():undefined;
async function dates(meta,data){
 const result=new Map();
 if(data){
  const seasons=[...new Set(meta.videos.map(v=>v.season))];
  await mapLimit(seasons,3,async season=>{try{const d=await metadata.season(data.id,season);for(const e of d.episodes||[]){const released=iso(e.air_date);result.set(`${season}:${e.episode_number}`,{released,title:e.name,overview:e.overview,thumbnail:metadata.image(e.still_path,'w500')});}}catch(e){http.warn('season-dates',config.base,e);}});
 }
 if(meta.videos.some(v=>!result.get(`${v.season}:${v.episode}`)?.released)){
  // Use real source publication dates when the original air date cannot be identified.
  try{
   const name=raw.normalize(meta.name),parent=await raw.content(raw.decodeId(meta.id));
   const byPath=new Map(parent.episodes.map(e=>[new URL(e.url).pathname,`${e.season}:${e.episode}`]));
   if(new URL(parent.url).pathname.startsWith('/episode/'))byPath.set(new URL(parent.url).pathname,`${meta.videos[0].season}:${meta.videos[0].episode}`);
   for(let page=1;page<=10;page++){
    const d=await http.json(`${config.base}/wp-json/wp/v2/episodes?search=${encodeURIComponent(name)}&per_page=100&page=${page}&_fields=link,date_gmt`);
    if(!Array.isArray(d))break;
    for(const e of d){let key;try{key=byPath.get(new URL(e.link).pathname);}catch{}const released=iso(e.date_gmt?e.date_gmt+'Z':null);if(key&&released&&!result.get(key)?.released)result.set(key,{released});}
    if(d.length<100||meta.videos.every(v=>result.get(`${v.season}:${v.episode}`)?.released))break;
   }
  }catch(e){http.warn('source-dates',config.base,e);}
 }
 return result;
}
async function meta(type,id){
 if((await excluded()).has(id))return null;
 const m=await raw.meta(type,id);if(!m||isDubbed(m))return null;
 let lookupName=m.name;
 if(type==='movie')try{lookupName=(await raw.content(raw.decodeId(id))).name||lookupName;}catch{}
 const d=await metadata.full(type,lookupName).catch(e=>{http.warn('metadata',config.base,e);return null;});
 const result=metadata.enrichFull(m,d);
 if(m.videos){
  m.videos=m.videos.filter(v=>!dubbed(v.title));
  const releases=await dates(m,d);
  result.videos=m.videos.map(v=>{
    const info=releases.get(`${v.season}:${v.episode}`)||{};
    const video={id:v.id,title:info.title||`الحلقة ${v.episode}`,season:v.season,episode:v.episode};
    if(info.released)video.released=info.released;
    if(info.overview)video.overview=info.overview;
    if(info.thumbnail||v.thumbnail)video.thumbnail=info.thumbnail||v.thumbnail;
    return video;
  });
 }
 return result;
}
async function streams(type,fullId){
 const id=fullId.split(':')[0];if((await excluded()).has(id))return [];
 let page;try{page=await raw.content(raw.decodeId(id));}catch{return [];}
 if(isDubbed({id,name:page.name}))return [];
 const [,season,episode]=fullId.split(':');
 if(type==='series'&&page.episodes.length){const ep=page.episodes.find(e=>e.season===Number(season)&&e.episode===Number(episode));if(ep&&dubbed(ep.name+' '+raw.decodePath(ep.url)))return [];}
 return raw.streams(type,fullId);
}
// Public IDs belong exclusively to this addon. Never compete with legacy
// Soof metadata providers or their persistent client caches.
function publicId(value){
 const [id,...episode]=value.split(':');
 const path=new URL(raw.decodeId(id)).pathname;
 const marker=id.startsWith('shoof_short_')?'zs_':'z_';
 return 'shoofsub_'+marker+deflateRawSync(Buffer.from(path)).toString('base64url')+(episode.length?':'+episode.join(':'):'');
}
function internalId(value){
 if(!/^shoofsub_[A-Za-z0-9_-]{1,3000}(?::\d+:\d+)?$/.test(value))throw new Error('Unsupported content ID');
 const [id,...episode]=value.split(':');
 const packed=/^shoofsub_(z|zs)_(.+)$/.exec(id);
 let result;
 if(packed){
  const path=inflateRawSync(Buffer.from(packed[2],'base64url'),{maxOutputLength:4096}).toString('utf8');
  result=raw.encodeId(path);
  if(packed[1]==='zs')result=result.replace(/^shoof_/,'shoof_short_');
  raw.decodeId(result);
 }else result=id.replace(/^shoofsub_/,'shoof_');
 return result+(episode.length?':'+episode.join(':'):'');
}
module.exports={
 catalog:async(type,id,...args)=>{
  const rows=await catalog(type,id.replace(/^shoofsub-/, 'shoof-'),...args);
  const deadline=Date.now()+4000;
  return mapLimit(rows,8,async row=>{
    let hit=null;
    if(Date.now()<deadline)try{hit=await metadata.light(type,row.name);}catch(e){http.warn('catalog-metadata',config.base,e);}
    return metadata.catalogObject({...row,id:publicId(row.id)},hit);
  });
 },
 meta:async(type,id)=>{
  const m=await cache.get('full-meta:'+type+':'+id,300000,()=>meta(type,internalId(id)));
  if(!m)return null;
  return {...m,id,...(m.videos?{videos:m.videos.map(v=>({...v,id:publicId(v.id)}))}:{}),
   ...(m.behaviorHints?.defaultVideoId?{behaviorHints:{...m.behaviorHints,defaultVideoId:publicId(m.behaviorHints.defaultVideoId)}}:{})};
 },
 streams:(type,id)=>streams(type,internalId(id)),isDubbed,publicId,internalId
};
