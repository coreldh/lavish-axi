import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { isAttachmentUploadApiPath, serve } from "../src/server.js";

// A 2x1 PNG.
const PNG_2x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8BQz0BkYGAAADAAA/8W1p0AAAAASUVORK5CYII=",
  "base64",
);

/**
 * @param {(ctx: { base: string, key: string, artifact: string }) => Promise<void>} run
 * @param {{ env?: Record<string, string> }} [options]
 */
async function withSession(run, { env } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-attach-srv-"));
  const artifact = path.join(dir, "artifact.html");
  await writeFile(artifact, "<!doctype html><html><body></body></html>");
  const saved = {};
  if (env) {
    for (const [name, value] of Object.entries(env)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
  }
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const open = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    });
    const { key } = await open.json();
    await run({ base, key, artifact });
  } finally {
    await server.close();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function uploadImage(base, key, body, { origin = base, contentType = "image/png" } = {}) {
  return fetch(`${base}/api/${key}/attachments`, {
    method: "POST",
    headers: { "content-type": contentType, origin },
    body,
  });
}

test("isAttachmentUploadApiPath matches only the upload route", () => {
  assert.equal(isAttachmentUploadApiPath("/api/0123456789abcdef/attachments"), true);
  assert.equal(isAttachmentUploadApiPath("/api/0123456789abcdef/attachments/x.png"), false);
  assert.equal(isAttachmentUploadApiPath("/api/zz/attachments"), false);
});

test("POST /api/:key/attachments stores an image and returns server-vetted metadata", async () => {
  await withSession(async ({ base, key }) => {
    const res = await uploadImage(base, key, PNG_2x1);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "stored");
    assert.equal(body.attachment.type, "image");
    assert.equal(body.attachment.mime, "image/png");
    assert.equal(body.attachment.bytes, PNG_2x1.length);
    assert.equal(body.attachment.width, 2);
    assert.equal(body.attachment.height, 1);
    assert.match(body.attachment.id, /^[0-9a-f]{64}\.png$/);
    assert.ok(body.attachment.path.endsWith(path.join("attachments", key, body.attachment.id)));
  });
});

test("GET /api/:key/attachments/:id serves the stored bytes with the right type", async () => {
  await withSession(async ({ base, key }) => {
    const { attachment } = await (await uploadImage(base, key, PNG_2x1)).json();
    const res = await fetch(`${base}/api/${key}/attachments/${attachment.id}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /image\/png/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(bytes, PNG_2x1);
  });
});

test("GET returns 404 for unknown or malformed ids", async () => {
  await withSession(async ({ base, key }) => {
    assert.equal((await fetch(`${base}/api/${key}/attachments/${"f".repeat(64)}.png`)).status, 404);
    assert.equal((await fetch(`${base}/api/${key}/attachments/not-a-valid-id`)).status, 404);
  });
});

test("DELETE removes a stored attachment and is idempotent", async () => {
  await withSession(async ({ base, key }) => {
    const { attachment } = await (await uploadImage(base, key, PNG_2x1)).json();
    const first = await fetch(`${base}/api/${key}/attachments/${attachment.id}`, {
      method: "DELETE",
      headers: { origin: base },
    });
    assert.deepEqual(await first.json(), { status: "removed" });
    const second = await fetch(`${base}/api/${key}/attachments/${attachment.id}`, {
      method: "DELETE",
      headers: { origin: base },
    });
    assert.deepEqual(await second.json(), { status: "absent" });
    assert.equal((await fetch(`${base}/api/${key}/attachments/${attachment.id}`)).status, 404);
  });
});

test("DELETE keeps a content-addressed file still referenced by a queued prompt (refcount)", async () => {
  await withSession(async ({ base, key, artifact }) => {
    const { attachment } = await (await uploadImage(base, key, PNG_2x1)).json();
    // Queue a prompt that references the image, then try to delete that same id
    // (as a second card removing the deduped chip would). The queued prompt still
    // needs the file, so the delete must be refused and the bytes must survive.
    await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompts: [
          { uid: "1", prompt: "look", selector: "body", tag: "body", text: "", attachments: [{ id: attachment.id }] },
        ],
      }),
    });
    const del = await fetch(`${base}/api/${key}/attachments/${attachment.id}`, {
      method: "DELETE",
      headers: { origin: base },
    });
    assert.deepEqual(await del.json(), { status: "referenced" });
    // The file is still fetchable, so the queued prompt's thumbnail/path is intact.
    assert.equal((await fetch(`${base}/api/${key}/attachments/${attachment.id}`)).status, 200);

    // Delivering the feedback does NOT release the reference: the agent has just
    // been handed this path and is only now reading it, so the file stays protected
    // for the delivery read grace rather than becoming collectable mid-read.
    await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`);
    const del2 = await fetch(`${base}/api/${key}/attachments/${attachment.id}`, {
      method: "DELETE",
      headers: { origin: base },
    });
    assert.deepEqual(await del2.json(), { status: "referenced" });
    assert.equal((await fetch(`${base}/api/${key}/attachments/${attachment.id}`)).status, 200);
  });
});

