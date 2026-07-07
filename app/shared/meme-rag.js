const fs = require('fs');
const path = require('path');

const DEFAULT_THRESHOLD = 0.54;

function createMemeRagStore(options = {}) {
    const dbPath = options.dbPath || path.join(process.cwd(), 'data', 'meme-rag-db.json');
    let db = loadDb(dbPath);

    function persist() {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
    }

    function reload() {
        db = loadDb(dbPath);
        return snapshot();
    }

    function snapshot() {
        return {
            path: dbPath,
            updatedAt: db.updatedAt || 0,
            count: db.items.length,
            items: db.items.map(publicItem)
        };
    }

    function list() {
        return snapshot();
    }

    function upsertMany(items = [], source = 'manual') {
        const now = Date.now();
        const nextItems = normalizeItems(items, source, now);
        const existing = new Map(db.items.map((item) => [item.key, item]));
        nextItems.forEach((item) => {
            existing.set(item.key, {
                ...(existing.get(item.key) || {}),
                ...item,
                updatedAt: now,
                vector: vectorizeItem(item)
            });
        });
        db.items = Array.from(existing.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        db.updatedAt = now;
        persist();
        return {
            added: nextItems.length,
            count: db.items.length,
            items: nextItems.map(publicItem)
        };
    }

    function remove(key) {
        const normalized = normalizeKey(key);
        const before = db.items.length;
        db.items = db.items.filter((item) => item.key !== normalized);
        if (before !== db.items.length) {
            db.updatedAt = Date.now();
            persist();
        }
        return { removed: before - db.items.length, count: db.items.length };
    }

    function clear() {
        db.items = [];
        db.updatedAt = Date.now();
        persist();
        return { count: 0 };
    }

    function match(text, options = {}) {
        const threshold = Number.isFinite(options.threshold) ? Number(options.threshold) : DEFAULT_THRESHOLD;
        const limit = Number.isFinite(options.limit) ? Number(options.limit) : 5;
        const query = normalizeText(text);
        if (!query) {
            return { matches: [] };
        }
        const queryVector = vectorizeText(query);
        const matches = db.items
            .map((item) => {
                const exactScore = exactMatchScore(query, item);
                const vectorScore = cosineSimilarity(queryVector, item.vector || vectorizeItem(item));
                const score = Math.max(exactScore, vectorScore);
                return {
                    ...publicItem(item),
                    score,
                    reason: exactScore >= 1 ? 'exact-or-alias' : 'vector-similarity'
                };
            })
            .filter((item) => item.score >= threshold)
            .sort((a, b) => b.score - a.score || (b.updatedAt || 0) - (a.updatedAt || 0))
            .slice(0, limit);
        return { matches, threshold, query };
    }

    return {
        dbPath,
        reload,
        list,
        upsertMany,
        remove,
        clear,
        match
    };
}

function createMemeRagRouter(options = {}) {
    const express = require('express');
    const router = express.Router();
    const store = options.store;
    const parseMemeText = options.parseMemeText;

    router.get('/status', (_req, res) => {
        res.json(store.list());
    });

    router.get('/items', (_req, res) => {
        res.json(store.list());
    });

    router.post('/items', (req, res) => {
        res.json(store.upsertMany([req.body || {}], 'manual'));
    });

    router.post('/bulk', (req, res) => {
        res.json(store.upsertMany(Array.isArray(req.body.items) ? req.body.items : [], req.body.source || 'bulk'));
    });

    router.delete('/items/:key', (req, res) => {
        res.json(store.remove(req.params.key));
    });

    router.post('/match', (req, res) => {
        res.json(store.match(req.body && req.body.text, req.body || {}));
    });

    router.post('/import', async (req, res) => {
        if (!parseMemeText) {
            res.status(501).json({ error: '解析器未配置' });
            return;
        }
        const parsed = await parseMemeText(req.body || {});
        const items = Array.isArray(parsed.memes) ? parsed.memes : [];
        const result = store.upsertMany(items, req.body.source || 'ai-import');
        res.json({
            ...result,
            parsed: items.length
        });
    });

    return router;
}

function renderMemeRagAdminPage() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>热梗匹配 RAG 后台</title>
<style>
:root{color-scheme:dark;--bg:#1f1d1a;--panel:#2b2925;--line:rgba(255,255,255,.1);--text:#f4eee5;--muted:#a89d91;--accent:#ff9b24;--gold:#ffc13d}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,#211f1b,#151412);color:var(--text);font:14px "Microsoft YaHei UI","Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:22px}.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
h1{margin:0;font-size:22px}.status{color:var(--muted);font-size:12px}.grid{display:grid;grid-template-columns:380px 1fr;gap:14px}
.card{border:1px solid var(--line);border-radius:10px;background:rgba(43,41,37,.86);box-shadow:0 18px 42px rgba(0,0,0,.24);overflow:hidden}
.card h2{margin:0;padding:13px 14px;border-bottom:1px solid var(--line);font-size:14px;color:#ffd28a}
.body{padding:14px}label{display:block;margin:0 0 6px;color:var(--muted);font-size:12px}
input,textarea{width:100%;border:1px solid var(--line);border-radius:8px;outline:none;color:var(--text);background:rgba(255,255,255,.045);font:13px inherit}
input{height:34px;padding:0 10px}textarea{min-height:82px;padding:10px;resize:vertical}.row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:9px}
button,.file{height:34px;border:1px solid rgba(255,155,36,.3);border-radius:8px;color:#231405;background:linear-gradient(135deg,var(--gold),#ff8820);font-weight:600;cursor:pointer}
.ghost{color:#ffc071;background:rgba(255,132,32,.08)}.file{display:grid;place-items:center;color:#ffc071;background:rgba(255,132,32,.08)}input[type=file]{display:none}
.list{display:grid;gap:8px;max-height:650px;overflow:auto;padding:14px}.item{display:grid;grid-template-columns:minmax(0,1fr)64px;gap:12px;align-items:center;border:1px solid var(--line);border-radius:9px;padding:10px;background:rgba(255,255,255,.035)}
.item strong{display:block;font-size:14px}.item p{margin:5px 0 0;color:#d7cec4;font-size:12px;line-height:1.45}.item small{display:block;margin-top:5px;color:var(--muted)}
.item button{height:28px;font-size:12px}.match{border-color:rgba(255,155,36,.36);background:rgba(255,132,32,.08)}.pill{display:inline-block;margin:4px 5px 0 0;padding:2px 6px;border-radius:999px;color:#ffd49a;background:rgba(255,132,32,.12);font-size:11px}
.message{min-height:20px;margin-top:8px;color:#ffc071;font-size:12px}@media(max-width:900px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<main>
<div class="top"><h1>热梗匹配 RAG 后台</h1><div class="status" id="status">加载中</div></div>
<div class="grid">
<section class="card">
<h2>上传/解析入库</h2>
<div class="body">
<label>粘贴热梗资料或运营文档正文</label>
<textarea id="bulkText" placeholder="例如：赛事梗整理、直播间黑话、Word 文档正文..."></textarea>
<div class="row">
<label class="file" for="fileInput">上传 TXT/Word</label>
<input id="fileInput" type="file" accept=".txt,.md,.json,.csv,.log,.docx">
<button id="importBtn">AI 解析入库</button>
</div>
<div class="message" id="importMessage"></div>
<hr style="border:0;border-top:1px solid var(--line);margin:14px 0">
<label>手动新增热梗</label>
<input id="content" placeholder="热梗原句">
<div class="row"><input id="aliases" placeholder="别名，逗号分隔"><input id="tags" placeholder="标签，逗号分隔"></div>
<textarea id="description" placeholder="含义/来源/直播间接法"></textarea>
<div class="row"><button id="addBtn">加入向量库</button><button class="ghost" id="reloadBtn">刷新列表</button></div>
<div class="message" id="addMessage"></div>
<hr style="border:0;border-top:1px solid var(--line);margin:14px 0">
<label>测试相似匹配</label>
<input id="query" placeholder="输入一条弹幕测试命中">
<div class="row"><button id="matchBtn">匹配</button><button class="ghost" id="clearMatchBtn">清空结果</button></div>
<div id="matchList" class="list" style="max-height:240px;padding:10px 0 0"></div>
</div>
</section>
<section class="card"><h2>向量库条目</h2><div class="list" id="items"></div></section>
</div>
</main>
<script>
let filePayload=null;
const $=(id)=>document.getElementById(id);
const api=(url,options={})=>fetch(url,{headers:{'Content-Type':'application/json'},...options}).then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.statusText);return j});
function base64(buffer){let b='';const bytes=new Uint8Array(buffer);for(let i=0;i<bytes.length;i+=32768)b+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(b)}
async function load(){const data=await api('/api/meme-rag/items');$('status').textContent='共 '+data.count+' 条 · '+(data.path||'');$('items').innerHTML=data.items.length?data.items.map(renderItem).join(''):'<div class="item"><p>暂无热梗，先上传文档或手动新增。</p></div>';bindRemove()}
function renderItem(item,cls=''){return '<div class="item '+cls+'"><div><strong>'+esc(item.content)+'</strong><p>'+esc(item.description||'')+'</p><small>别名：'+esc((item.aliases||[]).join(' / ')||'无')+'</small>'+((item.tags||[]).map(t=>'<span class="pill">'+esc(t)+'</span>').join(''))+(item.score?'<small>相似度 '+Math.round(item.score*100)+'% · '+esc(item.reason||'')+'</small>':'')+'</div><button class="ghost" data-remove="'+esc(item.key)+'">删除</button></div>'}
function bindRemove(){document.querySelectorAll('[data-remove]').forEach(btn=>btn.onclick=async()=>{await fetch('/api/meme-rag/items/'+encodeURIComponent(btn.dataset.remove),{method:'DELETE'});load()})}
function esc(v){return String(v||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
$('fileInput').onchange=async(e)=>{const f=e.target.files[0];if(!f)return;const buf=await f.arrayBuffer();filePayload={fileName:f.name,fileBase64:base64(buf)};$('bulkText').value=f.name.toLowerCase().endsWith('.docx')?'':new TextDecoder('utf-8').decode(buf).slice(0,20000);$('importMessage').textContent='已选择 '+f.name};
$('importBtn').onclick=async()=>{try{$('importMessage').textContent='AI 解析中...';const r=await api('/api/meme-rag/import',{method:'POST',body:JSON.stringify({text:$('bulkText').value,...(filePayload||{})})});$('importMessage').textContent='已入库 '+r.added+' 条';filePayload=null;$('bulkText').value='';load()}catch(e){$('importMessage').textContent=e.message}};
$('addBtn').onclick=async()=>{try{const item={content:$('content').value,aliases:$('aliases').value.split(/[，,、/]/).map(x=>x.trim()).filter(Boolean),tags:$('tags').value.split(/[，,、/]/).map(x=>x.trim()).filter(Boolean),description:$('description').value};const r=await api('/api/meme-rag/items',{method:'POST',body:JSON.stringify(item)});$('addMessage').textContent='已加入 '+r.added+' 条';['content','aliases','tags','description'].forEach(id=>$(id).value='');load()}catch(e){$('addMessage').textContent=e.message}};
$('matchBtn').onclick=async()=>{const r=await api('/api/meme-rag/match',{method:'POST',body:JSON.stringify({text:$('query').value,limit:8,threshold:.45})});$('matchList').innerHTML=r.matches.length?r.matches.map(x=>renderItem(x,'match')).join(''):'<p style="color:#a89d91">没有命中</p>'};
$('clearMatchBtn').onclick=()=>{$('matchList').innerHTML=''};
$('reloadBtn').onclick=load;load();
</script>
</body>
</html>`;
}

function loadDb(dbPath) {
    try {
        const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        const items = Array.isArray(raw.items) ? raw.items : [];
        return {
            version: 1,
            updatedAt: Number(raw.updatedAt) || 0,
            items: items.map((item) => ({
                ...item,
                key: normalizeKey(item.key || item.content),
                aliases: Array.isArray(item.aliases) ? item.aliases : [],
                tags: Array.isArray(item.tags) ? item.tags : [],
                vector: item.vector || vectorizeItem(item)
            })).filter((item) => item.key && item.content)
        };
    } catch (error) {
        return { version: 1, updatedAt: Date.now(), items: [] };
    }
}

function normalizeItems(items, source, now) {
    return items.map((item) => {
        const content = cleanField(item && item.content);
        if (!content) return null;
        const key = normalizeKey(item.key || content);
        return {
            key,
            content,
            aliases: Array.isArray(item.aliases) ? item.aliases.map(cleanField).filter(Boolean).slice(0, 12) : [],
            description: cleanText(item.description || ''),
            tags: Array.isArray(item.tags) ? item.tags.map(cleanField).filter(Boolean).slice(0, 8) : [],
            source: cleanField(item.source || source || 'manual'),
            createdAt: Number(item.createdAt) || now,
            updatedAt: now
        };
    }).filter(Boolean);
}

function publicItem(item) {
    return {
        key: item.key,
        content: item.content,
        aliases: item.aliases || [],
        description: item.description || '',
        tags: item.tags || [],
        source: item.source || '',
        createdAt: item.createdAt || 0,
        updatedAt: item.updatedAt || 0
    };
}

function exactMatchScore(query, item) {
    const candidates = [item.content, ...(item.aliases || [])].map(normalizeText).filter(Boolean);
    if (candidates.some((candidate) => query === candidate)) return 1;
    if (candidates.some((candidate) => query.includes(candidate) || candidate.includes(query))) return 0.92;
    return 0;
}

function vectorizeItem(item) {
    return vectorizeText([item.content, ...(item.aliases || []), item.description || '', ...(item.tags || [])].join(' '));
}

function vectorizeText(text) {
    const source = normalizeText(text);
    const vector = {};
    const push = (token, weight = 1) => {
        if (!token) return;
        vector[token] = (vector[token] || 0) + weight;
    };
    (source.match(/[a-z0-9]+/g) || []).forEach((word) => push(`w:${word}`, 2.4));
    const compact = source.replace(/[a-z0-9]+/g, '');
    for (let size = 1; size <= 3; size += 1) {
        for (let index = 0; index <= compact.length - size; index += 1) {
            push(`c:${compact.slice(index, index + size)}`, size === 1 ? 0.45 : size);
        }
    }
    return vector;
}

function cosineSimilarity(left, right) {
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    Object.keys(left || {}).forEach((key) => {
        const value = left[key];
        leftNorm += value * value;
        dot += value * ((right || {})[key] || 0);
    });
    Object.keys(right || {}).forEach((key) => {
        const value = right[key];
        rightNorm += value * value;
    });
    if (!leftNorm || !rightNorm) return 0;
    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function normalizeText(value) {
    return String(value || '')
        .replace(/\s+/g, '')
        .replace(/[!！?？。.,，~～、]+$/g, '')
        .toLowerCase();
}

function normalizeKey(value) {
    return normalizeText(value).slice(0, 80);
}

function cleanField(value) {
    return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/[<>]/g, '').trim().slice(0, 100);
}

function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').replace(/[<>]/g, '').trim().slice(0, 240);
}

module.exports = {
    DEFAULT_THRESHOLD,
    createMemeRagStore,
    createMemeRagRouter,
    renderMemeRagAdminPage,
    vectorizeText,
    cosineSimilarity,
    normalizeText,
    normalizeKey
};
