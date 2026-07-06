const https = require('https');

// 规则库：根据不同的氛围与热梗，匹配高质量的本地话术（作为大模型未配置或调用失败时的兜底）
const LOCAL_TEMPLATES = {
    "冷清": {
        reply: "兄弟们，今天弹幕有点冷清啊，是主播操作不够下饭吗？",
        interaction: "在的兄弟扣个 1，我们来聊聊下把玩什么英雄。",
        cooldown: "大家多敲敲弹幕，给主播点点关注和赞，热度搞起来！",
        moderation: "当前房间比较冷清，建议主播主动抛出互动问题，拉拉人气。"
    },
    "失误": {
        reply: "这波确实下饭，但兄弟们别急，这只是给你们加个菜，好戏在后头！",
        interaction: "发起投票：‘主播下一波能不能稳住？’（能翻盘 / 继续下饭 / 先相信一手）",
        cooldown: "键盘刚才有它自己的想法，我怀疑是系统出 BUG 了，兄弟们信我！",
        moderation: "当前弹幕围绕主播失误玩梗，氛围良好。建议主播用自嘲方式幽默回应，发起轻度互动。"
    },
    "高光": {
        reply: "低调低调！这波细节操作，兄弟们觉得帅不帅？觉得帅的把 666 刷起来！",
        interaction: "感谢大家的 666！这波操作值不值得大家点个关注办张卡？",
        cooldown: "常规操作，大家坐下，这只是基本功，下波给你们展示更秀的！",
        moderation: "直播间正在刷屏高光弹幕，热度高涨！建议口头感谢观众，引导一波关注或礼物订阅。"
    },
    "带节奏": {
        reply: "大家别急，游戏嘛，有输有赢很正常，我们下把好好打回来就是了。",
        interaction: "房管注意一下，帮我把一直刷屏带节奏的几个 ID 禁言处理，大家理性讨论。",
        cooldown: "希望大家多给主播一点包容，多看操作，少点戾气。感谢支持！",
        moderation: "检测到负面情绪弹幕正在上升，有带节奏风险。建议主播冷静应对，切勿与弹幕对线，由房管协助禁言。"
    },
    "默认": {
        reply: "感谢大家来到直播间！喜欢主播的点点关注不迷路！",
        interaction: "大家有什么想看的玩法可以在弹幕里发出来，主播带你们飞！",
        cooldown: "感谢大家的弹幕互动，我们认真操作这一把！",
        moderation: "直播间状态稳定，可继续保持正常开播状态。"
    }
};

/**
 * 智能话术与素材生成模块
 */
class LLMService {
    constructor() {
        this.apiKey = process.env.GEMINI_API_KEY || "";
    }

    // 根据当前的分析结果生成针对性建议（核心接口）
    async generateSuggestions(analysis) {
        const { roomMood, tempo, riskScore, topMemes } = analysis;
        
        // 1. 判断当前的场景类型
        let category = "默认";
        if (riskScore > 40) {
            category = "带节奏";
        } else if (topMemes.some(m => ["下饭", "菜", "送", "下播", "寄"].some(k => m.name.includes(k)))) {
            category = "失误";
        } else if (topMemes.some(m => ["666", "秀", "牛", "名场面", "帅"].some(k => m.name.includes(k)))) {
            category = "高光";
        } else if (roomMood === "冷清" || tempo === "冷场预警") {
            category = "冷清";
        }

        // 2. 尝试调用 Gemini 大模型生成更具灵性的话术
        if (this.apiKey) {
            try {
                const prompt = this.buildPrompt(analysis, category);
                const aiResult = await this.callGemini(prompt);
                if (aiResult && aiResult.reply) {
                    return aiResult;
                }
            } catch (e) {
                console.error("Gemini API call failed, falling back to local templates:", e.message);
            }
        }

        // 3. 大模型未配置或失败时，使用高品质本地模板返回
        const template = LOCAL_TEMPLATES[category];
        return {
            reply: template.reply,
            interaction: template.interaction,
            cooldown: template.cooldown,
            moderation: template.moderation
        };
    }

    // 生成互动玩法 (API POST /api/agent/interaction)
    async generateInteraction(meme, mood, scene) {
        if (this.apiKey) {
            try {
                const prompt = `你是一个虎牙直播场控助手。当前房间正在玩梗："${meme}"，房间情绪："${mood}"，场景："${scene}"。\n` +
                               `请生成一个好玩的投票或抽奖等轻互动玩法。返回 JSON 格式，必须包含且仅包含以下四个字段，不要包含 Markdown 标记：\n` +
                               `{\n` +
                               `  "type": "poll",\n` +
                               `  "title": "投票标题",\n` +
                               `  "options": ["选项1", "选项2", "选项3"],\n` +
                               `  "hostLine": "主播引导话术"\n` +
                               `}`;
                const result = await this.callGemini(prompt);
                if (result && result.title) return result;
            } catch (e) {
                console.error("Gemini interaction generate failed:", e.message);
            }
        }

        // 本地兜底
        return {
            type: "poll",
            title: meme === "下饭" ? "主播下一波能不能稳住？" : "这波操作打几分？",
            options: meme === "下饭" ? ["能翻盘", "继续下饭", "先相信一手"] : ["10分拉满", "下半生回味", "有手就行"],
            hostLine: meme === "下饭" ? "来兄弟们投一票，看你们还相不相信我！" : "兄弟们觉得我这波能打几分？来投个票！"
        };
    }

