import test from "node:test";
import assert from "node:assert/strict";
import { airportCheckIn } from "../_worker.js";
import { startServer, airportHandler, NOW } from "./helpers.mjs";

const cfg = (srv) => ({ domain: srv.url, username: "a@b.com", password: "p" });

test("今天未签：先查用户信息，再签到，报告本次获得、剩余流量和到期日", async () => {
  const srv = await startServer(airportHandler());
  try {
    const r = await airportCheckIn(cfg(srv));
    assert.equal(r.status, "claimed");
    assert.equal(r.gained, "100 MB");
    assert.equal(r.remaining, "97.1GB");
    assert.equal(r.todayUsed, "1.2GB");
    assert.equal(r.expire, "2026-10-30");
    assert.deepEqual(srv.paths(), ["/auth/login", "/getuserinfo", "/user/checkin", "/gettransfer"]);
  } finally { await srv.close(); }
});

test("今天已签（last_check_in_time 为今天）：不再调用签到接口，仍返回剩余流量", async () => {
  const srv = await startServer(airportHandler({ checkedToday: true }));
  try {
    const r = await airportCheckIn(cfg(srv));
    assert.equal(r.status, "already");
    assert.equal(r.remaining, "97.1GB");
    assert.equal(r.expire, "2026-10-30");
    assert.ok(!srv.paths().includes("/user/checkin"), "不应调用 /user/checkin");
  } finally { await srv.close(); }
});

test("getuserinfo 不可用时仍直接签到；服务端说已签到则按已签处理而非失败", async () => {
  const srv = await startServer(airportHandler({ checkedToday: true, userinfo: () => ({ status: 200, body: { ret: -1 } }) }));
  try {
    const r = await airportCheckIn(cfg(srv));
    assert.equal(r.status, "already");
    assert.ok(srv.paths().includes("/user/checkin"));
    assert.equal(r.remaining, "97.1GB");
  } finally { await srv.close(); }
});

test("gettransfer 失败时退回签到返回的 trafficInfo", async () => {
  const srv = await startServer(airportHandler({ transferFails: true }));
  try {
    const r = await airportCheckIn(cfg(srv));
    assert.equal(r.status, "claimed");
    assert.equal(r.remaining, "97.0GB");
  } finally { await srv.close(); }
});

test("gettransfer 和 trafficInfo 都没有时，用 getuserinfo 的字节数自己换算", async () => {
  const srv = await startServer(airportHandler({
    checkedToday: true, transferFails: true,
    userinfo: () => ({ status: 200, body: { ret: 1, info: { user: { u: 1e9, d: 2e9, transfer_enable: 100e9, last_check_in_time: NOW, class_expire: "1989-06-04 00:00:00" } } } }),
  }));
  try {
    const r = await airportCheckIn(cfg(srv));
    assert.equal(r.status, "already");
    assert.equal(r.remaining, "90.34GB");
    assert.equal(r.expire, undefined, "哨兵日期不应显示");
  } finally { await srv.close(); }
});

test("登录失败抛出明确错误", async () => {
  const srv = await startServer((path) => path === "/auth/login" ? { status: 200, body: { ret: 0, msg: "密码错误" } } : null);
  try {
    await assert.rejects(() => airportCheckIn(cfg(srv)), /登录失败: 密码错误/);
  } finally { await srv.close(); }
});
