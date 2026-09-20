import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, open, readFile, unlink, writeFile, link, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { sameFileIdentity } from "./verified-local-file.js";

const PAGE_PROOF_DOMAIN = "page-v1";
const HISTORICAL_DESTINATION_DOMAIN = "historical-destination-v1";
const PAGE_PROOF_KEY_BYTES = 32;
const PAGE_PROOF_MAC_BYTES = 32;
const PAGE_PROOF_MAX_PAGE_BYTES = 16 * 1024;
const HISTORICAL_DESTINATION_MAX_URL_BYTES = 64 * 1024;
const HISTORICAL_DESTINATION_MAX_DOCUMENT_BYTES = 512;
const HISTORICAL_DESTINATION_MAX_RECEIPT_BYTES = 128 * 1024;
const execFileAsync = promisify(execFile);
const artifactPageIdentities = new WeakMap();
const pageProofKeyIdentities = new WeakMap();
const WINDOWS_PAGE_PROOF_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$operation = $args[0]
$target = $args[1]
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.AccessControlType]::Allow
)
if ($operation -eq 'create') {
  $security = [System.Security.AccessControl.FileSecurity]::new()
  $security.SetOwner($sid)
  $security.SetAccessRuleProtection($true, $false)
  [void]$security.AddAccessRule($rule)
  $stream = [System.IO.FileStream]::new(
    $target,
    [System.IO.FileMode]::CreateNew,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.IO.FileShare]::None,
    4096,
    [System.IO.FileOptions]::WriteThrough,
    $security
  )
  try {
    $bytes = [byte[]]::new(${PAGE_PROOF_KEY_BYTES})
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
  exit 0
}
$acl = Get-Acl -LiteralPath $target
$ownerSid = try {
  ([System.Security.Principal.NTAccount]::new($acl.Owner)).Translate(
    [System.Security.Principal.SecurityIdentifier]
  ).Value
} catch {
  [System.Security.Principal.SecurityIdentifier]::new($acl.Owner).Value
}
$rules = @($acl.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
))
$allows = @($rules | Where-Object {
  $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow
})
$foreignAllows = @($allows | Where-Object { $_.IdentityReference.Value -ne $sid.Value })
$ownerAllows = @($allows | Where-Object { $_.IdentityReference.Value -eq $sid.Value })
if (-not $acl.AreAccessRulesProtected -or $ownerSid -ne $sid.Value -or
    $foreignAllows.Count -ne 0 -or $ownerAllows.Count -eq 0) {
  throw 'the file ACL is not owner-only'
}
Write-Output 'PAGE_PROOF_ACL_OK'
`;

export function pageProofKeyPath(stateDir) {
  return path.join(path.resolve(String(stateDir)), "page-proof.key");
}

export function pageProofKeyIdentity(key) {
  return pageProofKeyIdentities.get(key) || null;
}

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

// Only the server's canonical saved entry may use a literal POSIX backslash.
// This is not a sibling-path normalizer; callers must supply the saved file,
// never an identity taken from a request.
export function normalizeReviewPageIdentity(page, entryFile = "") {
  if (
    path.sep === "/" &&
    entryFile &&
    page === path.basename(entryFile) &&
    typeof page === "string" &&
    page.includes("\\") &&
    !page.includes("\0") &&
    Buffer.byteLength(page, "utf8") <= PAGE_PROOF_MAX_PAGE_BYTES
  )
    return page;
  return normalizePageIdentity(page);
}

function proofPayload(sessionKey, canonicalRoot, page, entryFile) {
  const normalizedPage = normalizeReviewPageIdentity(page, entryFile);
  if (!normalizedPage) return null;
  const domain = normalizedPage.includes("\\") ? "saved-entry-v1" : PAGE_PROOF_DOMAIN;
  return JSON.stringify([domain, String(sessionKey), rootDigest(canonicalRoot), normalizedPage]);
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
export function signPageProof(key, sessionKey, canonicalRoot, page, entryFile = "") {
  if (!Buffer.isBuffer(key) || key.length !== PAGE_PROOF_KEY_BYTES) {
    throw new TypeError("page proof key must be exactly 32 bytes");
  }
  const payload = proofPayload(sessionKey, canonicalRoot, page, entryFile);
  if (!payload) throw new TypeError("invalid page identity");
  return crypto.createHmac("sha256", key).update(payload, "utf8").digest("base64url");
}

/** Verify a proof without touching the filesystem. Source reads still require fresh resolution. */
export function verifyPageProof(key, sessionKey, canonicalRoot, page, proof, entryFile = "") {
  if (!Buffer.isBuffer(key) || key.length !== PAGE_PROOF_KEY_BYTES) return false;
  const expectedPayload = proofPayload(sessionKey, canonicalRoot, page, entryFile);
  const actual = decodeProof(proof);
  if (!expectedPayload || !actual) return false;
  const expected = crypto.createHmac("sha256", key).update(expectedPayload, "utf8").digest();
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function historicalDestinationPayload(sessionKey, canonicalRoot, page, route, url, documentId, entryFile) {
  const normalizedPage = normalizeReviewPageIdentity(page, entryFile);
  if (
    !normalizedPage ||
    normalizedPage !== page ||
    typeof route !== "string" ||
    !route ||
    Buffer.byteLength(route, "utf8") > PAGE_PROOF_MAX_PAGE_BYTES ||
    typeof url !== "string" ||
    !url ||
    Buffer.byteLength(url, "utf8") > HISTORICAL_DESTINATION_MAX_URL_BYTES ||
    typeof documentId !== "string" ||
    !documentId ||
    Buffer.byteLength(documentId, "utf8") > HISTORICAL_DESTINATION_MAX_DOCUMENT_BYTES
  )
    return null;
  return [
    HISTORICAL_DESTINATION_DOMAIN,
    String(sessionKey),
    rootDigest(canonicalRoot),
    normalizedPage,
    route,
    url,
    documentId,
  ];
}

export function signHistoricalDestinationReceipt(
  key,
  sessionKey,
  canonicalRoot,
  { page, route, url, documentId },
  entryFile = "",
) {
  if (!Buffer.isBuffer(key) || key.length !== PAGE_PROOF_KEY_BYTES) {
    throw new TypeError("page proof key must be exactly 32 bytes");
  }
  const payload = historicalDestinationPayload(sessionKey, canonicalRoot, page, route, url, documentId, entryFile);
  if (!payload) throw new TypeError("invalid historical destination");
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = crypto.createHmac("sha256", key).update(encoded, "utf8").digest("base64url");
  return `${encoded}.${mac}`;
}

export function verifyHistoricalDestinationReceipt(
  key,
  sessionKey,
  canonicalRoot,
  receipt,
  documentId,
  entryFile = "",
) {
  if (
    !Buffer.isBuffer(key) ||
    key.length !== PAGE_PROOF_KEY_BYTES ||
    typeof receipt !== "string" ||
    Buffer.byteLength(receipt, "utf8") > HISTORICAL_DESTINATION_MAX_RECEIPT_BYTES
  )
    return null;
  const parts = receipt.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0])) return null;
  const actual = decodeProof(parts[1]);
  if (!actual) return null;
  const expected = crypto.createHmac("sha256", key).update(parts[0], "utf8").digest();
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  let parsed;
  try {
    const decoded = Buffer.from(parts[0], "base64url");
    if (decoded.toString("base64url") !== parts[0]) return null;
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 7) return null;
  const [domain, receiptSession, receiptRoot, page, route, url, receiptDocument] = parsed;
  const canonical = historicalDestinationPayload(
    sessionKey,
    canonicalRoot,
    page,
    route,
    url,
    receiptDocument,
    entryFile,
  );
  if (
    !canonical ||
    domain !== HISTORICAL_DESTINATION_DOMAIN ||
    receiptSession !== String(sessionKey) ||
    receiptRoot !== rootDigest(canonicalRoot) ||
    receiptDocument !== documentId ||
    JSON.stringify(canonical) !== JSON.stringify(parsed)
  )
    return null;
  return { page, route, url, documentId: receiptDocument };
}

export {
  HISTORICAL_DESTINATION_DOMAIN,
  PAGE_PROOF_DOMAIN,
  PAGE_PROOF_KEY_BYTES,
  PAGE_PROOF_MAX_PAGE_BYTES,
};

function pageProofKeyError(file, detail) {
  return new Error(
    `Unable to use page-proof key ${file}: ${detail}. Restore the original key; regenerating it invalidates existing queued page proofs.`,
  );
}

async function windowsPageProofAcl(file, operation) {
  const result = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PAGE_PROOF_ACL_SCRIPT, operation, file],
    { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 },
  );
  if (operation === "verify" && String(result.stdout || "").trim() !== "PAGE_PROOF_ACL_OK") {
    throw new Error("the file ACL could not be verified as owner-only");
  }
}

async function readExistingPageProofKey(file, { platform, windowsAcl }) {
  let details;
  try {
    details = await lstat(file, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw pageProofKeyError(file, error?.message || String(error));
  }
  if (!details.isFile()) throw pageProofKeyError(file, "the path is not a regular file");
  if (platform === "win32") {
    try {
      await windowsAcl(file, "verify");
    } catch (error) {
      throw pageProofKeyError(file, error?.message || String(error));
    }
  } else if ((details.mode & 0o077n) !== 0n) {
    throw pageProofKeyError(file, "the file is not owner-only (expected mode 0600)");
  }
  let handle;
  let value;
  try {
    handle = await open(file, "r");
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileIdentity(details, opened)) {
      throw new Error("the file changed while it was opened");
    }
    value = await handle.readFile();
    pageProofKeyIdentities.set(value, { dev: opened.dev, ino: opened.ino });
  } catch (error) {
    throw pageProofKeyError(file, error?.message || String(error));
  } finally {
    await handle?.close();
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
export async function loadPageProofKey(
  stateDir,
  { platform = process.platform, windowsAcl = windowsPageProofAcl } = {},
) {
  const directory = path.resolve(String(stateDir));
  const file = pageProofKeyPath(directory);
  await mkdir(directory, { recursive: true });
  const existing = await readExistingPageProofKey(file, { platform, windowsAcl });
  if (existing) return existing;

  const temporary = path.join(directory, `.page-proof.key.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    if (platform === "win32") {
      try {
        await windowsAcl(temporary, "create");
        await windowsAcl(temporary, "verify");
      } catch (error) {
        throw pageProofKeyError(file, error?.message || String(error));
      }
      const created = await readFile(temporary);
      if (created.length !== PAGE_PROOF_KEY_BYTES) {
        throw pageProofKeyError(file, `the new key must contain exactly ${PAGE_PROOF_KEY_BYTES} bytes`);
      }
    } else {
      await writeFile(temporary, crypto.randomBytes(PAGE_PROOF_KEY_BYTES), { flag: "wx", mode: 0o600 });
      await chmod(temporary, 0o600);
    }
    try {
      await link(temporary, file);
    } catch (error) {
      if (error?.code !== "EEXIST") throw pageProofKeyError(file, error?.message || String(error));
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
  const winner = await readExistingPageProofKey(file, { platform, windowsAcl });
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
 * @param {{ entryFile?: string, statFile?: typeof stat }} [options]
 * @returns {Promise<{file: string | null, reason: "ok" | "missing" | "forbidden", page: string | null, servedRoute: string | null}>}
 */
export async function resolveArtifactPage(root, assetPath, { entryFile = "", statFile = stat } = {}) {
  const result = (file, reason, page = null, servedRoute = null) => ({ file, reason, page, servedRoute });
  const isEntry = typeof entryFile === "string" && entryFile !== "" && assetPath === entryFile;
  if (
    isEntry &&
    path.sep === "/" &&
    assetPath.includes("\\") &&
    !assetPath.includes("/") &&
    !assetPath.includes("\0")
  ) {
    const entry = await resolveArtifactEntry(path.join(root, entryFile), { statFile });
    if (entry.reason === "ok") {
      entry.page = entryFile;
      entry.servedRoute = entryFile;
    }
    return entry;
  }
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
  if (!normalizePageIdentity(page)) return result(null, "forbidden");
  // Eligibility follows the canonical target, not merely an HTML-looking
  // symlink name. The saved entry is the sole extensionless exception because
  // CLI validation already established that exact route as the review target.
  if (!isEntry && !isArtifactHtmlPage(page)) return result(null, "forbidden");
  let details;
  try {
    details = await statFile(realFile, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return result(null, "missing");
    }
    throw error;
  }
  if (!details.isFile()) return result(null, "forbidden");
  let verifiedRealFile;
  try {
    verifiedRealFile = await realpath(realFile);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return result(null, "missing");
    }
    throw error;
  }
  if (verifiedRealFile !== realFile || !asRootRelative(realRoot, verifiedRealFile)) {
    return result(null, "forbidden");
  }
  const resolved = result(realFile, "ok", page, assetPath.split(path.sep).join("/"));
  artifactPageIdentities.set(resolved, { dev: details.dev, ino: details.ino });
  return resolved;
}

