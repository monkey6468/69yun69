import test from "node:test";
import assert from "node:assert/strict";
import worker from "../_worker.js";
import { startServer, airportHandler, workbuddyHandler, telegramHandler } from "./helpers.mjs";

async function runOnce(env) {
  const res = await worker.fetch(new Request("http://worker.local/auto"), { TOKEN: "auto", ...env });
  return { status: res.status, text: await res.text() };
}

async function setup({ airport = airportHandler(), wb = workbuddyHandler() } = {}) {
  const a = await startServer(airport);
  const w = await startServer(wb);
  const t = await startServer(telegramHandler());
  const env = { DOMAIN: a.url, USERNAME: "a@b.com", PASSWORD: "p", WB_TOKEN: "t", WB_UID: "u", WB_ENDPOINT: w.url, TG_TOKEN: "123:abc", TG_ID: "1", TG_API: t.url };
  return { a, w, t, env, close: async () => { await a.close(); await w.close(); await t.close(); } };
}

test("首次运行：两路都签到，发一条含流量、到期、积分、连签的通知", async () => {
  const s = await setup();
  try {
    const { status, text } = await runOnce(s.env);
    assert.equal(status, 200);
    assert.match(text, /🛫 机场：本次 \+100 MB/);
    assert.match(text, /剩余 97\.1GB/);
    assert.match(text, /2026-10-30 到期/);
    assert.match(text, /🐱 WorkBuddy：本次 \+100 积分/);
    assert.match(text, /连签 3 天/);
    assert.match(text, /签到累计 300 积分/);
    assert.equal(s.t.calls.length, 1, "应发送 1 条 Telegram");
  } finally { await s.close(); }
});

test("两路当天都已签：不发 Telegram，不调用签到接口，返回静默说明", async () => {
  const s = await setup({ airport: airportHandler({ checkedToday: true }), wb: workbuddyHandler({ checkedToday: true }) });
  try {
    const { status, text } = await runOnce(s.env);
    assert.equal(status, 200);
    assert.match(text, /静默/);
    assert.match(text, /剩余 97\.1GB/);
    assert.equal(s.t.calls.length, 0, "不应发送 Telegram");
    assert.ok(!s.a.paths().includes("/user/checkin"));
    assert.ok(!s.w.paths().some((p) => p.endsWith("daily-checkin")));
  } finally { await s.close(); }
});

test("机场已签但 WorkBuddy 新领取：仍发一条通知，两路信息都在", async () => {
  const s = await setup({ airport: airportHandler({ checkedToday: true }) });
  try {
    const { status, text } = await runOnce(s.env);
    assert.equal(status, 200);
    assert.match(text, /🛫 机场：今日已签/);
    assert.match(text, /🐱 WorkBuddy：本次 \+100 积分/);
    assert.equal(s.t.calls.length, 1);
  } finally { await s.close(); }
});

test("一路失败：发通知并标记失败，整体 500，另一路正常", async () => {
  const s = await setup({ airport: (path) => path === "/auth/login" ? { status: 200, body: { ret: 0, msg: "密码错误" } } : null });
  try {
    const { status, text } = await runOnce(s.env);
    assert.equal(status, 500);
    assert.match(text, /❌ 机场签到失败: 登录失败: 密码错误/);
    assert.match(text, /🐱 WorkBuddy：本次 \+100 积分/);
    assert.equal(s.t.calls.length, 1);
  } finally { await s.close(); }
});

test("只配置 WorkBuddy 时不去访问机场", async () => {
  const s = await setup();
  try {
    const { status, text } = await runOnce({ ...s.env, DOMAIN: "", USERNAME: "", PASSWORD: "" });
    assert.equal(status, 200);
    assert.equal(s.a.calls.length, 0);
    assert.match(text, /🐱 WorkBuddy：本次 \+100 积分/);
  } finally { await s.close(); }
});

test("两者都未配置时返回配置错误", async () => {
  const { status, text } = await runOnce({ DOMAIN: "", USERNAME: "", PASSWORD: "", WB_TOKEN: "", WB_UID: "" });
  assert.equal(status, 500);
  assert.match(text, /缺少必要的配置参数/);
});

test("WB_TOKEN 和 WB_UID 带引号、空白或逗号时自动清理", async () => {
  const s = await setup();
  try {
    await runOnce({ ...s.env, DOMAIN: "", WB_TOKEN: ' "tok123", \n', WB_UID: '"uid-456",' });
    const h = s.w.calls[0].headers;
    assert.equal(h.authorization, "Bearer tok123");
    assert.equal(h["x-user-id"], "uid-456");
  } finally { await s.close(); }
});

test("配置摘要显示令牌长度和格式检查结果", async () => {
  const res = await worker.fetch(new Request("http://worker.local/"), { DOMAIN: "", WB_TOKEN: "eyJabc.def.ghi", WB_UID: "u1" });
  assert.match(await res.text(), /WB_TOKEN 长度 14，格式正常/);
  const res2 = await worker.fetch(new Request("http://worker.local/"), { DOMAIN: "", WB_TOKEN: "not-a-jwt", WB_UID: "u1" });
  assert.match(await res2.text(), /格式异常/);
});
