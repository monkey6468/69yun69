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
