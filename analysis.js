const MEME_DICT = {
    "失误调侃梗": ["下饭", "菜", "别送了", "下播", "又寄了", "送人头", "吃饱了", "厨师", "下厨", "键盘动了"],
    "高光赞赏梗": ["666", "秀", "牛逼", "名场面", "细节", "帅", "强", "起飞", "装到了", "稳住"],
    "节奏风险梗": ["退钱", "演员", "封号", "举报", "垃圾", "傻逼", "废物", "滚", "别播了", "下课"]
};

const TOXIC_KEYWORDS = ["垃圾", "傻逼", "废物", "滚", "演员", "退钱", "别播了", "死人", "孤儿", "下马"];

class AnalysisEngine {
    constructor() {
        this.messages = []; // 储存最近60秒内的弹幕
        this.giftCount = 0; // 最近窗口的礼物数
        this.windowSizeMs = 30000; // 分析时间窗，默认30秒
    }

    addMessage(msg) {
        this.messages.push({
            id: msg.id || Math.random().toString(36).substr(2, 9),
            nickname: msg.nickname || "未知用户",
            userId: msg.userId || "0",
            content: msg.content || "",
            timestamp: msg.timestamp || Date.now(),
            level: msg.level || 1
        });
        this.cleanOldMessages();
    }

    addGift(gift) {
        this.giftCount += gift.count || 1;
    }

    cleanOldMessages() {
        const now = Date.now();
        // 保留最近 60 秒的数据，用于滑动计算
        this.messages = this.messages.filter(m => now - m.timestamp < 60000);
    }

