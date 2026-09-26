// ===== 默认配置（推荐用环境变量，也可直接在此填写）=====
const DEFAULTS = {
    // 机场签到
    DOMAIN: "",            // 机场域名，如 xxx.com
    USERNAME: "",          // 机场账户邮箱
    PASSWORD: "",          // 机场账户密码
    TOKEN: "",             // 手动触发签到的 URL 路径，如 auto
    TG_TOKEN: "",          // Telegram 机器人 token
    TG_ID: "",             // Telegram 接收者 ID
    TG_API: "",            // Telegram API 地址，默认 https://api.telegram.org（测试用）
    // WorkBuddy 签到
    WB_TOKEN: "",          // WorkBuddy 登录令牌 accessToken（CodeBuddy CLI 凭据文件里的明文）
    WB_UID: "",            // WorkBuddy 用户 ID uid
    WB_ENTERPRISE_ID: "",  // 企业账号的 enterpriseId，个人账号留空
    WB_DOMAIN: "",         // 凭据文件中的 auth.domain，一般留空
    WB_ENDPOINT: "",       // 服务端地址，默认 https://copilot.tencent.com
};

const WB_DEFAULT_ENDPOINT = "https://copilot.tencent.com";
const WB_STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
const WB_CLAIM_PATH = "/v2/billing/meter/daily-checkin";
const TG_DEFAULT_API = "https://api.telegram.org";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

let domain, username, password, token, botToken, chatId, tgApi;
let wbToken, wbUid, wbEnterpriseId, wbDomain, wbEndpoint;

let checkInResult;
let fetch = globalThis.fetch;
let Response = globalThis.Response;

const isNode = typeof process !== "undefined" && !!(process.versions && process.versions.node);

// 只有用 `node _worker.js` 直接运行时才执行定时任务；被测试 import 时不执行
function isMainModule() {
    if (!isNode || !process.argv[1]) return false;
    const self = decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
    const main = process.argv[1].replace(/\\/g, "/");
    return self === main;
}

if (isMainModule()) {
    runInNode().catch(error => console.error("Node.js 环境执行失败:", error));
} else if (!isNode) {
    console.log("在 Cloudflare Worker 环境中，已使用内置 fetch");
}

async function runInNode() {
    if (typeof fetch === "undefined") {
        const module = await import('node-fetch');
        fetch = module.default;
        Response = module.Response;
        console.log("在 Node.js 环境中，已导入 node-fetch");
    } else {
        console.log("在 Node.js 环境中，已使用内置 fetch");
    }
    const env = {};
    for (const key of Object.keys(DEFAULTS)) env[key] = process.env[key];
    await runScheduled(env);
}

async function runScheduled(env) {
    console.log("定时任务开始");
    try {
        await initConfig(env);
        await handleCheckIn();
        console.log("定时任务成功完成");
    } catch (error) {
        console.error("定时任务失败:", error);
        await sendMessage(`定时任务失败: ${error.message}`);
    }
}

export default {
    async fetch(request, env) {
        await initConfig(env);
        const url = new URL(request.url);

        if (url.pathname === "/tg") {
            return await handleTgMsg();
        } else if (token && url.pathname === `/${token}`) {
            return await handleCheckIn();
        }

        return new Response(checkInResult, {
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            status: 200
        });
    },

    async scheduled(controller, env) {
        await runScheduled(env);
    },
};

// ===== 主流程：机场与 WorkBuddy 各自独立执行，结果合并 =====
// 静默规则：所有启用的路都是“今日已签/活动未开启”且没有失败时，不发通知，只写日志。
async function handleCheckIn() {
    const configSummary = checkInResult;
    const airportEnabled = !!(domain && username && password);
    const workbuddyEnabled = !!(wbToken || wbUid);

    if (!airportEnabled && !workbuddyEnabled) {
        const errorMsg = `${configSummary}\n🎁缺少必要的配置参数：请配置机场 DOMAIN/USERNAME/PASSWORD，或 WorkBuddy WB_TOKEN/WB_UID`;
        console.error(errorMsg);
        await sendMessage(errorMsg);
        return new Response(errorMsg, { status: 500 });
    }

    const results = [];
    if (airportEnabled) {
        try {
            results.push({ name: "机场", ...(await airportCheckIn({ domain, username, password })) });
        } catch (error) {
            console.error("机场签到失败:", error);
            results.push({ name: "机场", status: "failed", error: error.message });
        }
    }
    if (workbuddyEnabled) {
        try {
            results.push({ name: "WorkBuddy", ...(await workbuddyCheckIn({ token: wbToken, uid: wbUid, enterpriseId: wbEnterpriseId, domain: wbDomain, endpoint: wbEndpoint })) });
        } catch (error) {
            console.error("WorkBuddy 签到失败:", error);
            results.push({ name: "WorkBuddy", status: "failed", error: error.message });
        }
    }

    const failed = results.some(r => r.status === "failed");
    const silent = !failed && results.every(r => r.status === "already" || r.status === "inactive");
    const report = formatReport(results);

    if (silent) {
        checkInResult = `今日已全部签到，本次静默不发通知\n${report}`;
        console.log(checkInResult);
        return new Response(checkInResult, { status: 200 });
    }

    checkInResult = failed ? `${configSummary}\n${report}` : report;
    await sendMessage(checkInResult);
    return new Response(checkInResult, { status: failed ? 500 : 200 });
}

