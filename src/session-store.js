import crypto from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { AsyncMutex } from "./async-mutex.js";
import { normalizeMermaidNodeTarget } from "./mermaid-node.js";
import { EXCALIDRAW_SCENE_TARGET_TYPE, normalizeExcalidrawSceneTarget } from "./whiteboard-core.js";

// How long a just-delivered attachment stays referenced after `takeFeedback`
// hands its path to the agent. The sweeper's reference set is built from PENDING
// prompts, which delivery clears - so without this window an attachment that is
// TTL-expired or disk-cap-eligible becomes sweepable at the exact moment the agent
// starts reading it. It is a bounded read window, not a second lifetime: the TTL
// and the disk cap must still be able to reclaim delivered bytes eventually.
export const ATTACHMENT_DELIVERY_GRACE_MS = 60 * 60 * 1000; // 1 hour

// A whole POST /prompts batch is one user's queued annotations, so its total image
// count is small in every real use. Bounding it is what keeps the resolver work
// below O(payload size) while the store's global lock is held. It bounds ONE
// request; prompts accumulate across requests until a poll drains them, so it says
// nothing about how much a single delivery carries.
export const MAX_REQUEST_ATTACHMENT_REFS = 256;

// Bounds only the retained HISTORY of earlier deliveries - state.json is rewritten
// wholesale on every store operation, so the list cannot grow forever.
//
// It deliberately does NOT bound the current delivery. The invariant is structural,
// not numeric: whatever `takeFeedback` just handed the agent is retained in full,
// however large, and this cap only decides how much older history rides along. Any
// number chosen here would be wrong, because pending prompts accumulate across an
// unbounded number of accepted requests - so a single poll can legitimately deliver
// far more than any one request may queue. Trimming the current delivery to fit a
// constant is what reopens the hole this retention exists to close.
export const MAX_DELIVERED_ATTACHMENTS = 256;

export class SessionStore {
  constructor(file) {
    this.file = file;
    // One mutex serializes EVERY read-modify-write of `state.json`. `readState`
    // reads the whole file in one shot and `writeState` rewrites it wholesale, so
    // a lost update can only come from two mutators interleaving read/await/write.
    // Any method that reads then (after an `await`) writes must run under this lock
    // - otherwise a poll's `takeFeedback` can clear prompts in the window a
    // `queuePrompts` holds its pre-resolve snapshot open, then `queuePrompts` writes
    // the stale snapshot back and clobbers the take (E1). The server also runs its
    // attachment disk-lifecycle sections (upload finalize, delete, sweep) under this
    // same lock via `runExclusive`, so a reference snapshot taken by delete/sweep
    // stays consistent with `queuePrompts` (D5) - one lock covers state AND files.
    this.lock = new AsyncMutex();
  }

  // Shared critical-section entry point so the server's attachment lifecycle
  // operations serialize against every store mutation under the SAME lock.
  runExclusive(fn) {
    return this.lock.runExclusive(fn);
  }

  async listSessions() {
    const state = await this.readState();
    return Object.values(state.sessions).sort((a, b) => a.file.localeCompare(b.file));
  }

  async findByFile(file) {
    const absolute = await canonicalFile(file);
    const state = await this.readState();
    return state.sessions[sessionKey(absolute)] || null;
  }

  async findByKey(key) {
    const state = await this.readState();
    return state.sessions[key] || null;
  }