test("upload and delete reject cross-origin requests", async () => {
  await withSession(async ({ base, key }) => {
    const upload = await uploadImage(base, key, PNG_2x1, { origin: "https://attacker.example" });
    assert.equal(upload.status, 403);
    const del = await fetch(`${base}/api/${key}/attachments/${"a".repeat(64)}.png`, {
      method: "DELETE",
      headers: { origin: "https://attacker.example" },
    });
    assert.equal(del.status, 403);
  });
});

test("upload rejects non-image bytes with 415", async () => {
  await withSession(async ({ base, key }) => {
    const res = await uploadImage(base, key, Buffer.from("<svg/>"), { contentType: "image/svg+xml" });
    assert.equal(res.status, 415);
  });
});

test("upload to an unknown session returns 404", async () => {
  await withSession(async ({ base }) => {
    const res = await uploadImage(base, "0123456789abcdef", PNG_2x1);
    assert.equal(res.status, 404);
  });
});

test("a queued prompt carries the server-vetted attachment path, not the client's claim", async () => {
  await withSession(async ({ base, key, artifact }) => {
    const { attachment } = await (await uploadImage(base, key, PNG_2x1)).json();
    const queued = await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompts: [
          {
            uid: "1",
            prompt: "match this",
            selector: "body",
            tag: "body",
            text: "",
            attachments: [{ id: attachment.id, name: "mock.png", path: "/etc/passwd" }],
          },
        ],
      }),
    });
    assert.equal(queued.status, 200);
    const poll = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`);
    const feedback = await poll.json();
    const attachments = feedback.prompts[0].attachments;
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].id, attachment.id);
    assert.equal(attachments[0].name, "mock.png");
    assert.equal(attachments[0].path, attachment.path);
    assert.notEqual(attachments[0].path, "/etc/passwd");
    assert.ok(attachments[0].path.includes(path.join("attachments", key)));
  });
});

test("prompts POST rejects the batch atomically (400) when an attachment can't be resolved (C4)", async () => {
  await withSession(async ({ base, key, artifact }) => {
    const { attachment } = await (await uploadImage(base, key, PNG_2x1)).json();
    const unknown = "f".repeat(64) + ".png";
    const queued = await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompts: [
          {
            uid: "1",
            prompt: "match this",
            selector: "body",
            tag: "body",
            text: "",
            attachments: [{ id: attachment.id }, { id: unknown }],
          },
        ],
      }),
    });
    assert.equal(queued.status, 400);
    const body = await queued.json();
    assert.deepEqual(
      body.rejected.map((r) => ({ id: r.id, reason: r.reason })),
      [{ id: unknown, reason: "not-found" }],
    );
    // Persist nothing: the poll sees no feedback, so the valid image is not half-delivered.
    const poll = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`);
    const feedback = await poll.json();
    assert.notEqual(feedback.status, "feedback");
  });
});

test("upload rejects bytes over the configured per-image cap with 413", async () => {
  await withSession(
    async ({ base, key }) => {
      const res = await uploadImage(base, key, PNG_2x1);
      assert.equal(res.status, 413);
    },
    { env: { LAVISH_AXI_MAX_ATTACHMENT_BYTES: "8" } },
  );
});