// ===== 通知文案 =====
export function formatReport(results) {
    const lines = [results.some(r => r.status === "failed") ? "⚠️ 签到结果" : "🎉 签到结果"];
    for (const r of results) {
        if (r.name === "机场") lines.push(formatAirport(r));
        else lines.push(formatWorkbuddy(r));
    }
    return lines.join("\n");
}

function formatAirport(r) {
    if (r.status === "failed") return `❌ 机场签到失败: ${r.error}`;
    const parts = [r.status === "claimed" ? `本次 +${r.gained || "?"}` : "今日已签"];
    if (r.remaining) parts.push(`剩余 ${r.remaining}`);
    if (r.todayUsed) parts.push(`今日已用 ${r.todayUsed}`);
    if (r.expire) parts.push(`${r.expire} 到期`);
    return `🛫 机场：${parts.join(" ｜ ")}`;
}

function formatWorkbuddy(r) {
    if (r.status === "failed") return `❌ WorkBuddy 签到失败: ${r.error}`;
    if (r.status === "inactive") return `🐱 WorkBuddy：签到活动未开启${r.activityName ? `（${r.activityName}）` : ""}`;
    const parts = [];
    if (r.status === "claimed") parts.push(`本次 +${r.credit} 积分`);
    else parts.push(r.todayCredit ? `今日已签 +${r.todayCredit} 积分` : "今日已签");
    if (r.isStreakDay) parts.push("连签奖励日");
    if (r.streakDays != null) parts.push(`连签 ${r.streakDays} 天`);
    if (r.totalCredits != null) parts.push(`签到累计 ${r.totalCredits} 积分`);
    return `🐱 WorkBuddy：${parts.join(" ｜ ")}`;
}

// ===== 机场签到（SSPanel）=====
// 流程：登录 → getuserinfo 判断今天是否已签（已签则不再调签到接口）→ 未签则签到 → gettransfer 取剩余流量
export async function airportCheckIn({ domain, username, password }) {
    const base = formatDomain(domain);
    const cookies = await loginAndGetCookies(base, username, password);
    const headers = {
        "User-Agent": BROWSER_UA,
        "Accept": "application/json, text/plain, */*",
        "Origin": base,
        "Referer": `${base}/user`,
        "Cookie": cookies,
        "X-Requested-With": "XMLHttpRequest",
    };
    const getJson = async (path, init = {}) => {
        const response = await fetch(base + path, { headers, ...init });
        const text = await response.text();
        let body = null;
        try { body = JSON.parse(text); } catch { body = null; }
        return { ok: response.ok, status: response.status, body, text };
    };

    const result = { status: "claimed" };

    // 1. 用户信息：上次签到时间、到期日、流量原始值（接口不可用时静默退化）
    let user = null;
    try {
        const r = await getJson("/getuserinfo");
        if (r.body && r.body.ret === 1 && r.body.info && r.body.info.user) user = r.body.info.user;
    } catch (error) {
        console.log("getuserinfo 不可用，跳过预检查:", error.message);
    }
    if (user) {
        if (isTodayBeijing(Number(user.last_check_in_time))) result.status = "already";
        const expire = parseExpire(user.class_expire);
        if (expire) result.expire = expire;
    }

    // 2. 签到（仅在未签时）
    let trafficInfo = null;
    if (result.status !== "already") {
        const r = await getJson("/user/checkin", { method: "POST", headers: { ...headers, "Content-Type": "application/json" } });
        if (!r.ok) throw new Error(`签到请求失败: ${r.text}`);
        const body = r.body || {};
        if (body.ret === 1) {
            result.status = "claimed";
            const m = String(body.msg || "").match(/([\d.]+\s*[KMGT]?B)/i);
            if (m) result.gained = m[1];
            if (body.trafficInfo) trafficInfo = body.trafficInfo;
        } else if (/已经签到|已签到/.test(String(body.msg || ""))) {
            result.status = "already";
        } else {
            throw new Error(`签到失败: ${body.msg || "未知错误"}`);
        }
    }

    // 3. 剩余流量：gettransfer → 签到返回的 trafficInfo → 用 getuserinfo 字节数换算
    let transfer = null;
    try {
        const r = await getJson("/gettransfer");
        if (r.body && r.body.ret === 1 && r.body.arr) transfer = r.body.arr;
    } catch (error) {
        console.log("gettransfer 不可用:", error.message);
    }
    const info = transfer || trafficInfo;
    if (info && info.unUsedTraffic) {
        result.remaining = info.unUsedTraffic;
        if (info.todayUsedTraffic) result.todayUsed = info.todayUsedTraffic;
    } else if (user && user.transfer_enable != null) {
        const left = Number(user.transfer_enable) - Number(user.u || 0) - Number(user.d || 0);
        if (Number.isFinite(left)) result.remaining = formatBytes(left);
    }
    return result;
}