  async upsertSession(file, url) {
    // `canonicalFile` (a realpath) does not touch state, so resolve it before
    // taking the lock and keep only the read-modify-write inside the critical
    // section.
    const absolute = await canonicalFile(file);
    return this.lock.runExclusive(() => this.#upsertSessionLocked(absolute, url));
  }

  async #upsertSessionLocked(absolute, url) {
    const key = sessionKey(absolute);
    const state = await this.readState();
    const existing = state.sessions[key] || {};
    const existingPrompts = existing.prompts || [];
    const existingStatus = existing.status === "ended" ? "open" : existing.status || "open";
    const session = {
      key,
      file: absolute,
      url,
      status: existingStatus === "feedback" && existingPrompts.length === 0 ? "open" : existingStatus,
      pending_prompts: existing.pending_prompts || 0,
      prompts: existingPrompts,
      layout_warnings: [],
      delivered_layout_warning_keys: existing.delivered_layout_warning_keys || [],
      // Carried across a reopen on purpose: this list is what keeps a just-delivered
      // attachment out of the sweeper's reach, and re-opening the artifact during the
      // grace window would otherwise erase that protection while the agent is still
      // reading the path. Every field this constructor omits is silently dropped, so
      // any new session field must be added here too.
      delivered_attachments: existing.delivered_attachments || [],
      dom_snapshot: existing.dom_snapshot || "",
      chat: existing.chat || [],
      updated_at: new Date().toISOString(),
    };
    state.sessions[key] = session;
    await this.writeState(state);
    return session;
  }

