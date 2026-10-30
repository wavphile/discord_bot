import assert from "node:assert/strict";
import test from "node:test";
import { createReadinessServer } from "../src/health/readiness.js";

test("readiness follows Discord and database state and serves only the private endpoint", async () => {
  let discordReady = false;
  let databaseReady = true;
  const server = createReadinessServer(
    {
      discordReady: () => discordReady,
      databaseReady: () => databaseReady,
    },
    { port: 0 },
  );

  await server.listen();
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    if (!address || typeof address === "string") {
      assert.fail("The readiness server did not bind a TCP port.");
    }
    assert.equal(address.address, "127.0.0.1");

    const endpoint = `http://127.0.0.1:${address.port}`;
    const starting = await fetch(`${endpoint}/readyz`);
    assert.equal(starting.status, 503);
    assert.deepEqual(await starting.json(), { status: "not_ready" });

    discordReady = true;
    const ready = await fetch(`${endpoint}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: "ready" });

    databaseReady = false;
    const databaseUnavailable = await fetch(`${endpoint}/readyz`);
    assert.equal(databaseUnavailable.status, 503);

    const unknownRoute = await fetch(`${endpoint}/`);
    assert.equal(unknownRoute.status, 404);
    const wrongMethod = await fetch(`${endpoint}/readyz`, { method: "POST" });
    assert.equal(wrongMethod.status, 405);
  } finally {
    await server.close();
  }
});

test("a failed readiness check returns unavailable without exposing details", async () => {
  const server = createReadinessServer(
    {
      discordReady: () => true,
      databaseReady: () => {
        throw new Error("private database detail");
      },
    },
    { port: 0 },
  );

  await server.listen();
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      assert.fail("The readiness server did not bind a TCP port.");
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/readyz`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "not_ready" });
  } finally {
    await server.close();
  }
});