// Non-regression for the merged export/share feature (#123): the raw-body upload
// route and the attachment plumbing must not interfere with export, and queued
// image attachments (which live in the state dir, not the artifact) must never
// leak into an exported bundle.
test("export still works and leaks no attachment data when a prompt references an image", async () => {
  await withSession(async ({ base, key }) => {
    const { attachment } = await (await uploadImage(base, key, PNG_2x1)).json();
    await fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompts: [
          { uid: "1", prompt: "match", selector: "body", tag: "body", text: "", attachments: [{ id: attachment.id }] },
        ],
      }),
    });
    const res = await fetch(`${base}/api/${key}/export`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const html = await res.text();
    assert.doesNotMatch(html, new RegExp(attachment.id));
    assert.doesNotMatch(html, /\/api\/[0-9a-f]{16}\/attachments/);
    assert.doesNotMatch(html, /lavish:uploadAttachment/);
  });
});

test("the server sweeps an expired, unreferenced attachment at startup", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-attach-sweep-"));
  const stateFile = path.join(dir, "state.json");
  const key = "0123456789abcdef";
  const id = "a".repeat(64) + ".png";
  const attachmentDir = path.join(dir, "attachments", key);
  const attachmentFile = path.join(attachmentDir, id);
  await mkdir(attachmentDir, { recursive: true });
  await writeFile(attachmentFile, PNG_2x1);
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
  await utimes(attachmentFile, new Date(old), new Date(old));

  const saved = process.env.LAVISH_AXI_ATTACHMENT_TTL_MS;
  process.env.LAVISH_AXI_ATTACHMENT_TTL_MS = "1000";
  const server = await serve({ port: 0, stateFile, version: "9.9.9-test" });
  try {
    const deadline = Date.now() + 2000;
    let gone = false;
    while (Date.now() < deadline) {
      try {
        await access(attachmentFile);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        gone = true;
        break;
      }
    }
    assert.ok(gone, "expired orphan attachment should be swept on startup");
  } finally {
    await server.close();
    if (saved === undefined) delete process.env.LAVISH_AXI_ATTACHMENT_TTL_MS;
    else process.env.LAVISH_AXI_ATTACHMENT_TTL_MS = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

import http from "node:http";

// A raw HTTP request so we can set the Host header (fetch forbids it), which the
// DNS-rebinding scenario requires: the victim's browser is on the attacker's origin
// and therefore sends a matching, attacker-controlled Host AND Origin.
/**
 * @param {string} base
 * @param {string} requestPath
 * @param {{ method?: string, headers?: Record<string, string>, body?: Buffer | string }} [options]
 */
function rawRequest(base, requestPath, { method = "GET", headers = {}, body } = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: requestPath, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("same-origin guard rejects a DNS-rebinding request whose Host equals its Origin (security)", async () => {
  await withSession(async ({ base, key }) => {
    // The OLD guard derived the expected origin from the request's own Host header, so
    // an attacker page whose Host and Origin both say `attacker.example` matched itself
    // and passed. The guard must instead reject any origin that is not the server's
    // CONFIGURED loopback address, regardless of the Host header.
    const spoofed = await rawRequest(base, `/api/${key}/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png", host: "attacker.example", origin: "http://attacker.example" },
      body: PNG_2x1,
    });
    assert.equal(spoofed.status, 403, "a spoofed-Host cross-origin upload is rejected");

    // A legitimate loopback upload (Host and Origin are the real server address) passes.
    const legit = await rawRequest(base, `/api/${key}/attachments`, {
      method: "POST",
      headers: { "content-type": "image/png", host: new URL(base).host, origin: base },
      body: PNG_2x1,
    });
    assert.equal(legit.status, 200, "a legitimate loopback upload still passes");
  });
});

test("disk-cap admission: queued uploads across pages cannot exceed maxDiskBytes (security)", async () => {
  // Distinct tiny PNGs (append bytes past the IHDR so each hashes uniquely but still
  // detects as PNG). Each charges 2 blocks (image + sidecar) = 8192 B; the cap fits 2.
  const distinct = (i) => Buffer.concat([PNG_2x1, Buffer.from([0, 0, 0, i])]);
  await withSession(
    async ({ base, key }) => {
      const queueRef = (id, i) =>
        fetch(`${base}/api/${key}/prompts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompts: [{ uid: String(i), prompt: "p", selector: "body", tag: "body", text: "", attachments: [{ id }] }],
          }),
        });

      // Upload + queue two images so they are REFERENCED (a sweep can never evict them).
      for (let i = 0; i < 2; i += 1) {
        const up = await uploadImage(base, key, distinct(i));
        assert.equal(up.status, 200, `image ${i} is admitted under the cap`);
        const { attachment } = await up.json();
        await queueRef(attachment.id, i);
      }

      // The third upload would push committed storage over the cap, and the two on disk
      // are referenced (queued) so nothing can be evicted - admission must refuse it,
      // so committed storage never exceeds maxDiskBytes.
      const third = await uploadImage(base, key, distinct(2));
      assert.equal(third.status, 507, "the over-cap upload is refused at admission");
    },
    { env: { LAVISH_AXI_MAX_ATTACHMENT_DISK_MB: String(16384 / (1024 * 1024)) } },
  );
});

