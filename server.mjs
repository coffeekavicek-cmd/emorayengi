import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const DB = path.join(DATA, 'db.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

await fs.mkdir(UPLOADS, { recursive: true });
try { await fs.access(DB); } catch { await fs.writeFile(DB, JSON.stringify({ projects: [], events: [] }, null, 2)); }

const PLAN = {
  STANDARD: { name: 'Shablon', priceUzs: 49990 },
  PRO_AI: { name: 'EMORA AI', priceUzs: 69990 }
};
const MIME = {
  '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp',
  '.svg':'image/svg+xml','.mp3':'audio/mpeg','.m4a':'audio/mp4','.mp4':'video/mp4','.webm':'video/webm','.ico':'image/x-icon'
};

function send(res, status, body, type='text/plain; charset=utf-8', extra={}) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra
  });
  res.end(body);
}
function json(res, status, obj) { send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8'); }
function ok(res, data={}) { json(res, 200, { ok:true, ...data }); }
function fail(res, status, message, code='ERROR') { json(res, status, { ok:false, error:{ code, message } }); }

async function bodyJson(req, max=20*1024*1024) {
  let total=0; const chunks=[];
  for await (const chunk of req) { total += chunk.length; if (total > max) throw Object.assign(new Error('Request too large'), { status:413 }); chunks.push(chunk); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status:400 }); }
}
async function readDb() {
  try { return JSON.parse(await fs.readFile(DB, 'utf8')); }
  catch { return { projects:[], events:[] }; }
}
let writeLock = Promise.resolve();
async function updateDb(fn) {
  let result;
  writeLock = writeLock.then(async()=>{
    const db = await readDb();
    result = await fn(db);
    await fs.writeFile(DB, JSON.stringify(db, null, 2));
  });
  await writeLock;
  return result;
}
function id(prefix) { return `${prefix}_${crypto.randomBytes(7).toString('hex')}`; }
function slug() { return crypto.randomBytes(7).toString('base64url').replace(/[-_]/g,'').slice(0,10); }
function extFor(mime='') {
  if (mime.includes('png')) return '.png'; if (mime.includes('webp')) return '.webp'; if (mime.includes('jpeg')||mime.includes('jpg')) return '.jpg';
  if (mime.includes('mp4')) return '.mp4'; if (mime.includes('webm')) return '.webm'; if (mime.includes('mpeg')) return '.mp3'; if (mime.includes('audio/mp4')) return '.m4a'; return '.bin';
}