  // `options.resolveAttachment(key, id) => Promise<metadata|null>` is the trust
  // boundary for image attachments: a prompt only ever carries the client's
  // claimed `id` (and display `name`); every authoritative field (absolute path,
  // mime, byte size, dimensions) is re-derived from disk here, so a crafted
  // `/prompts` POST cannot point an attachment at an arbitrary file. Without a
  // resolver, unresolved attachments are dropped rather than trusted.
  async queuePrompts(key, payload, options = {}) {
    // The whole read -> resolve -> write path runs under the store's single lock so
    // it is atomic against a concurrent poll's `takeFeedback` / `recordLayoutWarnings`
    // (E1) AND against the sweeper's reference snapshot + delete and upload finalize,
    // which the server runs under the same lock via `runExclusive` (D5).
    return this.lock.runExclusive(() => this.#queuePromptsLocked(key, payload, options));
  }

  async #queuePromptsLocked(key, payload, options) {
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) {
      return null;
    }
    const prompts = Array.isArray(payload.prompts) ? payload.prompts : [];
    const shouldEndSession = Boolean(payload.endSession || payload.end_session);
    const alreadyEnded = session.status === "ended";
    const normalized = prompts.map(normalizePrompt);
    const normalizedPrompts = normalized.map((entry) => entry.prompt);
    // Resolve every attachment BEFORE mutating anything. If any prompt's images
    // can't be fully honored - malformed, an unknown id, or over the per-prompt
    // count/byte cap - reject the WHOLE batch and persist nothing (C4). Silently
    // truncating here while returning success would drop images the user attached,
    // and the chrome would clear its queue believing they were delivered.
    const rejected = boundAttachmentRefs(normalized, options);
    if (!rejected.length) {
      // Resolve under the store mutex, so keep the work minimal: (1) a per-batch
      // metadata cache keyed by content-addressed id, so a prompt (or several) that
      // reference the SAME id resolve it once instead of re-reading a multi-MB image
      // per reference; (2) short-circuit on the first rejection - the batch already
      // fails atomically (C4), so resolving the remaining prompts is pure wasted I/O
      // while every poll and mutation blocks on the mutex.
      const metaCache = new Map();
      for (const prompt of normalizedPrompts) {
        const { resolved, rejected: promptRejected } = await resolvePromptAttachments(
          prompt.attachments,
          key,
          options,
          metaCache,
        );
        if (promptRejected.length) {
          rejected.push(...promptRejected);
          break;
        }
        if (resolved.length > 0) prompt.attachments = resolved;
        else delete prompt.attachments;
      }
    }
    if (rejected.length) {
      return {
        rejected: rejected.slice(0, MAX_REPORTED_ATTACHMENT_REJECTIONS),
        caps: {
          maxPerPrompt: Number.isFinite(options.maxPerPrompt) ? options.maxPerPrompt : null,
          maxPromptBytes: Number.isFinite(options.maxPromptBytes) ? options.maxPromptBytes : null,
        },
      };
    }
    const userMessages = normalizedPrompts
      .filter((prompt) => prompt.tag === "message" && prompt.prompt)
      .map((prompt) => ({ role: "user", text: prompt.prompt, at: new Date().toISOString() }));
    session.prompts = [...(session.prompts || []), ...normalizedPrompts];
    session.chat = [...(session.chat || []), ...userMessages];
    session.pending_prompts = session.prompts.length;
    session.dom_snapshot = String(payload.domSnapshot || payload.dom_snapshot || "");
    session.status = shouldEndSession || alreadyEnded ? "ended" : "feedback";
    if (shouldEndSession) session.ended_by = "user";
    session.updated_at = new Date().toISOString();
    await this.writeState(state);
    return session;
  }

  async recordLayoutWarnings(key, payload) {
    return this.lock.runExclusive(() => this.#recordLayoutWarningsLocked(key, payload));
  }

  async #recordLayoutWarningsLocked(key, payload) {
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) {
      return null;
    }
    const deliveredWarningKeys = session.delivered_layout_warning_keys || [];
    const deliveredKeys = new Set(deliveredWarningKeys);
    const layoutWarnings = normalizeLayoutWarnings(
      payload.layout_warnings || payload.layoutWarnings || [],
      deliveredKeys,
    );
    const activeWarningKeys = new Set(layoutWarnings.map(layoutWarningKey));
    const nextDeliveredWarningKeys = deliveredWarningKeys.filter((key) => activeWarningKeys.has(key)).slice(-200);
    const deliveredKeysChanged =
      nextDeliveredWarningKeys.length !== deliveredWarningKeys.length ||
      nextDeliveredWarningKeys.some((key, index) => key !== deliveredWarningKeys[index]);
    const previousSignature = JSON.stringify(session.layout_warnings || []);
    const nextSignature = JSON.stringify(layoutWarnings);
    const warningsChanged = previousSignature !== nextSignature;
    if (!warningsChanged && !deliveredKeysChanged) {
      return { session, changed: false, hasWarnings: layoutWarnings.length > 0 };
    }
    session.layout_warnings = layoutWarnings;
    session.delivered_layout_warning_keys = nextDeliveredWarningKeys;
    if (layoutWarnings.length > 0 && session.status !== "ended") {
      session.status = "feedback";
    } else if ((session.prompts || []).length === 0 && session.status !== "ended") {
      session.status = "open";
    }
    session.updated_at = new Date().toISOString();
    await this.writeState(state);
    return { session, changed: warningsChanged, hasWarnings: layoutWarnings.length > 0 };
  }

  async takeFeedback(key) {
    return this.lock.runExclusive(() => this.#takeFeedbackLocked(key));
  }

  async #takeFeedbackLocked(key) {
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) {
      return { status: "missing" };
    }
    // Prompts queued before the session ended (a browser send-and-end) must still reach the
    // agent, so deliver them before reporting the ended state; the next poll then sees ended.
    const prompts = session.prompts || [];
    const layoutWarnings = session.layout_warnings || [];
    const alreadyEnded = session.status === "ended";
    if (prompts.length === 0 && layoutWarnings.length === 0) {
      return alreadyEnded ? { status: "ended", ended_by: session.ended_by } : { status: "waiting" };
    }
    const result = {
      status: "feedback",
      dom_snapshot: session.dom_snapshot || "",
      prompts,
      ...(layoutWarnings.length > 0 ? { layout_warnings: layoutWarnings } : {}),
      // This is the final delivery before the session shows as ended - flag it so the agent
      // knows not to expect (or force) a reopened browser afterward.
      ...(alreadyEnded ? { session_ended: true, ended_by: session.ended_by } : {}),
    };
    // Delivery clears the pending prompts, which is what the sweeper reads to build
    // its reference set - so remember what was just handed over. Without this, an
    // attachment can be reaped in the window between this response leaving and the
    // agent opening the path it was given.
    const deliveredNow = Date.now();
    // Every id in THIS delivery, deduped: storage is content-addressed, so the same
    // image referenced twice is one file and needs one entry.
    const deliveredIds = new Set();
    for (const prompt of prompts) {
      for (const attachment of prompt.attachments || []) {
        if (attachment && attachment.id) deliveredIds.add(attachment.id);
      }
    }
    // Earlier deliveries still inside their grace and not re-delivered now. These are
    // the only entries the cap may drop, oldest first - never the current delivery,
    // whose paths the agent is reading right now.
    const carried = (session.delivered_attachments || [])
      .filter(
        (entry) =>
          entry &&
          entry.id &&
          !deliveredIds.has(entry.id) &&
          deliveredNow - Number(entry.at) <= ATTACHMENT_DELIVERY_GRACE_MS,
      )
      .map((entry) => ({ id: entry.id, at: Number(entry.at) }))
      .sort((a, b) => a.at - b.at);
    const current = [...deliveredIds].map((id) => ({ id, at: deliveredNow }));
    const historyRoom = Math.max(0, MAX_DELIVERED_ATTACHMENTS - current.length);
    session.delivered_attachments = [...carried.slice(-historyRoom), ...current];
    session.prompts = [];
    session.layout_warnings = [];
    session.pending_prompts = 0;
    session.dom_snapshot = "";
    if (layoutWarnings.length > 0) {
      const deliveredKeys = new Set(session.delivered_layout_warning_keys || []);
      for (const warning of layoutWarnings) deliveredKeys.add(layoutWarningKey(warning));
      session.delivered_layout_warning_keys = [...deliveredKeys].slice(-200);
    }
    if (!alreadyEnded) {
      session.status = "open";
    }
    session.updated_at = new Date().toISOString();
    await this.writeState(state);
    return result;
  }

  // `endedBy` distinguishes a human ending review from the browser chrome ("user") from an
  // agent explicitly closing the loop via `lavish-axi end` ("agent"). Only a user-initiated end
  // blocks a plain reopen - see `SessionStore` callers in server.js.
  async endSession(key, endedBy = "agent") {
    return this.lock.runExclusive(() => this.#endSessionLocked(key, endedBy));
  }

  async #endSessionLocked(key, endedBy) {
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) {
      return null;
    }
    const existingEndedBy = session.status === "ended" ? session.ended_by : undefined;
    const nextEndedBy = endedBy === "user" || existingEndedBy === "user" ? "user" : "agent";
    session.status = "ended";
    session.ended_by = nextEndedBy;
    session.updated_at = new Date().toISOString();
    await this.writeState(state);
    return session;
  }

  async addAgentReply(key, text) {
    return this.lock.runExclusive(() => this.#addAgentReplyLocked(key, text));
  }

  async #addAgentReplyLocked(key, text) {
    const state = await this.readState();
    const session = state.sessions[key];
    if (!session) {
      return null;
    }
    session.chat = [...(session.chat || []), { role: "agent", text: String(text || ""), at: new Date().toISOString() }];
    session.updated_at = new Date().toISOString();
    await this.writeState(state);
    return session;
  }

  // `key/id` strings for every attachment still referenced by a pending prompt,
  // across all sessions. The attachment sweeper and delete use this so they never
  // reap a file that belongs to a queued-but-undelivered prompt. Delivered prompts
  // are cleared from `prompts` by takeFeedback, so their attachments become
  // sweep-eligible. This is a pure read and must NOT take `this.lock`: the server
  // calls it from inside `runExclusive`, so self-locking would deadlock; running it
  // there keeps its snapshot atomic with the subsequent disk delete.
  // Every attachment the sweeper must not touch: those still queued on a pending
  // prompt, plus those handed to the agent within the delivery grace window.
  async referencedAttachmentIds({ now = Date.now() } = {}) {
    const state = await this.readState();
    const referenced = new Set();
    for (const session of Object.values(state.sessions)) {
      for (const prompt of session.prompts || []) {
        for (const attachment of prompt.attachments || []) {
          if (attachment && attachment.id) referenced.add(`${session.key}/${attachment.id}`);
        }
      }
      for (const delivered of session.delivered_attachments || []) {
        if (!delivered || !delivered.id) continue;
        if (now - Number(delivered.at) <= ATTACHMENT_DELIVERY_GRACE_MS) {
          referenced.add(`${session.key}/${delivered.id}`);
        }
      }
    }
    return referenced;
  }

  async readState() {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      return { sessions: parsed.sessions || {} };
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { sessions: {} };
      }
      throw error;
    }
  }

  async writeState(state) {
    await writeFile(this.file, `${JSON.stringify(state, null, 2)}\n`);
  }
}

