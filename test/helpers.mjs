import http from "node:http";

// 通用假服务器：handler(path, method, body, headers) => { status, body, headers? }
export function startServer(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = req.url.split("?")[0];
      calls.push({ path, method: req.method, headers: req.headers, url: req.url });
      const reply = handler(path, req.method, body, req.headers, req.url) || { status: 404, body: {} };
      res.writeHead(reply.status, { "Content-Type": "application/json", ...(reply.headers || {}) });
      res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        paths: () => calls.map((c) => c.path),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

export const NOW = Math.floor(Date.now() / 1000);
export const TWO_DAYS_AGO = NOW - 2 * 86400;

// 一个“正常”的机场：昨天签过、今天还没签
export function airportHandler(opts = {}) {
  const state = { checkedIn: opts.checkedToday || false };
  return (path, method) => {
    if (path === "/auth/login") return { status: 200, headers: { "Set-Cookie": "sid=abc; Path=/" }, body: { ret: 1, msg: "ok" } };
    if (path === "/getuserinfo") {
      if (opts.userinfo) return opts.userinfo(state);
      return { status: 200, body: { ret: 1, info: { user: { u: 1e9, d: 2e9, transfer_enable: 100e9, last_check_in_time: state.checkedIn ? NOW : TWO_DAYS_AGO, class_expire: "2026-10-30 12:00:00" } } } };
    }
    if (path === "/user/checkin") {
      if (state.checkedIn) return { status: 200, body: { ret: 0, msg: "您似乎已经签到过了..." } };
      state.checkedIn = true;
      return { status: 200, body: { ret: 1, msg: "获得了 100 MB 流量", trafficInfo: { todayUsedTraffic: "1.2GB", lastUsedTraffic: "1.8GB", unUsedTraffic: "97.0GB" } } };
    }
    if (path === "/gettransfer") {
      if (opts.transferFails) return { status: 500, body: "boom" };
      return { status: 200, body: { ret: 1, arr: { todayUsedTraffic: "1.2GB", lastUsedTraffic: "1.8GB", unUsedTraffic: "97.1GB" } } };
    }
    return null;
  };
}

export function workbuddyHandler(opts = {}) {
  const state = { claimed: opts.checkedToday || false };
  return (path) => {
    if (path.endsWith("checkin-activity-status")) {
      return { status: 200, body: { code: 0, data: { active: true, today_checked_in: state.claimed, today_credit: state.claimed ? 100 : 0, streak_days: state.claimed ? 3 : 2, total_credits: state.claimed ? 300 : 200, is_streak_day: false } } };
    }
    if (path.endsWith("daily-checkin")) { state.claimed = true; return { status: 200, body: { code: 0, data: { credit: 100 } } }; }
    return null;
  };
}

export function telegramHandler() {
  return (path) => (/\/bot[^/]+\/sendMessage/.test(path) ? { status: 200, body: { ok: true, result: { message_id: 1 } } } : null);
}
