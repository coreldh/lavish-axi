import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadPageProofKey, normalizePageIdentity, signPageProof, verifyPageProof } from "../src/artifact-page.js";

test("page proofs bind the session, canonical root, and normalized page", () => {
  const key = Buffer.alloc(32, 7);
  const proof = signPageProof(key, "session-1", "/tmp/root", "sub/./page.html");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const finalIndex = alphabet.indexOf(proof.at(-1));
  const nonCanonicalAlias = proof.slice(0, -1) + alphabet[finalIndex + 1];

  assert.equal(typeof proof, "string");
  assert.notEqual(nonCanonicalAlias, proof);
  assert.deepEqual(Buffer.from(nonCanonicalAlias, "base64url"), Buffer.from(proof, "base64url"));
  assert.equal(verifyPageProof(key, "session-1", "/tmp/root", "sub/page.html", proof), true);
  assert.equal(verifyPageProof(key, "session-1", "/tmp/root", "sub/page.html", nonCanonicalAlias), false);
  assert.equal(verifyPageProof(key, "session-2", "/tmp/root", "sub/page.html", proof), false);
  assert.equal(verifyPageProof(key, "session-1", "/tmp/other", "sub/page.html", proof), false);
  assert.equal(verifyPageProof(key, "session-1", "/tmp/root", "other.html", proof), false);
  assert.equal(verifyPageProof(key, "session-1", "/tmp/root", "sub/page.html", `!${proof}`), false);
  assert.equal(verifyPageProof(key, "session-1", "/tmp/root", "sub/page.html", `${proof}!`), false);
  assert.equal(normalizePageIdentity("./sub/../page.html"), "page.html");
  assert.equal(normalizePageIdentity("../outside.html"), null);
  assert.equal(normalizePageIdentity("C:\\outside.html"), null);
});

test("page proof key is durable, owner-only, and concurrent initialization is race-safe", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-page-proof-"));
  try {
    const keys = await Promise.all(Array.from({ length: 16 }, () => loadPageProofKey(root)));
    const first = await readFile(path.join(root, "page-proof.key"));
    assert.equal(first.length, 32);
    for (const key of keys) assert.deepEqual(key, first);
    assert.equal((await stat(path.join(root, "page-proof.key"))).mode & 0o777, 0o600);
    assert.equal(await loadPageProofKey(root).then((key) => key.equals(first)), true);
    assert.equal(await stat(path.join(root, "state.json")).catch(() => null), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing corrupt page proof key fails without silent rotation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-page-proof-corrupt-"));
  const keyFile = path.join(root, "page-proof.key");
  try {
    await writeFile(keyFile, Buffer.alloc(31));
    await chmod(keyFile, 0o600);
    await assert.rejects(
      loadPageProofKey(root),
      /page-proof\.key.*exactly 32 bytes.*invalidates existing queued page proofs/i,
    );
    assert.equal((await readFile(keyFile)).length, 31);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows page proof keys are restricted and verified through ACLs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-page-proof-windows-"));
  const calls = [];
  const windowsAcl = async (file, operation) => {
    calls.push({ file, operation });
    if (operation === "create") {
      assert.equal(await stat(file).catch(() => null), null);
      await writeFile(file, Buffer.alloc(32, 11), { flag: "wx" });
    }
  };
  try {
    const key = await loadPageProofKey(root, { platform: "win32", windowsAcl });
    assert.equal(key.length, 32);
    assert.equal(calls[0].operation, "create");
    assert.match(path.basename(calls[0].file), /^\.page-proof\.key\..+\.tmp$/);
    assert.deepEqual(calls[1], { file: calls[0].file, operation: "verify" });
    assert.deepEqual(calls.at(-1), { file: path.join(root, "page-proof.key"), operation: "verify" });

    calls.length = 0;
    assert.deepEqual(await loadPageProofKey(root, { platform: "win32", windowsAcl }), key);
    assert.deepEqual(calls, [{ file: path.join(root, "page-proof.key"), operation: "verify" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows removes an incomplete atomic key creation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-page-proof-windows-failed-create-"));
  try {
    await assert.rejects(
      loadPageProofKey(root, {
        platform: "win32",
        windowsAcl: async (file, operation) => {
          if (operation !== "create") return;
          await writeFile(file, Buffer.alloc(1), { flag: "wx" });
          throw new Error("atomic creation failed");
        },
      }),
      /page-proof\.key.*atomic creation failed.*invalidates existing queued page proofs/i,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows rejects a page proof key whose ACL is not owner-only", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-page-proof-windows-open-"));
  const keyFile = path.join(root, "page-proof.key");
  try {
    await writeFile(keyFile, Buffer.alloc(32, 9));
    await assert.rejects(
      loadPageProofKey(root, {
        platform: "win32",
        windowsAcl: async () => {
          throw new Error("the file ACL is not owner-only");
        },
      }),
      /page-proof\.key.*ACL is not owner-only.*invalidates existing queued page proofs/i,
    );
    assert.deepEqual(await readFile(keyFile), Buffer.alloc(32, 9));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