export async function canonicalFile(file) {
  const absolute = path.resolve(file);
  return realpath(absolute);
}

export function sessionKey(file) {
  return crypto.createHash("sha256").update(file).digest("hex").slice(0, 16);
}

// Returns `{ prompt, malformed }`: `malformed` is non-empty when the payload's
// `attachments` field exists but cannot be honored as written, which fails the
// whole batch rather than being normalized away (C4, see queuePrompts).
function normalizePrompt(prompt) {
  const normalized = {
    uid: String(prompt.uid || ""),
    prompt: String(prompt.prompt || ""),
    selector: String(prompt.selector || ""),
    tag: String(prompt.tag || ""),
    text: String(prompt.text || ""),
  };
  const target = normalizeTarget(prompt.target);
  if (target) normalized.target = target;
  const { refs, malformed } = normalizeAttachmentRefs(prompt.attachments);
  if (refs.length > 0) normalized.attachments = refs;
  return { prompt: normalized, malformed };
}

// Client-supplied attachment refs are stripped to just the fields the client is
// allowed to influence: the content-hash `id` and a display-only `name`. Path,
// mime, size, and dimensions are never taken from the payload (see queuePrompts).
//
// Anything that cannot be read as a ref is reported as `malformed` rather than
// skipped: dropping it here would let the POST succeed while the images the user
// attached never arrive, and the chrome would clear its queue believing they were
// delivered. An ABSENT field is not malformed - it just means no images.
function normalizeAttachmentRefs(value) {
  if (value === undefined) return { refs: [], malformed: [] };
  if (!Array.isArray(value)) return { refs: [], malformed: [{ id: "", name: "", reason: "malformed" }] };
  const refs = [];
  const malformed = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      malformed.push({ id: "", name: "", reason: "malformed" });
      continue;
    }
    const name = item.name === undefined || item.name === null ? "" : String(item.name).slice(0, 200);
    const id = String(item.id || "");
    if (!id) {
      malformed.push({ id: "", name, reason: "malformed" });
      continue;
    }
    refs.push(name ? { id, name } : { id });
  }
  return { refs, malformed };
}

