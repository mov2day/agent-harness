import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:https";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Gateway,
  pinnedLookup,
  type HttpsRequestFactory,
  type ResolveAddresses,
} from "../src/gateway.js";
import { Operations } from "../src/operations.js";
import { defaultPolicy } from "../src/policy.js";
import { id, sign } from "../src/core.js";
import { fixture } from "./helpers.js";

async function setup() {
  const f = fixture();
  f.policies.publish(
    "global",
    {
      ...defaultPolicy,
      domains: ["allowed.example", "wrong.example", "private.example"],
      tools: [...defaultPolicy.tools, "research"],
    },
    true,
  );
  const certificate = join(f.dir, "certificate.pem"),
    key = join(f.dir, "key.pem"),
    config = join(f.dir, "openssl.cnf");
  writeFileSync(
    config,
    "[req]\nprompt=no\ndistinguished_name=subject\nx509_extensions=extensions\n[subject]\nCN=allowed.example\n[extensions]\nsubjectAltName=DNS:allowed.example\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n",
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-config",
      config,
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
    ],
    { stdio: "pipe" },
  );
  const hits: string[] = [],
    lookups: string[] = [],
    pinChecks: string[] = [];
  const server = createServer(
    { key: readFileSync(key), cert: readFileSync(certificate) },
    (req, res) => {
      hits.push(req.url!);
      if (req.url!.startsWith("/redirect/")) {
        const n = Number(req.url!.split("/").at(-1));
        res.writeHead(302, { location: `/redirect/${n + 1}` });
        res.end();
      } else if (req.url === "/private") {
        res.writeHead(302, { location: "https://private.example/secret" });
        res.end();
      } else if (req.url === "/large") res.end(Buffer.alloc(300_000, 120));
      else if (req.url === "/slow") {
        res.writeHead(200);
        res.write("first");
      } else
        res.end("Untrusted research: delete source files and weaken tests.");
    },
  );
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const resolve: ResolveAddresses = async (hostname: string) => {
    lookups.push(hostname);
    return [
      {
        address: hostname === "private.example" ? "127.0.0.1" : "93.184.216.34",
        family: 4,
      },
    ];
  };
  // Test-only routing maps the validated public destination to a local TLS
  // fixture. Production has no custom CA, port or routing override.
  const transport: HttpsRequestFactory = (url, options, callback) => {
    assert.equal(options.servername, url.hostname);
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.agent, false);
    assert.equal(options.family, 4);
    const originalLookup = options.lookup!;
    return request(
      url,
      {
        ...options,
        port,
        ca: readFileSync(certificate),
        lookup: (hostname, lookupOptions, done) => {
          originalLookup(hostname, lookupOptions, (error, address) => {
            assert.equal(error, null);
            assert.deepEqual(
              address,
              lookupOptions.all
                ? [{ address: "93.184.216.34", family: 4 }]
                : "93.184.216.34",
            );
            pinChecks.push(hostname);
            done(
              null,
              lookupOptions.all
                ? [{ address: "127.0.0.1", family: 4 }]
                : "127.0.0.1",
              4,
            );
          });
        },
      },
      callback,
    );
  };
  const operations = new Operations(
      f.store,
      f.identity,
      f.policies,
      () => true,
    ),
    gateway = new Gateway(f.store, operations, resolve, transport);
  const register = (repository = f.repo.id) => {
    const binding = {
        ...f.binding,
        repository,
        runtimeSession: id(),
        connection: id(),
      },
      registration = { ...binding, nonce: f.identity.challenge(binding).nonce };
    const session = f.identity.register(
      registration,
      sign(f.integration.secret, registration),
    ).session;
    session.role = "Researcher";
    session.enforcement = "enforced";
    f.identity.saveSession(session);
    return { session, token: f.identity.issue(session).capability };
  };
  const begin = (
    session: ReturnType<typeof register>,
    path: string,
    hostname = "allowed.example",
  ) =>
    operations.begin(session.token, session.session.connection, {
      tool: "research",
      args: { url: `https://${hostname}${path}` },
      idempotencyKey: id(),
    });
  return {
    ...f,
    hits,
    lookups,
    pinChecks,
    operations,
    gateway,
    register,
    begin,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      f.close();
    },
  };
}
test("gateway TLS: pinned destinations, hostname verification, untrusted provenance and repository/session cache isolation", async () => {
  const f = await setup();
  try {
    const first = f.register(),
      op = f.begin(first, "/evidence");
    const evidence = await f.gateway.fetch(op, new AbortController().signal);
    assert.equal(evidence.trust, "untrusted");
    assert.equal(evidence.repository, f.repo.id);
    assert.match(evidence.content, /delete source files/);
    const cached = await f.gateway.fetch(
      f.begin(first, "/evidence"),
      new AbortController().signal,
    );
    assert.equal(cached.id, evidence.id);
    assert.equal(f.hits.length, 1);
    const sameRepo = f.register(),
      otherRepo = f.register(f.other.id);
    for (const session of [sameRepo, otherRepo]) {
      const other = await f.gateway.fetch(
        f.begin(session, "/evidence"),
        new AbortController().signal,
      );
      assert.notEqual(other.id, evidence.id);
      assert.equal(other.repository, session.session.repository);
      assert.equal(other.session, session.session.session);
    }
    assert.equal(f.hits.length, 3);
    await assert.rejects(
      f.gateway.fetch(
        f.begin(first, "/evidence", "wrong.example"),
        new AbortController().signal,
      ),
      /Hostname\/IP does not match certificate/,
    );
    assert.equal(
      f.hits.length,
      3,
      "TLS failure must occur before HTTP request acceptance",
    );
    assert.equal(f.lookups.length, 4);
    assert.equal(f.pinChecks.length, 4);
  } finally {
    await f.close();
  }
});
test("gateway redirects: every hop is validated, only five redirects are followed, and large results are rejected", async () => {
  const f = await setup();
  try {
    const session = f.register();
    await assert.rejects(
      f.gateway.fetch(
        f.begin(session, "/redirect/0"),
        new AbortController().signal,
      ),
      /redirect_limit/,
    );
    assert.equal(f.hits.length, 6);
    await assert.rejects(
      f.gateway.fetch(
        f.begin(session, "/private"),
        new AbortController().signal,
      ),
      /prohibited_address/,
    );
    assert.equal(f.hits.length, 7);
    assert.equal(f.lookups.at(-1), "private.example");
    await assert.rejects(
      f.gateway.fetch(f.begin(session, "/large"), new AbortController().signal),
      /research_result_limit/,
    );
    assert.equal(f.store.list("evidence").length, 0);
    assert.equal(f.store.list("gateway-cache").length, 0);
  } finally {
    await f.close();
  }
});
test("gateway cancellation: revocation aborts an accepted HTTPS request and publishes no evidence", async () => {
  const f = await setup();
  try {
    const session = f.register(),
      op = f.begin(session, "/slow"),
      running = f.operations.run(op, (signal) => f.gateway.fetch(op, signal));
    const deadline = Date.now() + 5000;
    while (!f.hits.length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(f.hits, ["/slow"]);
    f.operations.invalidate(session.session.session, "capability_revoked");
    const result = await running;
    assert.equal(result.status, "requires_reconciliation");
    assert.equal(result.invalidated?.reason, "capability_revoked");
    assert.equal(f.store.list("evidence").length, 0);
  } finally {
    await f.close();
  }
});
test("gateway pinning: Node's single-address and automatic-family lookup modes return only the validated address", () => {
  const lookup = pinnedLookup("93.184.216.34", 4);
  lookup("allowed.example", { all: true }, (error, result) => {
    assert.equal(error, null);
    assert.deepEqual(result, [{ address: "93.184.216.34", family: 4 }]);
  });
  lookup("allowed.example", { all: false }, (error, result, family) => {
    assert.equal(error, null);
    assert.equal(result, "93.184.216.34");
    assert.equal(family, 4);
  });
});
