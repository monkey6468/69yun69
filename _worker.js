// ===== 默认配置（推荐用环境变量，也可直接在此填写）=====
const DEFAULTS = {
    // 机场签到
    DOMAIN: "",            // 机场域名，如 xxx.com
    USERNAME: "",          // 机场账户邮箱
    PASSWORD: "",          // 机场账户密码
    TOKEN: "",             // 手动触发签到的 URL 路径，如 auto
    TG_TOKEN: "",          // Telegram 机器人 token
    TG_ID: "",             // Telegram 接收者 ID
    // WorkBuddy 签到
    WB_TOKEN: "",          // WorkBuddy 桌面端登录令牌 accessToken
    WB_UID: "",            // WorkBuddy 用户 ID uid
    WB_ENTERPRISE_ID: "",  // 企业账号的 enterpriseId，个人账号留空
    WB_DOMAIN: "",         // 会话文件中的 auth.domain，一般留空
    WB_ENDPOINT: "",       // 服务端地址，默认 https://copilot.tencent.com
};

let domain, username, password, token, botToken, chatId;
let wbToken, wbUid, wbEnterpriseId, wbDomain, wbEndpoint;

const WB_DEFAULT_ENDPOINT = "https://copilot.tencent.com";
const WB_STATUS_PATH = "/v2/billing/meter/checkin-activity-status";
const WB_CLAIM_PATH = "/v2/billing/meter/daily-checkin";

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
    const env = {
        DOMAIN: process.env.DOMAIN,
        USERNAME: process.env.USERNAME,
        PASSWORD: process.env.PASSWORD,
        TOKEN: process.env.TOKEN,
        TG_TOKEN: process.env.TG_TOKEN,
        TG_ID: process.env.TG_ID,
        WB_TOKEN: process.env.WB_TOKEN,
        WB_UID: process.env.WB_UID,
        WB_ENTERPRISE_ID: process.env.WB_ENTERPRISE_ID,
        WB_DOMAIN: process.env.WB_DOMAIN,
        WB_ENDPOINT: process.env.WB_ENDPOINT
    };
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
        } else if (url.pathname === `/${token}`) {
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

// 机场签到与 WorkBuddy 签到各自独立执行，一个失败不影响另一个；结果合并成一条通知
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
    let failed = false;

    if (airportEnabled) {
        try {
            const cookies = await loginAndGetCookies();
            results.push(await performCheckIn(cookies));
        } catch (error) {
            console.error("机场签到失败:", error);
            failed = true;
            results.push(`❌ 机场签到失败: ${error.message}`);
        }
    }

    if (workbuddyEnabled) {
        try {
            results.push(await workbuddyCheckIn({
                token: wbToken,
                uid: wbUid,
                enterpriseId: wbEnterpriseId,
                domain: wbDomain,
                endpoint: wbEndpoint
            }));
        } catch (error) {
            console.error("WorkBuddy 签到失败:", error);
            failed = true;
            results.push(`❌ WorkBuddy 签到失败: ${error.message}`);
        }
    }

    checkInResult = failed ? `${configSummary}\n${results.join("\n")}` : results.join("\n");
    await sendMessage(checkInResult);
    return new Response(checkInResult, { status: failed ? 500 : 200 });
}

async function loginAndGetCookies() {
    const loginUrl = `${domain}/auth/login`;
    const response = await fetch(loginUrl, {
        method: "POST",
        headers: { 
            "Content-Type": "application/json", 
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36", 
            "Accept": "application/json, text/plain, */*", 
            "Origin": domain, 
            "Referer": `${domain}/auth/login`
        },
        body: JSON.stringify({ email: username , passwd: password, remember_me: "on", code: "" }),  
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

async function performCheckIn(cookies) {
    const checkInUrl = `${domain}/user/checkin`;
    const response = await fetch(checkInUrl, {
        method: "POST",
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Origin': domain,
            'Referer': `${domain}/user/panel`,
            'Cookie': cookies,
            'X-Requested-With': 'XMLHttpRequest'
        },
    });

    if (!response.ok) {
        throw new Error(`签到请求失败: ${await response.text()}`);
    }

    const jsonResponse = await response.json();
    if (!jsonResponse.ret) {
        throw new Error(`签到失败: ${jsonResponse.msg || "未知错误"}`);
    }

    return `🎉 签到结果 🎉\n${jsonResponse.msg || "签到完成"}`;
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
        if (!response.ok) {
            throw new Error(`接口异常（HTTP ${response.status}）：${text.slice(0, 200)}`);
        }
        return body;
    };

    // 部分返回会包在 data 字段里，统一取一层
    const unwrap = (body) => (body && typeof body.data === "object" && body.data !== null) ? body.data : body;

    const status = unwrap(await post(WB_STATUS_PATH));
    const streakOf = (s) => {
        const parts = [];
        if (s.streak_days != null) parts.push(`连续 ${s.streak_days} 天`);
        if (s.total_credits != null) parts.push(`累计 ${s.total_credits} 积分`);
        return parts.length ? `（${parts.join("，")}）` : "";
    };

    if (status.active === false) {
        return `🐱 WorkBuddy：签到活动未开启${status.activity_name ? `（${status.activity_name}）` : ""}`;
    }
    if (status.today_checked_in === true || status.today_checked_in === 1) {
        return `🐱 WorkBuddy：今日已签到${streakOf(status)}`;
    }

    const claim = unwrap(await post(WB_CLAIM_PATH));
    const fresh = unwrap(await post(WB_STATUS_PATH).catch(() => status));

    if (claim.credit != null) {
        const bonus = fresh.is_streak_day ? "，连签奖励日" : "";
        return `🎉 WorkBuddy：成功领取 ${claim.credit} 积分${bonus}${streakOf(fresh)}`;
    }
    if (fresh.today_checked_in === true || fresh.today_checked_in === 1) {
        return `🐱 WorkBuddy：今日已签到${streakOf(fresh)}`;
    }
    throw new Error(`领取结果无法识别：${JSON.stringify(claim).slice(0, 200)}`);
}

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
    const tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${chatId}&parse_mode=HTML&text=${encodeURIComponent(message)}`;

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


function formatDomain(domain) {
    if (!domain) return "";
    return domain.includes("//") ? domain : `https://${domain}`;
}

async function handleTgMsg() {
    const message = `${checkInResult}`;
    const sendResult = await sendMessage(message);
    return new Response(sendResult, { status: 200 });
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

async function initConfig(env) {
    env = env || {};
    const get = (key) => env[key] || DEFAULTS[key];
    domain = formatDomain(get("DOMAIN"));
    username = get("USERNAME");
    password = get("PASSWORD");
    token = get("TOKEN");
    botToken = get("TG_TOKEN");
    chatId = get("TG_ID");
    wbToken = get("WB_TOKEN");
    wbUid = get("WB_UID");
    wbEnterpriseId = get("WB_ENTERPRISE_ID");
    wbDomain = get("WB_DOMAIN");
    wbEndpoint = get("WB_ENDPOINT");

    checkInResult = `配置信息: 
    登录地址: ${maskSensitiveData(domain, 'url')} 
    登录账号: ${maskSensitiveData(username, 'email')} 
    登录密码: ${maskSensitiveData(password)} 
    WorkBuddy 签到: ${wbToken && wbUid ? `已启用 (uid ${maskSensitiveData(wbUid)})` : "未启用"} 
    TG 推送:  ${botToken && chatId ? "已启用" : "未启用"} `;
}
