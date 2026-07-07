const path = require('path');
const zlib = require('zlib');
const express = require('express');
const { createMemeRagStore, createMemeRagRouter, renderMemeRagAdminPage } = require('../app/shared/meme-rag');

const PORT = Number(process.env.MEME_RAG_PORT || 3100);
const AI_BASE_URL = process.env.MEME_RAG_AI_BASE_URL || 'https://ws-d2jrp9pxv8v3tdkq.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const AI_MODEL = process.env.MEME_RAG_AI_MODEL || 'qwen3.7-plus';
const AI_API_KEY = process.env.DASHSCOPE_API_KEY || process.env.MEME_RAG_AI_KEY || 'sk-ws-H.EMDLHYL.9skU.MEUCIQDsKktWcjuL9g_ZW7PtVBYKebiRaWQKL0l_1DL_fKIogAIgTLAlc58qVDo6IfUA4zG8UX1NfiMkrTYWU4XJoqPSxzA';

const app = express();
const store = createMemeRagStore({
    dbPath: process.env.MEME_RAG_DB || path.join(__dirname, '..', 'external-rag-data', 'meme-rag-db.json')
});

app.use(express.json({ limit: '30mb' }));
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use('/api/meme-rag', createMemeRagRouter({
    store,
    parseMemeText
}));

app.get(['/', '/rag', '/admin.html'], (_req, res) => {
    res.type('html').send(renderMemeRagAdminPage());
});

app.listen(PORT, () => {
    console.log('=======================================================');
    console.log(` 外接热梗 RAG 库已启动: http://localhost:${PORT}/rag`);
    console.log(` 向量库文件: ${store.dbPath}`);
    console.log(' exe 默认会调用该外接库；如需改地址设置 MEME_RAG_BASE_URL');
    console.log('=======================================================');
});

async function parseMemeText(payload) {
    const sourceText = [
        String(payload.text || '').trim(),
        extractUploadedDocumentText(payload)
    ].filter(Boolean).join('\n\n').trim();
    if (!sourceText) return { memes: [] };

    try {
        return await parseWithAi(sourceText);
    } catch (error) {
        return parseWithRules(sourceText);
    }
}

async function parseWithAi(sourceText) {
    const prompt = [
        '你是直播热梗库整理助手。请从用户提供的文本或文档内容里提取适合直播场控使用的热梗。',
        '只输出 JSON，不要 Markdown，不要思考过程。',
        '每个梗包含 content, aliases, description, tags。',
        '规则：',
        '1. content 是主梗原句，2-16 字优先。',
        '2. aliases 是别名/相似说法数组，最多 8 个。',
        '3. description 用 1-2 句解释来源、含义和直播间怎么接。',
        '4. tags 最多 6 个，比如 电竞、抽象、夸夸、控场、热梗。',
        '5. 去掉纯广告、辱骂、隐私、人身攻击和不可直接使用的内容。',
        '6. 最多返回 40 条。',
        '',
        `文本：${sourceText.slice(0, 16000)}`,
        '',
        '输出示例：{"memes":[{"content":"主梗原句","aliases":["相似说法","别名"],"description":"用 1-2 句说明这个梗的来源、含义和直播间接法。","tags":["热梗","调侃"]}]}'
    ].join('\n');
    const response = await fetch(`${AI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${AI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: AI_MODEL,
            messages: [
                { role: 'system', content: '你是直播热梗库整理助手。只输出 JSON。' },
                { role: 'user', content: prompt }
            ],
            stream: false,
            enable_thinking: false,
            response_format: { type: 'json_object' },
            temperature: 0.45,
            max_tokens: 1500
        })
    });
    if (!response.ok) {
        throw new Error(`AI HTTP ${response.status}`);
    }
    const json = await response.json();
    const content = json.choices && json.choices[0] && json.choices[0].message
        ? json.choices[0].message.content || ''
        : '';
    const parsed = parseJsonObject(content);
    const memes = Array.isArray(parsed.memes) ? parsed.memes : [];
    return {
        memes: memes.map(normalizeParsedMeme).filter(Boolean)
    };
}

function parseWithRules(sourceText) {
    const seen = new Set();
    const memes = sourceText.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && line.length <= 160)
        .slice(0, 100)
        .map((line) => {
            const parts = line.split(/[：:|｜-]/).map((part) => part.trim()).filter(Boolean);
            const content = cleanField(parts[0] || line).slice(0, 24);
            if (!content || seen.has(content)) return null;
            seen.add(content);
            return {
                content,
                aliases: [],
                description: parts.slice(1).join('，').slice(0, 180) || `从外接库导入文档中识别出的热梗候选：“${content}”。`,
                tags: ['外接导入'],
                createdAt: Date.now()
            };
        })
        .filter(Boolean);
    return { memes };
}

function normalizeParsedMeme(item) {
    const content = cleanField(item && item.content);
    if (!content) return null;
    return {
        content,
        aliases: Array.isArray(item.aliases) ? item.aliases.map(cleanField).filter(Boolean).slice(0, 8) : [],
        description: String(item.description || '').replace(/\s+/g, ' ').trim().slice(0, 220),
        tags: Array.isArray(item.tags) ? item.tags.map(cleanField).filter(Boolean).slice(0, 6) : [],
        createdAt: Date.now()
    };
}

function extractUploadedDocumentText(payload) {
    const fileName = String(payload.fileName || '').toLowerCase();
    const fileBase64 = String(payload.fileBase64 || '');
    if (!fileBase64) return '';
    const buffer = Buffer.from(fileBase64, 'base64');
    if (fileName.endsWith('.docx')) return extractDocxText(buffer);
    return buffer.toString('utf8');
}

function extractDocxText(buffer) {
    const entry = readZipEntry(buffer, 'word/document.xml');
    if (!entry) return '';
    return entry.toString('utf8')
        .replace(/<w:tab\/>/g, ' ')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function readZipEntry(buffer, wantedName) {
    const eocdOffset = findZipEocd(buffer);
    if (eocdOffset < 0) return null;
    const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
    let offset = centralOffset;
    while (offset + 46 <= buffer.length && buffer.readUInt32LE(offset) === 0x02014b50) {
        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
        if (name === wantedName) {
            const localNameLength = buffer.readUInt16LE(localOffset + 26);
            const localExtraLength = buffer.readUInt16LE(localOffset + 28);
            const dataStart = localOffset + 30 + localNameLength + localExtraLength;
            const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
            if (method === 0) return compressed;
            if (method === 8) return zlib.inflateRawSync(compressed);
            return null;
        }
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return null;
}

function findZipEocd(buffer) {
    const min = Math.max(0, buffer.length - 0xffff - 22);
    for (let index = buffer.length - 22; index >= min; index -= 1) {
        if (buffer.readUInt32LE(index) === 0x06054b50) return index;
    }
    return -1;
}

function parseJsonObject(content) {
    const text = String(content || '').trim();
    try {
        return JSON.parse(text);
    } catch (error) {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
        throw error;
    }
}

function cleanField(value) {
    return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/[<>]/g, '').trim().slice(0, 100);
}
