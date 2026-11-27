// Unit tests for the rate-limit OpenAI mock (#2572).
// Run with: npm run test:units
import { test } from "node:test";
import assert from "node:assert/strict";
import type os from "node:os";
import { MOCK_HOST_ENV, MOCK_MODEL_ID, addressForLangflow, startRateLimitMock } from "./rate-limit-openai-mock";

type Interfaces = ReturnType<typeof os.networkInterfaces>;

function iface(address: string, internal = false, family: "IPv4" | "IPv6" = "IPv4") {
  return { address, internal, family, netmask: "", mac: "", cidr: null } as unknown as os.NetworkInterfaceInfo;
}

test("picks the first non-internal RFC-1918 IPv4 address", () => {
  const interfaces: Interfaces = {
    lo: [iface("127.0.0.1", true)],
    utun: [iface("100.64.1.2")],
    link: [iface("169.254.3.4")],
    pub: [iface("203.0.113.7")],
    v6: [iface("fd00::1", false, "IPv6")],
    eth0: [iface("10.1.0.4")],
    docker0: [iface("172.17.0.1")],
  };
  assert.equal(addressForLangflow({}, interfaces), "10.1.0.4");
});

test("accepts each RFC-1918 range and nothing just outside them", () => {
  for (const ok of ["10.0.0.1", "172.16.0.1", "172.31.255.1", "192.168.1.1"]) {
    assert.equal(addressForLangflow({}, { a: [iface(ok)] }), ok, ok);
  }
  for (const no of ["172.15.0.1", "172.32.0.1", "192.169.0.1", "11.0.0.1", "100.64.0.1", "169.254.0.1"]) {
    assert.equal(addressForLangflow({}, { a: [iface(no)] }), undefined, no);
  }
});

test("the override wins, and a blank override is ignored", () => {
  const interfaces: Interfaces = { eth0: [iface("10.1.0.4")] };
  assert.equal(addressForLangflow({ [MOCK_HOST_ENV]: "192.168.5.5" }, interfaces), "192.168.5.5");
  assert.equal(addressForLangflow({ [MOCK_HOST_ENV]: "  " }, interfaces), "10.1.0.4");
});

test("undefined when no interface qualifies", () => {
  assert.equal(addressForLangflow({}, { lo: [iface("127.0.0.1", true)] }), undefined);
});

test("the mock answers models, echoes completions, and rate-limits each message N times", async () => {
  const mock = await startRateLimitMock({ [MOCK_HOST_ENV]: "127.0.0.1" });
  try {
    const port = new URL(mock.baseUrlForLangflow).port;
    const base = `http://127.0.0.1:${port}/v1`;
    const models = await (await fetch(`${base}/models`)).json();
    assert.equal(models.data[0].id, MOCK_MODEL_ID);

    mock.reset({ rateLimitFirstPerMessage: 2, retryAfterSeconds: 3 });
    const ask = (text: string) =>
      fetch(`${base}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: MOCK_MODEL_ID, messages: [{ role: "system", content: "s" }, { role: "user", content: text }] }),
      });
    const first = await ask("a");
    assert.equal(first.status, 429);
    assert.equal(first.headers.get("retry-after"), "3");
    assert.equal((await ask("a")).status, 429);
    assert.equal((await ask("b")).status, 429, "the count is per message");
    const third = await ask("a");
    assert.equal(third.status, 200);
    assert.equal((await third.json()).choices[0].message.content, "ECHO:a");
    assert.deepEqual(
      mock.completions().map((r) => [r.user, r.status]),
      [["a", 429], ["a", 429], ["b", 429], ["a", 200]],
      "only completions are recorded, in arrival order",
    );

    mock.reset();
    assert.equal((await ask("a")).status, 200, "reset clears the per-message count");
    assert.equal(mock.completions().length, 1, "reset clears the record");
  } finally {
    await mock.close();
  }
});

test("a delayed reply takes at least the configured delay, and a 429 is not delayed", async () => {
  const mock = await startRateLimitMock({ [MOCK_HOST_ENV]: "127.0.0.1" });
  try {
    const base = `http://127.0.0.1:${new URL(mock.baseUrlForLangflow).port}/v1`;
    const ask = () =>
      fetch(`${base}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: MOCK_MODEL_ID, messages: [{ role: "user", content: "d" }] }),
      });
    mock.reset({ rateLimitFirstPerMessage: 1, responseDelayMs: 250 });
    let t0 = Date.now();
    assert.equal((await ask()).status, 429);
    assert.ok(Date.now() - t0 < 200, "the 429 answers at once");
    t0 = Date.now();
    assert.equal((await ask()).status, 200);
    assert.ok(Date.now() - t0 >= 240, `the reply waited the delay (took ${Date.now() - t0} ms)`);
  } finally {
    await mock.close();
  }
});

test("starting fails naming the variable when no address qualifies", async () => {
  await assert.rejects(startRateLimitMock({}, { lo: [iface("127.0.0.1", true)] }), new RegExp(MOCK_HOST_ENV));
});