export async function resolveArtifactEntry(file, { statFile = stat } = {}) {
  const result = (resolvedFile, reason) => ({ file: resolvedFile, reason, page: null, servedRoute: null });
  const absolute = path.resolve(file);
  let canonical;
  try {
    canonical = await realpath(absolute);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return result(null, "missing");
    throw error;
  }
  if (canonical !== absolute) return result(null, "forbidden");
  let details;
  try {
    details = await statFile(canonical, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return result(null, "missing");
    throw error;
  }
  if (!details.isFile()) return result(null, "forbidden");
  let verified;
  try {
    verified = await realpath(canonical);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return result(null, "missing");
    throw error;
  }
  if (verified !== canonical) return result(null, "forbidden");
  const resolved = result(canonical, "ok");
  artifactPageIdentities.set(resolved, { dev: details.dev, ino: details.ino });
  return resolved;
}

/**
 * @param {{ file: string | null, reason: string }} resolution
 * @param {{ openFile?: typeof open }} [options]
 */
export async function readResolvedArtifactPage(resolution, { openFile = open } = {}) {
  const expected = artifactPageIdentities.get(resolution);
  if (!expected || resolution?.reason !== "ok" || !resolution.file) {
    throw Object.assign(new Error("artifact page resolution is not readable"), { code: "ARTIFACT_PAGE_CHANGED" });
  }
  const handle = await openFile(resolution.file, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw Object.assign(new Error("artifact page changed after resolution"), { code: "ARTIFACT_PAGE_CHANGED" });
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function canonicalArtifactRoot(root) {
  return realpath(path.resolve(root));
}