    // 简单中文分词匹配，提取高频词和变体
    extractKeywords(messages) {
        const wordCounts = {};
        messages.forEach(m => {
            const content = m.content.trim();
            if (!content) return;

            // 1. 精确匹配常用游戏梗/词汇
            Object.values(MEME_DICT).flat().forEach(meme => {
                if (content.includes(meme)) {
                    wordCounts[meme] = (wordCounts[meme] || 0) + 1;
                }
            });

            // 2. 长句子的简单2-4字切片（粗分词）
            if (content.length >= 2) {
                for (let len = 2; len <= Math.min(4, content.length); len++) {
                    for (let i = 0; i <= content.length - len; i++) {
                        const sub = content.substr(i, len);
                        // 过滤全是标点或数字的词
                        if (/^[\d\s\p{P}]+$/u.test(sub)) continue;
                        // 排除单字重复（如“一一一一”），除非是“666”等
                        if (sub.split('').every(c => c === sub[0]) && sub[0] !== '6' && sub[0] !== '8') continue;
                        
                        wordCounts[sub] = (wordCounts[sub] || 0) + 0.5; // 权重降低，防噪声
                    }
                }
            }
        });

        // 整理排序
        return Object.entries(wordCounts)
            .map(([word, count]) => ({ word, count: Math.round(count) }))
            .filter(item => item.count >= 2) // 至少出现2次才算高频
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);
    }

    analyze() {
        this.cleanOldMessages();
        const now = Date.now();

        // 1. 划分最近窗口 (0 ~ 30s) 和前一个窗口 (30s ~ 60s)
        const currentWindow = this.messages.filter(m => now - m.timestamp <= this.windowSizeMs);
        const prevWindow = this.messages.filter(m => {
            const diff = now - m.timestamp;
            return diff > this.windowSizeMs && diff <= this.windowSizeMs * 2;
        });

        const totalMsgs = currentWindow.length;
        const prevMsgs = prevWindow.length;

        // 2. 基础指标计算
        const uniqueUsers = new Set(currentWindow.map(m => m.userId)).size;
        
        // 重复率统计
        let repeatedCount = 0;
        const msgMap = {};
        currentWindow.forEach(m => {
            msgMap[m.content] = (msgMap[m.content] || 0) + 1;
            if (msgMap[m.content] > 1) repeatedCount++;
        });
        const repetitionRate = totalMsgs > 0 ? repeatedCount / totalMsgs : 0;

        // 3. 词频与爆发检测
        const currentKeywords = this.extractKeywords(currentWindow);
        const prevKeywords = this.extractKeywords(prevWindow);
        const prevKeywordsMap = Object.fromEntries(prevKeywords.map(k => [k.word, k.count]));

        const topMemes = currentKeywords.map(item => {
            const prevCount = prevKeywordsMap[item.word] || 0;
            const growth = prevCount === 0 ? item.count : (item.count - prevCount) / prevCount;
            
            // 归类到梗聚类
            let cluster = "其他互动词";
            for (const [key, list] of Object.entries(MEME_DICT)) {
                if (list.some(keyword => item.word.includes(keyword) || keyword.includes(item.word))) {
                    cluster = key;
                    break;
                }
            }

            // 识别生命周期阶段
            let stage = "萌芽";
            if (item.count >= 15 && growth > 1.5) stage = "爆发";
            else if (item.count >= 10) stage = "扩散";
            else if (growth < 0 && item.count < 5) stage = "衰退";

            return {
                name: item.word,
                cluster: cluster,
                heat: Math.min(100, item.count * 4 + Math.round(growth * 10)),
                growth: growth,
                stage: stage
            };
        }).sort((a, b) => b.heat - a.heat).slice(0, 5);

        // 4. 情绪与风险分析
        let negativeCount = 0;
        let positiveCount = 0;
        
        currentWindow.forEach(m => {
            const content = m.content;
            if (TOXIC_KEYWORDS.some(k => content.includes(k))) {
                negativeCount++;
            }
            if (MEME_DICT["高光赞赏梗"].some(k => content.includes(k))) {
                positiveCount++;
            }
        });

        // 5. 热度分数计算
        // heat = frequencyScore * 0.35 + growthScore * 0.30 + userSpreadScore * 0.20 + emotionScore * 0.10 + giftBoostScore * 0.05
        const frequencyScore = Math.min(100, (totalMsgs / (this.windowSizeMs / 1000)) * 20); // 弹幕密度，每秒5条为100分
        const growthScore = prevMsgs === 0 ? (totalMsgs > 0 ? 50 : 0) : Math.min(100, Math.max(0, ((totalMsgs - prevMsgs) / prevMsgs) * 50 + 50));
        const userSpreadScore = totalMsgs > 0 ? (uniqueUsers / totalMsgs) * 100 : 0;
        const emotionScore = Math.min(100, positiveCount * 10);
        const giftBoostScore = Math.min(100, this.giftCount * 10);

        const heatScore = Math.round(
            frequencyScore * 0.35 +
            growthScore * 0.30 +
            userSpreadScore * 0.20 +
            emotionScore * 0.10 +
            giftBoostScore * 0.05
        );

        // 6. 风险分数计算
        // risk = toxicKeywordScore * 0.40 + repetitionScore * 0.25 + negativeEmotionScore * 0.25 + conflictScore * 0.10
        const toxicKeywordScore = Math.min(100, negativeCount * 20);
        const repetitionScoreVal = repetitionRate * 100;
        const negativeEmotionScore = Math.min(100, negativeCount * 15);
        const conflictScore = Math.min(100, (negativeCount > 2 && repetitionRate > 0.4) ? 80 : 0);

        const riskScore = Math.round(
            toxicKeywordScore * 0.40 +
            repetitionScoreVal * 0.25 +
            negativeEmotionScore * 0.25 +
            conflictScore * 0.10
        );

        // 重置礼物计数
        this.giftCount = 0;

        // 判断大体节奏和情绪标签
        let roomMood = "平静";
        let tempo = "状态稳定";

        if (riskScore > 50) {
            roomMood = "带节奏/冲突";
            tempo = "需要控场";
        } else if (positiveCount > prevMsgs && positiveCount > 3) {
            roomMood = "激动/欢乐";
            tempo = "爆点出现";
        } else if (totalMsgs > prevMsgs * 1.5 && totalMsgs > 5) {
            roomMood = "调侃";
            tempo = "梗在发酵";
        } else if (totalMsgs < 3) {
            roomMood = "冷清";
            tempo = "冷场预警";
        }

        return {
            roomMood,
            tempo,
            heatScore,
            riskScore,
            topMemes,
            metrics: {
                totalMsgs,
                uniqueUsers,
                repetitionRate,
                negativeCount
            }
        };
    }
}

module.exports = AnalysisEngine;