async function loginAndGetCookies(base, username, password) {
    const response = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "User-Agent": BROWSER_UA,
            "Accept": "application/json, text/plain, */*",
            "Origin": base,
            "Referer": `${base}/auth/login`
        },
        body: JSON.stringify({ email: username, passwd: password, remember_me: "on", code: "" }),
    });

    if (!response.ok) {
        throw new Error(`登录失败: ${await response.text()}`);
    }

    const jsonResponse = await response.json();
    if (jsonResponse.ret !== 1) {
        throw new Error(`登录失败: ${jsonResponse.msg || "未知错误"}`);
    }

    const cookieHeader = response.headers.get("set-cookie");
    if (!cookieHeader) {
        throw new Error("登录成功但未收到 Cookies");
    }

    return cookieHeader.split(',').map(cookie => cookie.split(';')[0]).join("; ");
}

// 机场服务器按北京时间算“今天”
function isTodayBeijing(unixSeconds) {
    if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return false;
    const day = (ms) => Math.floor((ms + 8 * 3600 * 1000) / 86400000);
    return day(unixSeconds * 1000) === day(Date.now());
}

function parseExpire(value) {
    const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m || Number(m[1]) < 2000) return undefined;
    return `${m[1]}-${m[2]}-${m[3]}`;
}

function formatBytes(bytes) {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = Math.max(0, bytes);
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return `${value.toFixed(i === 0 ? 0 : 2)}${units[i]}`;
}

// ===== WorkBuddy 签到 =====
// 接口来自桌面端逆向（参考 https://github.com/88lin/workbuddy-auto-signin）：
// 先查签到状态，未签才领取；领取后再查一次状态用于汇报连签天数。
export async function workbuddyCheckIn({ token, uid, enterpriseId, domain, endpoint }) {
    if (!token) throw new Error("缺少 WB_TOKEN（WorkBuddy 登录令牌）");
    if (!uid) throw new Error("缺少 WB_UID（WorkBuddy 用户 ID）");

    const base = (endpoint || WB_DEFAULT_ENDPOINT).replace(/\/+$/, "");
    const headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "X-User-Id": String(uid),
        "User-Agent": "WorkBuddy"
    };
    if (enterpriseId) {
        headers["X-Enterprise-Id"] = String(enterpriseId);
        headers["X-Tenant-Id"] = String(enterpriseId);
    }
    if (domain) {
        headers["X-Domain"] = domain;
    }

    const post = async (path) => {
        const response = await fetch(base + path, { method: "POST", headers, body: "{}" });
        const text = await response.text();
        let body = {};
        try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
        if (response.status === 401) {
            throw new Error("令牌已失效（HTTP 401），请重新登录 WorkBuddy 客户端并更新 WB_TOKEN");
        }
        if (response.status === 403) {
            throw new Error(`服务端拒绝（HTTP 403）：${body.message || body.msg || text || "请检查账号权限或活动条件"}`);
        }
        // 领取时服务端可能用 HTTP 400 + code 10001 表示"今天已签到"，这是幂等结果而不是错误
        if (response.status === 400 && Number(body.code) === 10001) {
            return { already_checked_in: true };
        }
        if (!response.ok) {
            throw new Error(`接口异常（HTTP ${response.status}）：${text.slice(0, 200)}`);
        }
        return body;
    };

    // 部分返回会包在 data 字段里，统一取一层
    const unwrap = (body) => (body && typeof body.data === "object" && body.data !== null) ? body.data : (body || {});
    const isChecked = (s) => s.today_checked_in === true || s.today_checked_in === 1;
    const summarize = (s) => ({
        streakDays: s.streak_days != null ? s.streak_days : undefined,
        totalCredits: s.total_credits != null ? s.total_credits : undefined,
        isStreakDay: !!s.is_streak_day,
        todayCredit: s.today_credit != null ? s.today_credit : (s.daily_credit != null ? s.daily_credit : undefined),
        activityName: s.activity_name || undefined,
    });

    const status = unwrap(await post(WB_STATUS_PATH));
    if (status.active === false) {
        return { status: "inactive", ...summarize(status) };
    }
    if (isChecked(status)) {
        return { status: "already", ...summarize(status) };
    }

    const claim = unwrap(await post(WB_CLAIM_PATH));
    const fresh = unwrap(await post(WB_STATUS_PATH).catch(() => status));

    if (claim.already_checked_in) {
        return { status: "already", ...summarize(fresh) };
    }
    if (claim.credit != null) {
        return { status: "claimed", credit: claim.credit, ...summarize(fresh) };
    }
    if (isChecked(fresh)) {
        return { status: "already", ...summarize(fresh) };
    }
    throw new Error(`领取结果无法识别：${JSON.stringify(claim).slice(0, 200)}`);
}

