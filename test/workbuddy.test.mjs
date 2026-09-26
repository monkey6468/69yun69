import test from "node:test";
import assert from "node:assert/strict";
import { workbuddyCheckIn } from "../_worker.js";
import { startServer } from "./helpers.mjs";

const STATUS = "/v2/billing/meter/checkin-activity-status";
const CLAIM = "/v2/billing/meter/daily-checkin";
const baseCfg = { token: "tok123", uid: "uid456" };

test("未签到时领取积分并返回连签天数", async () => {
  let claimed = false;
  const srv = await startServer((path) => {
    if (path === STATUS) return { status: 200, body: { active: true, today_checked_in: claimed, streak_days: claimed ? 3 : 2, total_credits: claimed ? 450 : 300 } };
    if (path === CLAIM) { claimed = true; return { status: 200, body: { credit: 150 } }; }
  });
  try {
    const r = await workbuddyCheckIn({ ...baseCfg, endpoint: srv.url });
    assert.equal(r.status, "claimed");
    assert.equal(r.credit, 150);
    assert.equal(r.streakDays, 3);
    assert.equal(r.totalCredits, 450);
    assert.deepEqual(srv.paths(), [STATUS, CLAIM, STATUS]);
  } finally { await srv.close(); }
});

test("请求头携带 Bearer 令牌和用户 ID", async () => {
  const srv = await startServer(() => ({ status: 200, body: { active: true, today_checked_in: true, streak_days: 1, total_credits: 150 } }));
  try {
    await workbuddyCheckIn({ ...baseCfg, enterpriseId: "ent789", endpoint: srv.url });
    const h = srv.calls[0].headers;
    assert.equal(h.authorization, "Bearer tok123");
    assert.equal(h["x-user-id"], "uid456");
    assert.equal(h["x-enterprise-id"], "ent789");
    assert.equal(h["x-tenant-id"], "ent789");
    assert.equal(srv.calls[0].method, "POST");
  } finally { await srv.close(); }
});

test("今日已签到则不再重复领取", async () => {
  const srv = await startServer(() => ({ status: 200, body: { data: { active: true, today_checked_in: true, today_credit: 100, streak_days: 5, total_credits: 750 } } }));
  try {
    const r = await workbuddyCheckIn({ ...baseCfg, endpoint: srv.url });
    assert.equal(r.status, "already");
    assert.equal(r.todayCredit, 100);
    assert.equal(r.streakDays, 5);
    assert.deepEqual(srv.paths(), [STATUS]);
  } finally { await srv.close(); }
});

test("签到活动未开启时返回 inactive", async () => {
  const srv = await startServer(() => ({ status: 200, body: { active: false, activity_name: "签到季" } }));
  try {
    const r = await workbuddyCheckIn({ ...baseCfg, endpoint: srv.url });
    assert.equal(r.status, "inactive");
    assert.equal(r.activityName, "签到季");
    assert.deepEqual(srv.paths(), [STATUS]);
  } finally { await srv.close(); }
});

test("令牌失效时抛出明确错误", async () => {
  const srv = await startServer(() => ({ status: 401, body: { message: "unauthorized" } }));
  try {
    await assert.rejects(() => workbuddyCheckIn({ ...baseCfg, endpoint: srv.url }), /令牌已失效/);
  } finally { await srv.close(); }
});

test("缺少令牌或用户 ID 时抛出配置错误", async () => {
  await assert.rejects(() => workbuddyCheckIn({ token: "", uid: "u" }), /WB_TOKEN/);
  await assert.rejects(() => workbuddyCheckIn({ token: "t", uid: "" }), /WB_UID/);
});

test("领取时服务端以 HTTP 400 code 10001 表示今日已签，按已签处理", async () => {
  const srv = await startServer((path) => {
    if (path === STATUS) return { status: 200, body: { code: 0, data: { active: true, today_checked_in: false, streak_days: 1, total_credits: 100 } } };
    if (path === CLAIM) return { status: 400, body: { code: 10001, msg: "今天已签到，请明天再来" } };
  });
  try {
    const r = await workbuddyCheckIn({ ...baseCfg, endpoint: srv.url });
    assert.equal(r.status, "already");
  } finally { await srv.close(); }
});