// Rejections are reported back to the chrome, so the list must not itself become
// a payload amplifier for a crafted batch.
const MAX_REPORTED_ATTACHMENT_REJECTIONS = 4;

// The cheap gate that must run BEFORE `resolvePromptAttachments` touches the
// filesystem: every check here is pure arithmetic over the parsed payload.
//
// The per-prompt cap inside the resolver counts RESOLVED refs, which a crafted
// batch never advances - thousands of well-formed ids for files that don't exist
// each cost a sequential `stat` and the count stays at zero. Because the whole
// path runs under the store's single mutex (E1/D5), that stalls polling and every
// state mutation. Counting the RAW refs first bounds the work a caller can buy.
function boundAttachmentRefs(normalized, options) {
  const maxPerPrompt = Number.isFinite(options.maxPerPrompt) ? options.maxPerPrompt : Infinity;
  const malformed = normalized.flatMap((entry) => entry.malformed);
  if (malformed.length) return malformed;

  // Per-prompt first: it is the more specific diagnosis, and the chrome turns it
  // into actionable wording ("more than N images on one annotation"). A single
  // crafted prompt trips both caps, and that message is the useful one.
  const rejected = [];
  for (const { prompt } of normalized) {
    const refs = prompt.attachments || [];
    // One rejection per over-cap prompt, not one per crafted ref.
    if (refs.length > maxPerPrompt) {
      rejected.push({ id: refs[0]?.id || "", name: refs[0]?.name || "", reason: "too-many" });
    }
  }
  if (rejected.length) return rejected;

  let requestRefs = 0;
  for (const { prompt } of normalized) requestRefs += prompt.attachments?.length || 0;
  if (requestRefs > MAX_REQUEST_ATTACHMENT_REFS) {
    return [{ id: "", name: "", reason: "too-many-in-request" }];
  }
  return rejected;
}

