import crypto from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import { AsyncMutex } from "./async-mutex.js";
import { normalizeMermaidNodeTarget } from "./mermaid-node.js";
import { EXCALIDRAW_SCENE_TARGET_TYPE, normalizeExcalidrawSceneTarget } from "./whiteboard-core.js";

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
    const normalizedPrompts = prompts.map(normalizePrompt);
    // Resolve every attachment BEFORE mutating anything. If any prompt's images
    // can't be fully honored - an unknown id, or over the per-prompt count/byte
    // cap - reject the WHOLE batch and persist nothing (C4). Silently truncating
    // here while returning success would drop images the user attached, and the
    // chrome would clear its queue believing they were delivered.
    const rejected = [];
    for (const prompt of normalizedPrompts) {
      const { resolved, rejected: promptRejected } = await resolvePromptAttachments(prompt.attachments, key, options);
      if (promptRejected.length) rejected.push(...promptRejected);
      if (resolved.length > 0) prompt.attachments = resolved;
      else delete prompt.attachments;
    }
    if (rejected.length) {
      return {
        rejected,
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
  async referencedAttachmentIds() {
    const state = await this.readState();
    const referenced = new Set();
    for (const session of Object.values(state.sessions)) {
      for (const prompt of session.prompts || []) {
        for (const attachment of prompt.attachments || []) {
          if (attachment && attachment.id) referenced.add(`${session.key}/${attachment.id}`);
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
  const attachments = normalizeAttachmentRefs(prompt.attachments);
  if (attachments.length > 0) normalized.attachments = attachments;
  return normalized;
}

// Client-supplied attachment refs are stripped to just the fields the client is
// allowed to influence: the content-hash `id` and a display-only `name`. Path,
// mime, size, and dimensions are never taken from the payload (see queuePrompts).
function normalizeAttachmentRefs(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const refs = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = String(item.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = item.name === undefined || item.name === null ? "" : String(item.name).slice(0, 200);
    refs.push(name ? { id, name } : { id });
  }
  return refs;
}

// Replace each client ref with server-vetted metadata, enforcing the per-prompt
// count and total-byte caps. Returns `{ resolved, rejected }`: every ref that
// can't be honored (unknown id, over the count cap, or over the total-byte cap)
// is reported in `rejected` with a machine-readable `reason` rather than silently
// dropped, so the caller can fail the batch atomically (C4). The display `name` is
// the only client value carried through (it never touches a filesystem path).
async function resolvePromptAttachments(refs, key, options = {}) {
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
    const metadata = await resolveAttachment(key, ref.id);
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
  return `${warning.kind}:${warning.selector}`;
}

// A finding whose key was already delivered to the agent in a prior poll is marked persistent
// so the agent can tell a fix attempt didn't clear it, instead of treating a reload's re-report
// of the identical warning as fresh.
function normalizeLayoutWarnings(layoutWarnings, deliveredKeys = new Set()) {
  if (!Array.isArray(layoutWarnings)) return [];
  return layoutWarnings
    .filter((warning) => warning && typeof warning === "object" && !Array.isArray(warning))
    .map((warning) => {
      const selector = String(warning.selector || "");
      const kind = String(warning.kind || "layout-warning");
      return {
        selector,
        kind,
        overflowPx: normalizeFiniteNumber(warning.overflowPx),
        viewportWidth: normalizeFiniteNumber(warning.viewportWidth),
        severity: warning.severity === "warning" ? "warning" : "error",
        persistent: deliveredKeys.has(layoutWarningKey({ kind, selector })),
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