async function api(req, res, url) {
  if (url.pathname === '/api/health') return ok(res, { service:'emora', version:'8.0.0', status:'ready', port:PORT, time:new Date().toISOString() });
  if (url.pathname === '/api/config') return ok(res, { demoMode:true, plans:PLAN });

  const pub = url.pathname.match(/^\/api\/public\/emotion\/([^/]+)$/);
  if (pub && req.method === 'GET') {
    const db = await readDb(); const project = db.projects.find(p=>p.slug===decodeURIComponent(pub[1]) && p.status==='PUBLISHED');
    if (!project) return fail(res, 404, 'EMORA topilmadi');
    return ok(res, { project });
  }
  if (url.pathname === '/api/public/event' && req.method === 'POST') {
    const b = await bodyJson(req, 256*1024);
    await updateDb(db=>db.events.push({ id:id('evt'), projectId:String(b.projectId||''), type:String(b.type||'open'), at:new Date().toISOString() }));
    return ok(res);
  }

  if (url.pathname === '/api/projects' && req.method === 'POST') {
    const b = await bodyJson(req);
    const plan = String(b.plan||'STANDARD').toUpperCase();
    if (!PLAN[plan]) return fail(res, 400, 'Invalid plan');
    const recipientName = String(b.recipientName||'').trim().slice(0,80);
    if (!recipientName) return fail(res, 400, 'Recipient name required');
    const now = new Date().toISOString();
    const project = {
      id:id('prj'), recipientName, plan, brief:b.brief||{}, media:[], concepts:[], selectedConceptId:null,
      story:null, payments:[], status:'PAYMENT_REQUIRED', slug:null, createdAt:now, updatedAt:now
    };
    await updateDb(db=>db.projects.push(project));
    return ok(res, { project, payment:{ stage:'full', uzs:PLAN[plan].priceUzs, title:PLAN[plan].name } });
  }

  const m = url.pathname.match(/^\/api\/projects\/([^/]+)\/(.+)$/);
  if (!m) return fail(res, 404, 'API route not found');
  const projectId = m[1], action = m[2];
  const db0 = await readDb(); const project0 = db0.projects.find(p=>p.id===projectId);
  if (!project0) return fail(res, 404, 'Project not found');

  if (action === 'media' && req.method === 'POST') {
    const b = await bodyJson(req, 25*1024*1024);
    const hit = String(b.dataUrl||'').match(/^data:([^;]+);base64,(.+)$/s);
    if (!hit) return fail(res, 400, 'Invalid media data');
    const mime = hit[1]; const data = Buffer.from(hit[2], 'base64');
    if (data.length > 15*1024*1024) return fail(res, 413, 'Media file is too large');
    const kind = mime.startsWith('image/')?'image':mime.startsWith('video/')?'video':mime.startsWith('audio/')?'audio':'file';
    const role = String(b.role||'content');
    const filename = `${id('m')}${extFor(mime)}`;
    await fs.writeFile(path.join(UPLOADS, filename), data);
    const media = { id:id('med'), kind, role, mime, name:String(b.name||filename).slice(0,120), size:data.length, url:`/uploads/${filename}` };
    await updateDb(db=>{ const p=db.projects.find(x=>x.id===projectId); p.media.push(media); p.updatedAt=new Date().toISOString(); });
    return ok(res, { media });
  }

  if (action === 'payments/demo' && req.method === 'POST') {
    const b = await bodyJson(req, 256*1024); const provider = String(b.provider||'CLICK').toUpperCase();
    if (!['CLICK','PAYME'].includes(provider)) return fail(res, 400, 'Provider must be CLICK or PAYME');
    const payment = { id:id('pay'), provider, stage:'full', status:'PAID', amountUzs:PLAN[project0.plan].priceUzs, paidAt:new Date().toISOString() };
    await updateDb(db=>{ const p=db.projects.find(x=>x.id===projectId); p.payments.push(payment); p.status='PAID'; p.updatedAt=new Date().toISOString(); });
    return ok(res, { paid:true, provider, payment });
  }

  if (action === 'concepts/generate' && req.method === 'POST') {
    const concept = project0.plan === 'PRO_AI'
      ? { id:'ai-personal', name:'EMORA AI Personal', summary:'Tanlangan yo‘nalish uchun personal interaktiv experience.' }
      : { id:'template', name:'EMORA Template', summary:'Tanlangan premium interaktiv shablon.' };
    await updateDb(db=>{ const p=db.projects.find(x=>x.id===projectId); p.concepts=[concept]; p.status='CONCEPTS_READY'; });
    return ok(res, { concepts:[concept] });
  }

  if (action === 'concept/select' && req.method === 'POST') {
    const b = await bodyJson(req, 256*1024);
    await updateDb(db=>{ const p=db.projects.find(x=>x.id===projectId); p.selectedConceptId=String(b.conceptId||'template'); p.status='CONCEPT_SELECTED'; });
    return ok(res, { project:(await readDb()).projects.find(x=>x.id===projectId) });
  }

  if (action === 'build' && req.method === 'POST') {
    const db = await readDb(); const p0=db.projects.find(x=>x.id===projectId);
    if (!p0.payments.some(x=>x.status==='PAID')) return fail(res, 402, 'Payment required');
    const story = { version:1, category:p0.brief?.category||'birthday', template:p0.brief?.templateName||'EMORA', generatedAt:new Date().toISOString() };
    await updateDb(db=>{ const p=db.projects.find(x=>x.id===projectId); p.story=story; p.status='PREVIEW'; p.updatedAt=new Date().toISOString(); });
    return ok(res, { project:(await readDb()).projects.find(x=>x.id===projectId) });
  }

  if (action === 'finish' && req.method === 'POST') {
    const db = await readDb(); const p0=db.projects.find(x=>x.id===projectId);
    if (!p0.payments.some(x=>x.status==='PAID')) return fail(res, 402, 'Payment required');
    const s = p0.slug || slug();
    await updateDb(db=>{ const p=db.projects.find(x=>x.id===projectId); p.slug=s; p.status='PUBLISHED'; p.publishedAt=new Date().toISOString(); p.updatedAt=new Date().toISOString(); });
    return ok(res, { project:(await readDb()).projects.find(x=>x.id===projectId) });
  }

  return fail(res, 404, 'Project action not found');
}

async function serve(req, res, url) {
  if (url.pathname.startsWith('/uploads/')) {
    const filename = path.basename(url.pathname);
    const file = path.join(UPLOADS, filename);
    try { const data = await fs.readFile(file); return send(res, 200, data, MIME[path.extname(file)]||'application/octet-stream', { 'cache-control':'public, max-age=31536000, immutable' }); }
    catch { return fail(res, 404, 'File not found'); }
  }
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//,'');
  const candidate = path.join(PUBLIC, rel);
  if (candidate.startsWith(PUBLIC)) {
    try { const st=await fs.stat(candidate); if (st.isFile()) { const data=await fs.readFile(candidate); return send(res, 200, data, MIME[path.extname(candidate)]||'application/octet-stream', { 'cache-control': path.extname(candidate)==='.html'?'no-store':'public, max-age=3600' }); } } catch {}
  }
  const html = await fs.readFile(path.join(PUBLIC,'index.html'));
  return send(res, 200, html, 'text/html; charset=utf-8');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return await serve(req, res, url);
  } catch (e) {
    console.error(e);
    return fail(res, e.status||500, e.message||'Internal server error');
  }
});

server.listen(PORT, HOST, () => console.log(`EMORA v8 listening on http://${HOST}:${PORT}`));