test("an uppercase/IDN configured link host still admits a legit same-origin write (ORIGIN-001)", async () => {
  // The trusted origin is built from LAVISH_AXI_LINK_HOST; if it is stored verbatim
  // while request origins are URL-normalized (lowercased), a legitimate write from the
  // page's own (normalized) origin fails 403. The configured host must be canonicalized
  // exactly as request origins are. The server still binds loopback; only the trusted
  // ORIGIN differs.
  await withSession(
    async ({ base, key }) => {
      const port = new URL(base).port;
      // A real same-origin write from the normalized configured origin passes.
      const legit = await rawRequest(base, `/api/${key}/attachments`, {
        method: "POST",
        headers: { "content-type": "image/png", host: `example.com:${port}`, origin: `http://example.com:${port}` },
        body: PNG_2x1,
      });
      assert.equal(legit.status, 200, "the page's own (normalized) origin is admitted");

      // A genuine cross-origin request is still rejected.
      const attacker = await rawRequest(base, `/api/${key}/attachments`, {
        method: "POST",
        headers: { "content-type": "image/png", host: "attacker.example", origin: "http://attacker.example" },
        body: PNG_2x1,
      });
      assert.equal(attacker.status, 403, "a real cross-origin write is still rejected");
    },
    { env: { LAVISH_AXI_LINK_HOST: "Example.COM" } },
  );
});

