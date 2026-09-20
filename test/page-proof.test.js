import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
