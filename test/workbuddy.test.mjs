import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { workbuddyCheckIn } from "../_worker.js";

// 起一个假的 WorkBuddy 接口，按脚本控制两个端点的返回
function startFakeServer(script) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ path: req.url, method: req.method, headers: req.headers });
      const reply = script(req.url, calls.length);
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const endpoint = `http://127.0.0.1:${server.address().port}`;
      resolve({ endpoint, calls, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const STATUS = "/v2/billing/meter/checkin-activity-status";
const CLAIM = "/v2/billing/meter/daily-checkin";
const baseCfg = { token: "tok123", uid: "uid456" };

test("未签到时领取积分并汇报连签天数", async () => {
  let claimed = false;
  const srv = await startFakeServer((path) => {
    if (path === STATUS) {
      return { status: 200, body: { active: true, today_checked_in: claimed, streak_days: claimed ? 3 : 2, total_credits: claimed ? 450 : 300 } };
    }
    if (path === CLAIM) {
      claimed = true;
      return { status: 200, body: { credit: 150 } };
    }
    return { status: 404, body: {} };
  });
  try {
    const report = await workbuddyCheckIn({ ...baseCfg, endpoint: srv.endpoint });
    assert.match(report, /成功领取 150 积分/);
    assert.match(report, /连续 3 天/);
    assert.deepEqual(srv.calls.map((c) => c.path), [STATUS, CLAIM, STATUS]);
  } finally {
    await srv.close();
  }
});

test("请求头携带 Bearer 令牌和用户 ID", async () => {
  const srv = await startFakeServer(() => ({ status: 200, body: { active: true, today_checked_in: true, streak_days: 1, total_credits: 150 } }));
  try {
    await workbuddyCheckIn({ ...baseCfg, enterpriseId: "ent789", endpoint: srv.endpoint });
    const h = srv.calls[0].headers;
    assert.equal(h.authorization, "Bearer tok123");
    assert.equal(h["x-user-id"], "uid456");
    assert.equal(h["x-enterprise-id"], "ent789");
    assert.equal(h["x-tenant-id"], "ent789");
    assert.equal(srv.calls[0].method, "POST");
  } finally {
    await srv.close();
  }
});

test("今日已签到则不再重复领取", async () => {
  const srv = await startFakeServer(() => ({ status: 200, body: { active: true, today_checked_in: true, streak_days: 5, total_credits: 750 } }));
  try {
    const report = await workbuddyCheckIn({ ...baseCfg, endpoint: srv.endpoint });
    assert.match(report, /今日已签到/);
    assert.match(report, /连续 5 天/);
    assert.deepEqual(srv.calls.map((c) => c.path), [STATUS]);
  } finally {
    await srv.close();
  }
});

test("签到活动未开启时直接汇报", async () => {
  const srv = await startFakeServer(() => ({ status: 200, body: { active: false, activity_name: "签到季" } }));
  try {
    const report = await workbuddyCheckIn({ ...baseCfg, endpoint: srv.endpoint });
    assert.match(report, /签到活动未开启/);
    assert.deepEqual(srv.calls.map((c) => c.path), [STATUS]);
  } finally {
    await srv.close();
  }
});

test("令牌失效时抛出明确错误", async () => {
  const srv = await startFakeServer(() => ({ status: 401, body: { message: "unauthorized" } }));
  try {
    await assert.rejects(
      () => workbuddyCheckIn({ ...baseCfg, endpoint: srv.endpoint }),
      /令牌已失效/
    );
  } finally {
    await srv.close();
  }
});

test("缺少令牌或用户 ID 时抛出配置错误", async () => {
  await assert.rejects(() => workbuddyCheckIn({ token: "", uid: "u" }), /WB_TOKEN/);
  await assert.rejects(() => workbuddyCheckIn({ token: "t", uid: "" }), /WB_UID/);
});

test("领取时服务端以 HTTP 400 code 10001 表示今日已签，按已签处理", async () => {
  const srv = await startFakeServer((path) => {
    if (path === STATUS) return { status: 200, body: { code: 0, msg: "OK", data: { active: true, today_checked_in: false, streak_days: 1, total_credits: 100 } } };
    if (path === CLAIM) return { status: 400, body: { code: 10001, msg: "今天已签到，请明天再来" } };
    return { status: 404, body: {} };
  });
  try {
    const report = await workbuddyCheckIn({ ...baseCfg, endpoint: srv.endpoint });
    assert.match(report, /今日已签到/);
  } finally {
    await srv.close();
  }
});