test("disk-cap admission counts in-grace crash-temp/orphan bytes (ATTACH-003)", async () => {
  // A crash leaves a temp file that is within the 5-minute grace, so the sweep does
  // NOT reap it, and it is not a valid ID_RE attachment so it is absent from
  // `chargedBytes`. Its allocation is nonetheless real on disk, so admission must
  // count it - otherwise an upload fills the nominal cap on top of hidden bytes.
  const distinct = (i) => Buffer.concat([PNG_2x1, Buffer.from([0, 0, 0, i])]);
  await withSession(
    async ({ base, key, artifact }) => {
      // One image, uploaded + queued so it is referenced (charged 2 blocks = 8192).
      const up = await uploadImage(base, key, distinct(0));
      assert.equal(up.status, 200);
      const { attachment } = await up.json();
      await fetch(`${base}/api/${key}/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompts: [
            { uid: "0", prompt: "p", selector: "body", tag: "body", text: "", attachments: [{ id: attachment.id }] },
          ],
        }),
      });

      // Simulate crash debris: a fresh temp file (within grace) consuming one block,
      // invisible to ID_RE and to `chargedBytes`.
      const attachDir = path.join(path.dirname(artifact), "attachments", key);
      await writeFile(path.join(attachDir, "b".repeat(64) + ".png.777.1.tmp"), Buffer.alloc(4096));

      // Cap = 16384 (2 objects). Valid committed = 8192; the hidden temp adds 4096.
      // A second 8192-charge upload would be 8192+8192 = 16384 <= cap if the temp is
      // ignored (the bug), but 8192+4096+8192 = 20480 > cap once it is counted.
      const second = await uploadImage(base, key, distinct(1));
      assert.equal(second.status, 507, "the upload is refused once hidden crash-temp bytes are counted");
    },
    { env: { LAVISH_AXI_MAX_ATTACHMENT_DISK_MB: String(16384 / (1024 * 1024)) } },
  );
});

test("the orphan reap runs even with the TTL AND disk cap both disabled (R10-B, server.js:1011)", async () => {
  // With LAVISH_AXI_ATTACHMENT_TTL_MS=off and LAVISH_AXI_MAX_ATTACHMENT_DISK_MB=off
  // the old scheduling condition skipped the sweep entirely - so the orphan reap
  // (crash `.tmp` files, orphan `.meta` sidecars, both invisible to every cap)
  // never ran and that debris leaked forever. The sweep is now ALWAYS scheduled;
  // with both knobs off it reaps only orphans and never touches valid files.
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-attach-orphan-"));
  const stateFile = path.join(dir, "state.json");
  const key = "0123456789abcdef";
  const attachmentDir = path.join(dir, "attachments", key);
  const validFile = path.join(attachmentDir, "a".repeat(64) + ".png");
  const orphanTemp = path.join(attachmentDir, "b".repeat(64) + ".png.777.1.tmp");
  const orphanMeta = path.join(attachmentDir, "c".repeat(64) + ".png.meta");
  await mkdir(attachmentDir, { recursive: true });
  await writeFile(validFile, PNG_2x1);
  await writeFile(orphanTemp, Buffer.alloc(4096));
  await writeFile(orphanMeta, "{}");
  const old = Date.now() - 60 * 60 * 1000; // long past the temp write grace
  await utimes(validFile, new Date(old), new Date(old));
  await utimes(orphanTemp, new Date(old), new Date(old));
  await utimes(orphanMeta, new Date(old), new Date(old));

  const saved = { ttl: process.env.LAVISH_AXI_ATTACHMENT_TTL_MS, disk: process.env.LAVISH_AXI_MAX_ATTACHMENT_DISK_MB };
  process.env.LAVISH_AXI_ATTACHMENT_TTL_MS = "off";
  process.env.LAVISH_AXI_MAX_ATTACHMENT_DISK_MB = "off";
  const server = await serve({ port: 0, stateFile, version: "9.9.9-test" });
  try {
    const deadline = Date.now() + 2000;
    let orphansGone = false;
    while (Date.now() < deadline && !orphansGone) {
      const tempThere = await access(orphanTemp).then(
        () => true,
        () => false,
      );
      const metaThere = await access(orphanMeta).then(
        () => true,
        () => false,
      );
      orphansGone = !tempThere && !metaThere;
      if (!orphansGone) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(orphansGone, "stale crash-temp and orphan sidecar are reaped with both knobs off");
    await access(validFile); // throws if the sweep wrongly touched the ancient-but-valid file
  } finally {
    await server.close();
    if (saved.ttl === undefined) delete process.env.LAVISH_AXI_ATTACHMENT_TTL_MS;
    else process.env.LAVISH_AXI_ATTACHMENT_TTL_MS = saved.ttl;
    if (saved.disk === undefined) delete process.env.LAVISH_AXI_MAX_ATTACHMENT_DISK_MB;
    else process.env.LAVISH_AXI_MAX_ATTACHMENT_DISK_MB = saved.disk;
    await rm(dir, { recursive: true, force: true });
  }
});

test("the attachment-frame route serves an INERT capture page with NO capability token (R12)", async () => {
  // R12: the finding was that /attachment-frame handed out a signed token any frame
  // (including one the artifact minted) could authenticate with. The route now serves
  // a token-free static page; the chrome binds the frame it created by identity, so
  // loading this page grants an artifact nothing. There is no attachment-channel route.
  await withSession(async ({ base, key }) => {
    const html = await fetch(`${base}/attachment-frame`).then((res) => res.text());
    assert.doesNotMatch(html, /channelToken/, "the page carries no capability token");
    assert.match(html, /id="zone"/, "it is still the capture UI");
    // The old authenticate route is gone (no mintable capability to authenticate).
    const gone = await fetch(`${base}/api/${key}/attachment-channel`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ token: "anything" }),
    });
    assert.equal(gone.status, 404, "the attachment-channel authenticate route no longer exists");
  });
});
