import crypto from "node:crypto";
import { chmod, lstat, mkdir, readFile, unlink, writeFile, link, realpath, stat } from "node:fs/promises";
import path from "node:path";

const PAGE_PROOF_DOMAIN = "page-v1";
const PAGE_PROOF_KEY_BYTES = 32;
const PAGE_PROOF_MAC_BYTES = 32;
const PAGE_PROOF_MAX_PAGE_BYTES = 16 * 1024;

/**
 * A document reached through authored navigation is eligible for review only when it is a local
 * HTML document. The saved entry is handled separately because an entry may be extensionless
 * (or a symlink to an extensionless file) while CLI validation has already established it as the
 * session's review target.
 */
export function isArtifactHtmlPage(assetPath) {
  return typeof assetPath === "string" && /\.html?$/i.test(assetPath);
}

function asRootRelative(root, file) {
  const relative = path.relative(root, file);
  if (relative === "" || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

/** Normalize an already URL-decoded root-relative page identity. */
export function normalizePageIdentity(page) {
  if (typeof page !== "string" || page.length === 0 || Buffer.byteLength(page, "utf8") > PAGE_PROOF_MAX_PAGE_BYTES) {
    return null;
  }
  if (page.includes("\0") || page.includes("\\") || page.startsWith("/") || /^[A-Za-z]:[\\/]/.test(page)) {
    return null;
  }
  const parts = page.split("/");
  const normalized = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (normalized.length === 0) return null;
      normalized.pop();
      continue;
    }
    if (part.includes("\0") || part.includes("\\")) return null;
    normalized.push(part);
  }
  if (normalized.length === 0) return null;
  return normalized.join("/");
}

function rootDigest(canonicalRoot) {
  return crypto.createHash("sha256").update(String(canonicalRoot), "utf8").digest("hex");
}

function proofPayload(sessionKey, canonicalRoot, page) {
  const normalizedPage = normalizePageIdentity(page);
  if (!normalizedPage) return null;
  return JSON.stringify([PAGE_PROOF_DOMAIN, String(sessionKey), rootDigest(canonicalRoot), normalizedPage]);
}

function decodeProof(proof) {
  // A SHA-256 MAC has one canonical unpadded base64url representation: 43
  // characters. Reject permissive decoder aliases/trailing junk before decode.
  if (typeof proof !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(proof)) return null;
  try {
    const decoded = Buffer.from(proof, "base64url");
    if (decoded.length !== PAGE_PROOF_MAC_BYTES) return null;
    // Node's decoder accepts alternate final characters whose unused low bits differ but decode
    // to the same 32 bytes. Proofs are protocol credentials, so accept only the one canonical
    // spelling emitted by signPageProof instead of letting textual tampering survive decoding.
    if (decoded.toString("base64url") !== proof) return null;
    return decoded;
  } catch {
    return null;
  }
}

/** Create the fixed-size HMAC proof for an authoritative page identity. */
export function signPageProof(key, sessionKey, canonicalRoot, page) {
  if (!Buffer.isBuffer(key) || key.length !== PAGE_PROOF_KEY_BYTES) {
    throw new TypeError("page proof key must be exactly 32 bytes");
  }
  const payload = proofPayload(sessionKey, canonicalRoot, page);
  if (!payload) throw new TypeError("invalid page identity");
  return crypto.createHmac("sha256", key).update(payload, "utf8").digest("base64url");
}