// Replace each client ref with server-vetted metadata, enforcing the per-prompt
// count and total-byte caps. Returns `{ resolved, rejected }`: every ref that
// can't be honored (unknown id, over the count cap, or over the total-byte cap)
// is reported in `rejected` with a machine-readable `reason` rather than silently
// dropped, so the caller can fail the batch atomically (C4). The display `name` is
// the only client value carried through (it never touches a filesystem path).
async function resolvePromptAttachments(refs, key, options = {}, metaCache = new Map()) {
  const { resolveAttachment, maxPerPrompt = Infinity, maxPromptBytes = Infinity } = options;
  if (!Array.isArray(refs) || refs.length === 0 || typeof resolveAttachment !== "function") {
    return { resolved: [], rejected: [] };
  }
  const resolved = [];
  const rejected = [];
  let totalBytes = 0;
  for (const ref of refs) {
    if (resolved.length >= maxPerPrompt) {
      rejected.push({ id: ref.id, name: ref.name || "", reason: "too-many" });
      continue;
    }
    // Content-addressed id -> the file's metadata is immutable, so cache it per batch:
    // repeated references to the same id (in this prompt or another) never re-read the
    // image. A `null` (not-found) is cached too, so a missing id is statted once.
    let metadata = metaCache.get(ref.id);
    if (metadata === undefined) {
      metadata = await resolveAttachment(key, ref.id);
      metaCache.set(ref.id, metadata);
    }
    if (!metadata) {
      rejected.push({ id: ref.id, name: ref.name || "", reason: "not-found" });
      continue;
    }
    const bytes = Number(metadata.bytes) || 0;
    if (totalBytes + bytes > maxPromptBytes) {
      rejected.push({ id: ref.id, name: ref.name || "", reason: "prompt-bytes-exceeded" });
      continue;
    }
    totalBytes += bytes;
    resolved.push(ref.name ? { ...metadata, name: ref.name } : metadata);
  }
  return { resolved, rejected };
}

function layoutWarningKey(warning) {
  const viewportWidth = normalizeFiniteNumber(warning.viewportWidth);
  const viewportClass = viewportWidth <= 640 ? "mobile" : viewportWidth <= 1024 ? "compact" : "desktop";
  const overflowPx = normalizeFiniteNumber(warning.overflowPx);
  const magnitude =
    overflowPx <= 0
      ? "none"
      : overflowPx < 24
        ? "small"
        : overflowPx < 64
          ? "medium"
          : overflowPx < 160
            ? "large"
            : "extreme";
  return `${warning.kind}:${warning.selector}:${warning.axis || ""}:${viewportClass}:${magnitude}`;
}

// A finding whose key was already delivered to the agent in a prior poll is marked persistent
// so the agent can tell a fix attempt didn't clear it, instead of treating a reload's re-report
// of the identical warning as fresh.
function normalizeLayoutWarnings(layoutWarnings, deliveredKeys = new Set()) {
  if (!Array.isArray(layoutWarnings)) return [];
  return layoutWarnings
    .filter(
      (warning) =>
        warning &&
        typeof warning === "object" &&
        !Array.isArray(warning) &&
        String(warning.severity || "").toLowerCase() === "error",
    )
    .map((warning) => {
      const selector = String(warning.selector || "");
      const kind = String(warning.kind || "layout-failure");
      const axis = warning.axis === "vertical" ? "vertical" : warning.axis === "horizontal" ? "horizontal" : undefined;
      return {
        selector,
        kind,
        ...(axis ? { axis } : {}),
        overflowPx: normalizeFiniteNumber(warning.overflowPx),
        viewportWidth: normalizeFiniteNumber(warning.viewportWidth),
        severity: "error",
        persistent: deliveredKeys.has(
          layoutWarningKey({
            kind,
            selector,
            axis,
            overflowPx: warning.overflowPx,
            viewportWidth: warning.viewportWidth,
          }),
        ),
      };
    });
}

function normalizeFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  if (target.type === "mermaid-node") return normalizeMermaidNodeTarget(target);
  if (target.type === EXCALIDRAW_SCENE_TARGET_TYPE) return normalizeExcalidrawSceneTarget(target);
  // text-range and any other/legacy target shapes pass through unchanged.
  return JSON.parse(JSON.stringify(target));
}