    // 生成切片素材 (API POST /api/agent/clip-copy)
    async generateClipCopy(analysis) {
        const topMeme = analysis.topMemes && analysis.topMemes[0] ? analysis.topMemes[0].name : "精彩瞬间";
        
        if (this.apiKey) {
            try {
                const prompt = `你是一个虎牙直播运营助手。请根据当前的房间分析数据，生成短视频切片素材：\n` +
                               `热梗：${topMeme}，房间氛围：${analysis.roomMood}，节奏：${analysis.tempo}。\n` +
                               `请返回 JSON 格式，必须包含且仅包含以下三个字段，不要包含 Markdown 标记：\n` +
                               `{\n` +
                               `  "title": "短视频标题（吸引人、有网感）",\n` +
                               `  "coverText": "封面大字文案（简洁震撼）",\n` +
                               `  "description": "切片简介（100字以内说明名场面）"\n` +
                               `}`;
                const result = await this.callGemini(prompt);
                if (result && result.title) return result;
            } catch (e) {
                console.error("Gemini clip-copy generate failed:", e.message);
            }
        }

        // 本地兜底
        if (topMeme === "下饭") {
            return {
                title: "全直播间都在刷下饭，主播下一秒直接极限翻盘证明自己！",
                coverText: "刚被弹幕嘲笑，反手极限反杀",
                description: "主播在游戏失误后弹幕疯狂玩梗刷屏，没想到主播反手打出一波极限操作逆风翻盘！"
            };
        }
        return {
            title: `国服第一现场证明！这波极限操作看呆了全直播间！`,
            coverText: "细节拉满！名场面诞生",
            description: `直播间瞬间爆发 ${topMeme} 热梗，主播展示超凡细节，直接将现场气氛推向高潮！`
        };
    }

    buildPrompt(analysis, category) {
        const topMemesStr = analysis.topMemes.map(m => `${m.name}(热度:${m.heat})`).join(", ");
        return `你是一个虎牙直播的“AI 场控副驾”。你的任务是辅助游戏主播进行接梗、互动和降温控场。\n` +
               `当前直播间状态：\n` +
               `- 情绪氛围：${analysis.roomMood}\n` +
               `- 直播节奏：${analysis.tempo}\n` +
               `- 热度分数：${analysis.heatScore} (0-100)\n` +
               `- 风险分数：${analysis.riskScore} (0-100)\n` +
               `- 正在上涨的梗：${topMemesStr || "暂无"}\n` +
               `- 场景分类：${category}\n\n` +
               `请针对这个状态，为游戏主播生成话术和场控建议。要求话术口语化、接地气、有网感，并且简短易读（方便主播扫一眼就能读出来）。\n` +
               `返回 JSON 格式，必须包含且仅包含以下四个字段，不要包含 Markdown 标记（不要用 \`\`\`json 开头）：\n` +
               `{\n` +
               `  "reply": "主播自嘲或回应弹幕接梗的口头话术",\n` +
               `  "interaction": "主播用来引导观众发弹幕/扣字/参与互动的口头话术",\n` +
               `  "cooldown": "主播用来安抚观众、降温控场或缓解失误尴尬的口头话术",\n` +
               `  "moderation": "写给房管或系统助手的策略建议（如：当前情绪稳定建议放大调侃氛围 / 出现引战建议房管禁言等）"\n` +
               `}`;
    }

    callGemini(prompt) {
        return new Promise((resolve, reject) => {
            const postData = JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    responseMimeType: "application/json"
                }
            });

            const options = {
                hostname: 'generativelanguage.googleapis.com',
                port: 443,
                path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${this.apiKey}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            const req = https.request(options, (res) => {
                let body = "";
                res.on('data', (chunk) => body += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(body);
                        if (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts[0]) {
                            const text = json.candidates[0].content.parts[0].text;
                            resolve(JSON.parse(text));
                        } else {
                            reject(new Error("Invalid API response format: " + body));
                        }
                    } catch (err) {
                        reject(err);
                    }
                });
            });

            req.on('error', (e) => reject(e));
            req.write(postData);
            req.end();
        });
    }
}

module.exports = new LLMService();