/** Verify a proof without touching the filesystem. Source reads still require fresh resolution. */
export function verifyPageProof(key, sessionKey, canonicalRoot, page, proof) {
  if (!Buffer.isBuffer(key) || key.length !== PAGE_PROOF_KEY_BYTES) return false;
  const expectedPayload = proofPayload(sessionKey, canonicalRoot, page);
  const actual = decodeProof(proof);
  if (!expectedPayload || !actual) return false;
  const expected = crypto.createHmac("sha256", key).update(expectedPayload, "utf8").digest();
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export { PAGE_PROOF_DOMAIN, PAGE_PROOF_KEY_BYTES, PAGE_PROOF_MAX_PAGE_BYTES };

function pageProofKeyError(file, detail) {
  return new Error(
    `Unable to use page-proof key ${file}: ${detail}. Restore the original key; regenerating it invalidates existing queued page proofs.`,
  );
}

async function readExistingPageProofKey(file) {
  let details;
  try {
    details = await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw pageProofKeyError(file, error?.message || String(error));
  }
  if (!details.isFile()) throw pageProofKeyError(file, "the path is not a regular file");
  if ((details.mode & 0o077) !== 0) throw pageProofKeyError(file, "the file is not owner-only (expected mode 0600)");
  let value;
  try {
    value = await readFile(file);
  } catch (error) {
    throw pageProofKeyError(file, error?.message || String(error));
  }
  if (value.length !== PAGE_PROOF_KEY_BYTES) {
    throw pageProofKeyError(file, `the file must contain exactly ${PAGE_PROOF_KEY_BYTES} bytes`);
  }
  return value;
}

/**
 * Load the durable proof key, creating it exactly once on first use. The temporary file is fully
 * written before a hard-link installs it at the final name; this avoids a concurrent server ever
 * observing a partially-written key. Losing creators read the winning file instead.
 */
export async function loadPageProofKey(stateDir) {
  const directory = path.resolve(String(stateDir));
  const file = path.join(directory, "page-proof.key");
  await mkdir(directory, { recursive: true });
  const existing = await readExistingPageProofKey(file);
  if (existing) return existing;

  const temporary = path.join(directory, `.page-proof.key.${process.pid}.${crypto.randomUUID()}.tmp`);
  const candidate = crypto.randomBytes(PAGE_PROOF_KEY_BYTES);
  try {
    await writeFile(temporary, candidate, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    try {
      await link(temporary, file);
    } catch (error) {
      if (error?.code !== "EEXIST") throw pageProofKeyError(file, error?.message || String(error));
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
  const winner = await readExistingPageProofKey(file);
  if (!winner) throw pageProofKeyError(file, "the key disappeared during initialization");
  return winner;
}

/**
 * Resolve an authored HTML page to its canonical in-root regular file. Internal symlink aliases
 * are accepted and share the canonical target identity; any lexical or realpath escape is
 * classified as forbidden. Missing path components remain distinguishable from an escape.
 *
 * @param {string} root
 * @param {string} assetPath URL-decoded, root-relative route path
 * @param {{ entryFile?: string }} [options]
 * @returns {Promise<{file: string | null, reason: "ok" | "missing" | "forbidden", page: string | null, servedRoute: string | null}>}
 */
export async function resolveArtifactPage(root, assetPath, { entryFile = "" } = {}) {
  const result = (file, reason, page = null, servedRoute = null) => ({ file, reason, page, servedRoute });
  const isEntry = typeof entryFile === "string" && entryFile !== "" && assetPath === entryFile;
  if ((!isArtifactHtmlPage(assetPath) && !isEntry) || assetPath.includes("\0") || assetPath.includes("\\")) {
    return result(null, "forbidden");
  }
  if (path.isAbsolute(assetPath)) return result(null, "forbidden");

  const lexicalRoot = path.resolve(root);
  const lexicalFile = path.resolve(lexicalRoot, assetPath);
  const lexicalRelative = path.relative(lexicalRoot, lexicalFile);
  if (lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    return result(null, "forbidden");
  }

  let realRoot;
  let realFile;
  try {
    [realRoot, realFile] = await Promise.all([realpath(lexicalRoot), realpath(lexicalFile)]);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return result(null, "missing");
    }
    throw error;
  }

  const page = asRootRelative(realRoot, realFile);
  if (!page) return result(null, "forbidden");
  // Eligibility follows the canonical target, not merely an HTML-looking
  // symlink name. The saved entry is the sole extensionless exception because
  // CLI validation already established that exact route as the review target.
  if (!isEntry && !isArtifactHtmlPage(page)) return result(null, "forbidden");
  let details;
  try {
    details = await stat(realFile);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return result(null, "missing");
    }
    throw error;
  }
  if (!details.isFile()) return result(null, "forbidden");
  return result(realFile, "ok", page, assetPath.split(path.sep).join("/"));
}

export async function canonicalArtifactRoot(root) {
  return realpath(path.resolve(root));
}