// ===== Telegram =====
async function sendMessage(msg) {
    if (!botToken || !chatId) {  
        console.log("Telegram 推送未启用. 消息内容:", msg);
        return;
    }

    const now = new Date();
    const formattedTime = new Date(now.getTime() + 8 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ");
    
    const message = `执行时间: ${formattedTime}\n${msg}`;
    const tgUrl = `${tgApi}/bot${botToken}/sendMessage?chat_id=${chatId}&parse_mode=HTML&text=${encodeURIComponent(message)}`;

    try {
        const response = await fetch(tgUrl, { method: "GET", headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
        
        if (!response.ok) {
             return "Telegram 消息发送失败: "  + await response.text(); 
        }
        const jsonResponse = await response.text(); 
        console.log("Telegram 消息发送成功:", jsonResponse);
        return message;
    } catch (error) {
        console.error("发送 Telegram 消息失败:", error);
        return `发送 Telegram 消息失败: ${error.message}`; 
    }
}

async function handleTgMsg() {
    const message = `${checkInResult}`;
    const sendResult = await sendMessage(message);
    return new Response(sendResult, { status: 200 });
}

// ===== 配置 =====
function formatDomain(domain) {
    if (!domain) return "";
    return (domain.includes("//") ? domain : `https://${domain}`).replace(/\/+$/, "");
}

function maskSensitiveData(str, type = 'default') {
    if (!str) return "N/A";

   const urlPattern = /^(https?:\/\/)([^\/]+)(.*)$/;
    if (type === 'url' && urlPattern.test(str)) {
        return str.replace(/(https:\/\/)(\w)(\w+)(\w)(\.\w+)/, '$1$2****$4$5');;
    }

    const emailPattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (type === 'email' && emailPattern.test(str)) {
        return str.replace(/^(\w)(\w+)(\@)(\w)(\w+)(\.\w+)$/, '$1****$3$4****$6');
    }

    return `${str[0]}****${str[str.length - 1]}`;
}

// 从 JSON 里复制的值常带引号、逗号或换行，这里统一清掉
function cleanCredential(value) {
    return String(value == null ? "" : value).trim().replace(/^["'\s]+|["',\s]+$/g, "");
}

function describeToken(tok) {
    if (!tok) return "未配置";
    const looksJwt = tok.startsWith("eyJ") && tok.split(".").length === 3;
    return `长度 ${tok.length}，${looksJwt ? "格式正常" : "格式异常（应以 eyJ 开头且含两个点）"}`;
}

async function initConfig(env) {
    env = env || {};
    const get = (key) => env[key] || DEFAULTS[key];
    domain = formatDomain(get("DOMAIN"));
    username = get("USERNAME");
    password = get("PASSWORD");
    token = get("TOKEN");
    botToken = get("TG_TOKEN");
    chatId = get("TG_ID");
    tgApi = (get("TG_API") || TG_DEFAULT_API).replace(/\/+$/, "");
    wbToken = cleanCredential(get("WB_TOKEN"));
    wbUid = cleanCredential(get("WB_UID"));
    wbEnterpriseId = cleanCredential(get("WB_ENTERPRISE_ID"));
    wbDomain = cleanCredential(get("WB_DOMAIN"));
    wbEndpoint = cleanCredential(get("WB_ENDPOINT"));

    checkInResult = `配置信息: 
    登录地址: ${maskSensitiveData(domain, 'url')} 
    登录账号: ${maskSensitiveData(username, 'email')} 
    登录密码: ${maskSensitiveData(password)} 
    WorkBuddy 签到: ${wbToken && wbUid ? `已启用 (uid ${maskSensitiveData(wbUid)}，WB_TOKEN ${describeToken(wbToken)})` : "未启用"} 
    TG 推送:  ${botToken && chatId ? "已启用" : "未启用"} `;
}
