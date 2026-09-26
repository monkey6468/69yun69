import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import worker from "../_worker.js";

function startServer(handler) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reply = handler(req.url, body);
      res.writeHead(reply.status, { "Content-Type": "application/json", ...(reply.headers || {}) });
      res.end(JSON.stringify(reply.body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const airportOk = (path) => {
  if (path === "/auth/login") return { status: 200, headers: { "Set-Cookie": "sid=abc; Path=/" }, body: { ret: 1 } };
  if (path === "/user/checkin") return { status: 200, body: { ret: 1, msg: "获得了 100MB 流量" } };
  return { status: 404, body: {} };
};
const wbOk = (path) => {
  if (path.endsWith("checkin-activity-status")) return { status: 200, body: { active: true, today_checked_in: true, streak_days: 2, total_credits: 300 } };
  return { status: 404, body: {} };
};

async function runOnce(env) {
  const res = await worker.fetch(new Request("http://worker.local/auto"), { TOKEN: "auto", ...env });
  return { status: res.status, text: await res.text() };
}

test("机场和 WorkBuddy 都配置时，两路结果合并在一条消息里", async () => {
  const airport = await startServer(airportOk);
  const wb = await startServer(wbOk);
  try {
    const { status, text } = await runOnce({ DOMAIN: airport.url, USERNAME: "a@b.com", PASSWORD: "p", WB_TOKEN: "t", WB_UID: "u", WB_ENDPOINT: wb.url });
    assert.equal(status, 200);
    assert.match(text, /获得了 100MB 流量/);
    assert.match(text, /WorkBuddy：今日已签到/);
  } finally {
    await airport.close();
    await wb.close();
  }
});

test("机场签到失败不影响 WorkBuddy 签到，整体标记失败", async () => {
  const airport = await startServer(() => ({ status: 200, body: { ret: 0, msg: "密码错误" } }));
  const wb = await startServer(wbOk);
  try {
    const { status, text } = await runOnce({ DOMAIN: airport.url, USERNAME: "a@b.com", PASSWORD: "p", WB_TOKEN: "t", WB_UID: "u", WB_ENDPOINT: wb.url });
    assert.equal(status, 500);
    assert.match(text, /机场签到失败: 登录失败: 密码错误/);
    assert.match(text, /WorkBuddy：今日已签到/);
  } finally {
    await airport.close();
    await wb.close();
  }
});

test("只配置 WorkBuddy 时不去访问机场", async () => {
  const wb = await startServer(wbOk);
  try {
    const { status, text } = await runOnce({ DOMAIN: "", USERNAME: "", PASSWORD: "", WB_TOKEN: "t", WB_UID: "u", WB_ENDPOINT: wb.url });
    assert.equal(status, 200);
    assert.doesNotMatch(text, /机场签到/);
    assert.match(text, /WorkBuddy：今日已签到/);
  } finally {
    await wb.close();
  }
});

test("两者都未配置时返回配置错误", async () => {
  const { status, text } = await runOnce({ DOMAIN: "", USERNAME: "", PASSWORD: "", WB_TOKEN: "", WB_UID: "" });
  assert.equal(status, 500);
  assert.match(text, /缺少必要的配置参数/);
});

test("WB_TOKEN 和 WB_UID 带引号、空白或逗号时自动清理", async () => {
  let seen = null;
  const wb = await startServer((path, body, headers) => {
    return { status: 200, body: { active: true, today_checked_in: true } };
  });
  // 需要看到请求头，改用带 header 捕获的服务器
  await wb.close();
  const http = await import("node:http");
  const srv = http.createServer((req, res) => {
    seen = req.headers;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ active: true, today_checked_in: true }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const { status, text } = await runOnce({ DOMAIN: "", WB_TOKEN: ' "tok123", \n', WB_UID: '"uid-456",', WB_ENDPOINT: `http://127.0.0.1:${srv.address().port}` });
    assert.equal(status, 200);
    assert.equal(seen.authorization, "Bearer tok123");
    assert.equal(seen["x-user-id"], "uid-456");
    assert.match(text, /WorkBuddy：今日已签到/);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test("配置摘要显示令牌长度和格式检查结果", async () => {
  const res = await worker.fetch(new Request("http://worker.local/"), { DOMAIN: "", WB_TOKEN: "eyJabc.def.ghi", WB_UID: "u1" });
  const text = await res.text();
  assert.match(text, /WB_TOKEN 长度 14/);
  assert.match(text, /格式正常/);
  const res2 = await worker.fetch(new Request("http://worker.local/"), { DOMAIN: "", WB_TOKEN: "not-a-jwt", WB_UID: "u1" });
  assert.match(await res2.text(), /格式异常/);
});
