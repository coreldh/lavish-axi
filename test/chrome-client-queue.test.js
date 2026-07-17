import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sourceUrl = new URL("../src/chrome-client.js", import.meta.url);

/** @typedef {{ key: string, file: string, layoutGateEnabled?: boolean, layoutGateMaxHoldMs?: number, modeToggleHotkeyKey?: string, attachmentMaxBytes?: number }} HarnessSessionData */
/** @type {HarnessSessionData} */
const defaultSessionData = { key: "abc", file: "/tmp/artifact.html", modeToggleHotkeyKey: "i" };

async function createChromeHarness({
  fetchImpl = async () => ({ ok: true }),
  sessionData = defaultSessionData,
  artifactSrc = "",
  storedQueue = null,
} = {}) {
  const source = await readFile(sourceUrl, "utf8");
  const storage = new Map();
  // Seed sessionStorage before the client boots, to model a tab whose queue was
  // already persisted by an earlier page load.
  if (storedQueue) storage.set(`lavish-axi:queued:${sessionData.key}`, JSON.stringify(storedQueue));
  const postedToFrame = [];
  const postedToWhiteboard = [];
  const inlineWhiteboards = [];
  const eventSources = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const elements = new Map();
  const timers = new Map();
  const srcLoads = [];
  let nextTimerId = 1;
  let reloadCount = 0;

  function fakeSetTimeout(fn, ms) {
    const timer = {
      id: nextTimerId++,
      ms,
      fn,
      unref() {},
    };
    timers.set(timer.id, timer);
    return timer;
  }

  function fakeClearTimeout(timer) {
    if (timer && typeof timer === "object") timers.delete(timer.id);
  }

  function runTimers(ms) {
    for (const timer of [...timers.values()]) {
      if (ms !== undefined && timer.ms !== ms) continue;
      timers.delete(timer.id);
      timer.fn();
    }
  }

  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map();
    const classes = new Set();
    const el = {
      id,
      hidden: false,
      disabled: false,
      value: "",
      innerHTML: "",
      textContent: "",
      scrollTop: 0,
      scrollHeight: 0,
      scrolledIntoView: null,
      dataset: {},
      onclick: null,
      classList: {
        add(...names) {
          for (const name of names) classes.add(name);
        },
        remove(...names) {
          for (const name of names) classes.delete(name);
        },
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : Boolean(force);
          if (enabled) classes.add(name);
          else classes.delete(name);
          return enabled;
        },
        contains(name) {
          return classes.has(name);
        },
        toString() {
          return [...classes].join(" ");
        },
      },
      style: {},
      setAttribute(name, value) {
        this[name] = String(value);
      },
      addEventListener(type, handler) {
        listeners.set(type, handler);
      },
      querySelectorAll() {
        return [];
      },
      querySelector(selector) {
        if (selector !== "span") return null;
        const childId = `${id}:span`;
        if (!elements.has(childId)) element(childId);
        return elements.get(childId);
      },
      appendChild(child) {
        child.parentElement = this;
        this.lastAppendedChild = child;
        return child;
      },
      click(event = {}) {
        this.clicked = true;
        if (typeof this.onclick === "function") return this.onclick(event);
        return undefined;
      },
      remove() {},
      focus() {
        this.focused = true;
      },
      select() {},
      scrollIntoView(options) {
        this.scrolledIntoView = options;
      },
      listeners,
    };
    elements.set(id, el);
    return el;
  }

  element("lavish-session").textContent = JSON.stringify(sessionData);
  const frame = element("artifact");
  frame.dataset.artifactSrc = artifactSrc;
  Object.defineProperty(frame, "src", {
    get() {
      return this.currentSrc || "";
    },
    set(value) {
      this.currentSrc = String(value);
      srcLoads.push({ src: this.currentSrc, hadMessageListener: windowListeners.has("message") });
    },
  });
  frame.contentWindow = {
    postMessage(message) {
      postedToFrame.push(message);
    },
  };
  const whiteboardFrame = element("whiteboardFrame");
  whiteboardFrame.contentWindow = {
    postMessage(message) {
      postedToWhiteboard.push(message);
    },
  };

  const context = {
    clearTimeout: fakeClearTimeout,
    console,
    fetch: fetchImpl,
    location: {
      reload() {
        reloadCount += 1;
      },
    },
    navigator: {},
    setTimeout: fakeSetTimeout,
    URL: {
      createObjectURL() {
        return "blob:lavish-test";
      },
      revokeObjectURL() {},
    },
    EventSource: class FakeEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        eventSources.push(this);
      }

      addEventListener(type, handler) {
        this.listeners.set(type, handler);
      }
    },
    document: {
      body: element("body"),
      getElementById(id) {
        return element(id);
      },
      addEventListener(type, handler, capture) {
        if (!documentListeners.has(type)) documentListeners.set(type, []);
        documentListeners.get(type).push({ handler, capture: Boolean(capture) });
      },
      createElement(tag) {
        const el = element(`${tag}-${elements.size}`);
        el.tagName = tag.toUpperCase();
        return el;
      },
      execCommand() {
        return true;
      },
    },
    sessionStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    window: {
      addEventListener(type, handler) {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(handler);
      },
    },
  };

  vm.runInNewContext(source, context, { filename: "chrome-client.js" });

  return {
    element,
    frame,
    postedToFrame,
    postedToWhiteboard,
    createInlineWhiteboard() {
      const posted = [];
      const source = {
        postMessage(message) {
          posted.push(message);
        },
      };
      const whiteboard = { source, posted };
      inlineWhiteboards.push(whiteboard);
      return whiteboard;
    },
    // A nested capture frame (root A): its own source window, its own posted-message
    // sink, and a `send` that dispatches a message to the chrome as if from that
    // frame (event.source === this frame's window). `ready(token)` binds the channel.
    createAttachmentFrame(token = "tok-" + Math.random().toString(36).slice(2)) {
      const posted = [];
      const source = {
        postMessage(message) {
          posted.push(message);
        },
      };
      const send = (data) => {
        const handlers = windowListeners.get("message") || [];
        assert.ok(handlers.length > 0, "chrome-client registered a message handler");
        for (const handler of handlers) handler({ source, data });
      };
      return {
        source,
        posted,
        token,
        send,
        ready: () => send({ type: "lavish-attachment:ready", channelToken: token }),
        upload: (message) => send({ type: "lavish-attachment:upload", channelId: token, ...message }),
        state: (message) => send({ type: "lavish-attachment:state", channelId: token, ...message }),
        result(localId) {
          return posted.find((m) => m.type === "lavish-attachment:uploadResult" && m.localId === localId);
        },
      };
    },
    eventSource() {
      assert.equal(eventSources.length, 1);
      return eventSources[0];
    },
    sendFrameMessage(data) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      for (const handler of handlers) handler({ source: frame.contentWindow, data });
    },
    sendWhiteboardMessage(data) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      for (const handler of handlers) handler({ source: whiteboardFrame.contentWindow, data });
    },
    sendInlineWhiteboardMessage(whiteboard, data) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      for (const handler of handlers) handler({ source: whiteboard.source, data });
    },
    dispatchDocumentKeydown(eventProps) {
      const handlers = documentListeners.get("keydown") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a document keydown handler");
      const event = {
        key: "",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        isComposing: false,
        defaultPrevented: false,
        ...eventProps,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const { handler } of handlers) handler(event);
      return event;
    },
    queued() {
      return JSON.parse(storage.get("lavish-axi:queued:abc") || "[]");
    },
    reloadCount() {
      return reloadCount;
    },
    runTimers,
    srcLoads,
  };
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("chrome client replaces queued prompts with the same internal key", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Use plan A", selector: "input#plan-a", tag: "choice", text: "Plan A", _lavishQueueKey: "plan" },
  });
  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Use plan B", selector: "input#plan-b", tag: "choice", text: "Plan B", _lavishQueueKey: "plan" },
  });
  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Apply dark mode", selector: "button#dark", tag: "choice", text: "Dark" },
  });

  assert.deepEqual(
    chrome.queued().map((prompt) => prompt.prompt),
    ["Use plan B", "Apply dark mode"],
  );
  assert.match(chrome.element("annotationPills").innerHTML, /Use plan B/);
  assert.doesNotMatch(chrome.element("annotationPills").innerHTML, /Use plan A/);
});

test("chrome client scrolls new chat bubbles into view above queued prompts", async () => {
  const chrome = await createChromeHarness();
  const panelScroll = chrome.element("panelScroll");
  panelScroll.scrollHeight = 1800;

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Review the title", selector: "h1", tag: "annotation", text: "Title" },
  });
  assert.equal(panelScroll.scrollTop, 1800);

  panelScroll.scrollTop = 640;
  chrome.eventSource().listeners.get("agent-reply")({
    data: JSON.stringify({ text: "I updated the title." }),
  });

  const bubble = chrome.element("chatLog").lastAppendedChild;
  assert.equal(bubble.scrolledIntoView.block, "nearest");
  assert.equal(bubble.scrolledIntoView.inline, "nearest");
  assert.equal(panelScroll.scrollTop, 640);
});

test("chrome mediates attachment uploads: rate + cumulative-byte ceiling (confused-deputy guard)", async () => {
  let fetches = 0;
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (String(url).includes("/attachment-channel")) return { ok: true };
      fetches += 1;
      return { ok: true, json: async () => ({ attachment: { id: "a".repeat(64) + ".png" } }) };
    },
  });
  const af = chrome.createAttachmentFrame();
  af.ready();
  await flushPromises(); // channel authenticated

  af.upload({ localId: "invalid", mime: "image/png", bytes: { byteLength: 16 } });
  await flushPromises();
  assert.equal(fetches, 0, "an invalid payload never hits the network");
  const invalidResult = af.result("invalid");
  assert.equal(invalidResult.ok, false);
  assert.equal(invalidResult.error, "invalid upload payload");

  // A single oversized (>256 MiB session quota) upload is refused BEFORE the network.
  af.upload({ localId: "big", mime: "image/png", bytes: new ArrayBuffer(300 * 1024 * 1024) });
  await flushPromises();
  assert.equal(fetches, 0, "quota-exceeding upload never hits the network");
  const quotaResult = af.result("big");
  assert.equal(quotaResult.ok, false);
  assert.match(quotaResult.error, /Upload limit reached/);

  // Small uploads flow until the per-window rate cap (30), then are throttled. Each
  // is let settle before the next so the in-flight bound (its own test) never blocks;
  // here we are exercising the RATE cap, which counts uploads that reached the network.
  for (let i = 0; i < 30; i += 1) {
    af.upload({ localId: "ok-" + i, mime: "image/png", bytes: new ArrayBuffer(16) });
    await flushPromises();
  }
  assert.equal(fetches, 30, "the first 30 uploads within the window are allowed");

  af.upload({ localId: "throttled", mime: "image/png", bytes: new ArrayBuffer(16) });
  await flushPromises();
  assert.equal(fetches, 30, "the 31st upload in the window is throttled, not sent");
  const throttled = af.result("throttled");
  assert.equal(throttled.ok, false);
  assert.match(throttled.error, /Too many uploads/);
});

test("the chrome acks a bound capture frame with its token as channelId (reveal handshake)", async () => {
  // The `ready` message carries `channelToken`, not `channelId`. The bound ack must
  // be stamped with the AUTHENTICATED token so the frame's channel guard accepts it
  // and re-reports state (which reveals the otherwise-hidden capture iframe). A reply
  // stamped with the ready message's (absent) `channelId` would ship `undefined` and
  // the frame would silently drop it, killing the whole attach flow.
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => (String(url).includes("/attachment-channel") ? { ok: true } : { ok: true }),
  });
  const af = chrome.createAttachmentFrame("the-token");
  af.ready();
  await flushPromises();
  const bound = af.posted.find((m) => m.type === "lavish-attachment:bound");
  assert.ok(bound, "the chrome acks the binding back to the frame");
  assert.equal(bound.channelId, "the-token", "the ack carries the frame's own token so its channel guard accepts it");
});

test("the chrome ignores attachment uploads from an unauthenticated (unbound) frame (root A)", async () => {
  // A frame that never presented a valid channel token - e.g. a hostile artifact
  // posting to window.top pretending to be a capture frame - must not drive an
  // upload. Only a frame the server authenticated (real, chrome-served token) binds.
  let fetches = 0;
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (String(url).includes("/attachment-channel")) return { ok: false };
      fetches += 1;
      return { ok: true, json: async () => ({ attachment: { id: "a".repeat(64) + ".png" } }) };
    },
  });
  const af = chrome.createAttachmentFrame();
  af.ready();
  await flushPromises(); // auth REJECTED, so no binding
  af.upload({ localId: "x", mime: "image/png", bytes: new ArrayBuffer(16) });
  await flushPromises();
  assert.equal(fetches, 0, "an unbound frame's upload never reaches the network");
  assert.equal(af.result("x"), undefined, "and gets no result echoed back");
});

test("a newer capture frame wins the channel even if an older frame's auth resolves last (root A rebind race)", async () => {
  // Two overlapping cards: frame A announces, then A closes and frame B announces,
  // then A's channel-auth fetch resolves AFTER B's. Binding must stay on B (the live
  // card), not clobber back to A's dead frame - else B's uploads wedge.
  const resolvers = {};
  const chrome = await createChromeHarness({
    fetchImpl: (url, init) => {
      if (!String(url).includes("/attachment-channel")) return Promise.resolve({ ok: true, json: async () => ({}) });
      const token = JSON.parse(init.body).token;
      return new Promise((resolve) => {
        resolvers[token] = () => resolve(/** @type {any} */ ({ ok: true }));
      });
    },
  });
  const a = chrome.createAttachmentFrame("token-A");
  const b = chrome.createAttachmentFrame("token-B");
  a.ready();
  b.ready();
  // Resolve B first (it is the newest), then A (out of order).
  resolvers["token-B"]();
  await flushPromises();
  resolvers["token-A"]();
  await flushPromises();

  // B is bound: an upload from B is accepted, an upload from the stale A is ignored.
  let uploadFetches = 0;
  chrome.eventSource; // touch to avoid unused lint if any
  b.send({ type: "lavish-attachment:state", channelId: "token-B", items: [], height: 40 });
  const relayed = chrome.postedToFrame.filter((m) => m.type === "lavish:attachmentState");
  assert.ok(relayed.length > 0, "the newest frame's state is relayed (it holds the channel)");
  a.send({
    type: "lavish-attachment:state",
    channelId: "token-A",
    items: [{ localId: "x", status: "ready", id: "y" }],
  });
  const relayedAfterA = chrome.postedToFrame.filter((m) => m.type === "lavish:attachmentState");
  assert.equal(relayedAfterA.length, relayed.length, "the stale frame cannot drive state through the channel");
  void uploadFetches;
});

test("the chrome ignores an upload carrying the wrong channel token (root A)", async () => {
  let fetches = 0;
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (String(url).includes("/attachment-channel")) return { ok: true };
      fetches += 1;
      return { ok: true, json: async () => ({ attachment: { id: "a".repeat(64) + ".png" } }) };
    },
  });
  const af = chrome.createAttachmentFrame("real-token");
  af.ready();
  await flushPromises();
  // Same source window, but a forged channelId: rejected.
  af.send({
    type: "lavish-attachment:upload",
    channelId: "forged",
    localId: "x",
    mime: "image/png",
    bytes: new ArrayBuffer(16),
  });
  await flushPromises();
  assert.equal(fetches, 0, "an upload with a mismatched channel token never reaches the network");
});

test("chrome client posts layout warnings from the artifact iframe", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [
      {
        selector: "html",
        kind: "page-horizontal-overflow",
        overflowPx: 18,
        viewportWidth: 720,
        severity: "error",
      },
    ],
  });
  await flushPromises();

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/abc/layout-warnings");
  assert.deepEqual(posts[0].body, {
    layout_warnings: [
      {
        selector: "html",
        kind: "page-horizontal-overflow",
        overflowPx: 18,
        viewportWidth: 720,
        severity: "error",
      },
    ],
  });
});

test("chrome client surfaces export warnings from the server response", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get(name) {
          if (name.toLowerCase() === "x-lavish-export-warning-count") return "1";
          return null;
        },
      },
      blob: async () => ({}),
    }),
  });

  await chrome.element("exportArtifact").onclick();
  await flushPromises();

  assert.equal(chrome.element("exportArtifact").querySelector("span").textContent, "Exported with 1 unresolved asset");
});

test("chrome client surfaces export notices from the server response", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get(name) {
          if (name.toLowerCase() === "x-lavish-export-warning-count") return "0";
          if (name.toLowerCase() === "x-lavish-export-notice-count") return "1";
          return null;
        },
      },
      blob: async () => ({}),
    }),
  });

  await chrome.element("exportArtifact").onclick();
  await flushPromises();

  assert.equal(chrome.element("exportArtifact").querySelector("span").textContent, "Exported with 1 notice");
});

test("chrome client includes export notices alongside unresolved assets", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      headers: {
        get(name) {
          if (name.toLowerCase() === "x-lavish-export-warning-count") return "2";
          if (name.toLowerCase() === "x-lavish-export-notice-count") return "1";
          return null;
        },
      },
      blob: async () => ({}),
    }),
  });

  await chrome.element("exportArtifact").onclick();
  await flushPromises();

  assert.equal(
    chrome.element("exportArtifact").querySelector("span").textContent,
    "Exported with 2 unresolved assets and 1 notice",
  );
});

test("chrome client surfaces share warnings from the server response", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        url: "https://abc123.ht-ml.app/",
        update_key: "uk_secret",
        warnings: [
          { kind: "load-failed", ref: "missing.png" },
          { kind: "csp-meta", ref: "script-src 'self'" },
        ],
        unresolved_local_assets: [{ kind: "load-failed", ref: "missing.png" }],
        notices: [{ kind: "csp-meta", ref: "script-src 'self'" }],
      }),
    }),
  });
  const submit = chrome.element("shareForm").listeners.get("submit");
  assert.equal(typeof submit, "function");

  await submit({ preventDefault() {} });
  await flushPromises();

  assert.equal(chrome.element("shareStatus").textContent, "Published with 1 unresolved local asset and 1 notice.");
  assert.equal(chrome.element("shareResult").hidden, false);
});

test("chrome client does not count share notices as unresolved assets", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        url: "https://abc123.ht-ml.app/",
        update_key: "uk_secret",
        warnings: [{ kind: "csp-meta", ref: "script-src 'self'" }],
        notices: [{ kind: "csp-meta", ref: "script-src 'self'" }],
      }),
    }),
  });
  const submit = chrome.element("shareForm").listeners.get("submit");
  assert.equal(typeof submit, "function");

  await submit({ preventDefault() {} });
  await flushPromises();

  assert.equal(chrome.element("shareStatus").textContent, "Published with 1 notice.");
  assert.equal(chrome.element("shareResult").hidden, false);
});

test("chrome client clears stale share passwords when opening a fresh dialog", async () => {
  const chrome = await createChromeHarness();

  chrome.element("sharePassword").value = "old-password";
  chrome.element("shareArtifact").onclick();

  assert.equal(chrome.element("sharePassword").value, "");
});

test("chrome client preserves share passwords during an in-dialog retry", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: false,
      json: async () => ({ error: "publish failed" }),
    }),
  });

  chrome.element("shareArtifact").onclick();
  chrome.element("sharePassword").value = "pw";
  const submit = chrome.element("shareForm").listeners.get("submit");
  assert.equal(typeof submit, "function");

  await submit({ preventDefault() {} });
  await flushPromises();

  assert.equal(chrome.element("sharePassword").value, "pw");
  assert.equal(chrome.element("shareStatus").textContent, "publish failed");
});

test("chrome client says password-protected shares also require the password", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        url: "https://abc123.ht-ml.app/",
        update_key: "uk_secret",
      }),
    }),
  });
  chrome.element("sharePassword").value = "pw";
  const submit = chrome.element("shareForm").listeners.get("submit");
  assert.equal(typeof submit, "function");

  await submit({ preventDefault() {} });
  await flushPromises();

  assert.equal(
    chrome.element("shareStatus").textContent,
    "Published. This page is PASSWORD-PROTECTED; viewers also need the password.",
  );
});

test("chrome client treats a whitespace-only share password as public", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (_url, init) => {
      posts.push(JSON.parse(init.body));
      return {
        ok: true,
        json: async () => ({
          url: "https://abc123.ht-ml.app/",
          update_key: "uk_secret",
        }),
      };
    },
  });
  chrome.element("sharePassword").value = "   ";
  const submit = chrome.element("shareForm").listeners.get("submit");
  assert.equal(typeof submit, "function");

  await submit({ preventDefault() {} });
  await flushPromises();

  assert.deepEqual(posts, [{}]);
  assert.equal(chrome.element("shareStatus").textContent, "Published. Anyone with the link can view this page.");
});

test("chrome client registers message listener before loading the artifact iframe", async () => {
  const chrome = await createChromeHarness({ artifactSrc: "/artifact/abc/index.html" });

  assert.deepEqual(chrome.srcLoads, [{ src: "/artifact/abc/index.html", hadMessageListener: true }]);
});

test("layout gate reveals after a clean audit result", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), true);

  chrome.sendFrameMessage({ type: "lavish:layoutWarnings", layout_warnings: [] });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);
  assert.deepEqual(posts[0], { url: "/api/abc/layout-warnings", body: { layout_warnings: [] } });
});

test("layout gate holds on error severity audit findings and still posts them", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [
      {
        selector: "html",
        kind: "page-horizontal-overflow",
        overflowPx: 18,
        viewportWidth: 720,
        severity: "error",
      },
    ],
  });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), true);
  assert.match(chrome.element("layoutGateTitle").innerHTML, /Fixing a layout issue/);
  assert.deepEqual(posts[0].body.layout_warnings[0].severity, "error");
});

test("warning-only layout observations are discarded before gate and feedback submission", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [
      {
        selector: ".card",
        kind: "text-clipped",
        overflowPx: 2,
        viewportWidth: 720,
        severity: "warning",
      },
      {
        selector: ".unproven",
        kind: "text-clipped",
        overflowPx: 200,
        viewportWidth: 720,
      },
    ],
  });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);
  assert.deepEqual(posts[0].body, { layout_warnings: [] });
});

test("layout gate timeout fails open without an issue banner when no severe result arrives", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateMaxHoldMs: 25 },
  });

  chrome.runTimers(25);

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);
});

test("a proven severe result is not mistaken for an uncertain audit timeout", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateMaxHoldMs: 25 },
  });

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });
  chrome.runTimers(25);

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);
});

test("a late clean audit stays clean after the layout gate times out", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateMaxHoldMs: 25 },
  });

  chrome.runTimers(25);
  chrome.sendFrameMessage({ type: "lavish:layoutWarnings", layout_warnings: [] });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);
});

test("layout gate timeout re-arms on reload", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateMaxHoldMs: 25 },
  });

  chrome.runTimers(25);
  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);

  chrome.eventSource().listeners.get("reload")();

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });

  assert.equal(chrome.element("layoutGateOverlay").hidden, false);
  assert.match(chrome.element("layoutGateTitle").innerHTML, /Fixing a layout issue/);
});

test("layout gate manual override reveals immediately", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });
  chrome.element("layoutGateAction").onclick();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);
  assert.equal(chrome.element("layoutIssueBanner").hidden, false);
});

test("layout gate manual override stays bypassed on reload", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });
  chrome.element("layoutGateAction").onclick();
  chrome.eventSource().listeners.get("reload")();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, false);
});

test("layout gate stays skipped when the session disables it", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", layoutGateEnabled: false },
  });

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("body").classList.contains("layout-gate-active"), false);

  chrome.sendFrameMessage({
    type: "lavish:layoutWarnings",
    layout_warnings: [{ selector: "html", kind: "content-overlap", severity: "error" }],
  });
  await flushPromises();

  assert.equal(chrome.element("layoutGateOverlay").hidden, true);
  assert.equal(chrome.element("layoutIssueBanner").hidden, true);
});

test("chrome client strips the internal queue key before posting prompts", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Use plan B", selector: "input#plan-b", tag: "choice", text: "Plan B", _lavishQueueKey: "plan" },
  });
  chrome.element("send").onclick();
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:requestSnapshot");

  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();

  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/abc/prompts");
  assert.deepEqual(posts[0].body, {
    prompts: [{ prompt: "Use plan B", selector: "input#plan-b", tag: "choice", text: "Plan B" }],
    domSnapshot: "uid=1 body",
  });
  assert.equal(chrome.queued().length, 0);
});

test("chrome send and end carries the end intent with queued prompts", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" },
  });
  chrome.element("sendAndEnd").onclick();
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:requestSnapshot");

  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  await flushPromises();

  assert.deepEqual(
    posts.map((post) => post.url),
    ["/api/abc/prompts"],
  );
  assert.deepEqual(posts[0].body, {
    prompts: [{ prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" }],
    domSnapshot: "uid=1 body",
    endSession: true,
  });
  assert.equal(chrome.queued().length, 0);
  assert.equal(chrome.element("chatInput").disabled, true);
});

test("chrome send and end with an empty composer nudges instead of ending", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      return { ok: true };
    },
  });
  chrome.element("sendHint").hidden = true;

  chrome.element("sendAndEnd").onclick();
  await flushPromises();

  assert.equal(posts.length, 0);
  assert.equal(chrome.postedToFrame.length, 0);
  assert.equal(chrome.element("sendHint").hidden, false);
  assert.equal(chrome.element("chatInput").focused, true);
  assert.equal(chrome.element("chatInput").disabled, false);
});

test("chrome send and end during an in-flight submit still ends after the submit drains the queue", async () => {
  const posts = [];
  let resolveFirstPost = () => {};
  const firstPost = new Promise((resolve) => {
    resolveFirstPost = () => resolve();
  });
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      posts.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (posts.length === 1) await firstPost;
      return { ok: true };
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" },
  });
  chrome.element("send").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  assert.equal(posts.length, 1);

  chrome.element("sendAndEnd").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  assert.equal(posts.length, 1);

  resolveFirstPost();
  await flushPromises();
  await flushPromises();

  assert.deepEqual(
    posts.map((post) => post.url),
    ["/api/abc/prompts", "/api/abc/end"],
  );
  assert.deepEqual(posts[0].body, {
    prompts: [{ prompt: "Ship this", selector: "button#ship", tag: "choice", text: "Ship" }],
    domSnapshot: "uid=1 body",
  });
  assert.equal(posts[1].body, null);
  assert.equal(chrome.queued().length, 0);
  assert.equal(chrome.element("chatInput").disabled, true);
});

test("Cmd/Ctrl+I toggles annotation mode from the chrome document, regardless of focus", async () => {
  const chrome = await createChromeHarness();

  const metaEvent = chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  assert.equal(metaEvent.defaultPrevented, true);
  assert.equal(chrome.element("annotation")["aria-pressed"], "false");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, false);

  const ctrlEvent = chrome.dispatchDocumentKeydown({ key: "I", ctrlKey: true });
  assert.equal(ctrlEvent.defaultPrevented, true);
  assert.equal(chrome.element("annotation")["aria-pressed"], "true");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, true);
});

test("plain 'i' and other modifier combos do not toggle annotation mode", async () => {
  const chrome = await createChromeHarness();
  const framePostCount = () => chrome.postedToFrame.length;
  const before = framePostCount();

  const bareEvent = chrome.dispatchDocumentKeydown({ key: "i" });
  assert.equal(bareEvent.defaultPrevented, false);
  assert.equal(chrome.element("annotation")["aria-pressed"], undefined);

  const shiftEvent = chrome.dispatchDocumentKeydown({ key: "i", shiftKey: true });
  assert.equal(shiftEvent.defaultPrevented, false);

  const ctrlShiftEvent = chrome.dispatchDocumentKeydown({ key: "i", ctrlKey: true, shiftKey: true });
  assert.equal(ctrlShiftEvent.defaultPrevented, false);

  const metaAltEvent = chrome.dispatchDocumentKeydown({ key: "i", metaKey: true, altKey: true });
  assert.equal(metaAltEvent.defaultPrevented, false);

  const otherKeyEvent = chrome.dispatchDocumentKeydown({ key: "s", metaKey: true });
  assert.equal(otherKeyEvent.defaultPrevented, false);

  assert.equal(framePostCount(), before);
});

test("chrome client reads the mode toggle hotkey from the session bootstrap", async () => {
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", modeToggleHotkeyKey: "k" },
  });

  const oldHotkeyEvent = chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  assert.equal(oldHotkeyEvent.defaultPrevented, false);
  assert.equal(chrome.element("annotation")["aria-pressed"], undefined);

  const bootstrapHotkeyEvent = chrome.dispatchDocumentKeydown({ key: "K", metaKey: true });
  assert.equal(bootstrapHotkeyEvent.defaultPrevented, true);
  assert.equal(chrome.element("annotation")["aria-pressed"], "false");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, false);
});

test("chrome client toggles annotation mode when the artifact SDK requests it via postMessage", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({ type: "lavish:toggleAnnotationMode" });

  assert.equal(chrome.element("annotation")["aria-pressed"], "false");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, false);

  chrome.sendFrameMessage({ type: "lavish:toggleAnnotationMode" });
  assert.equal(chrome.element("annotation")["aria-pressed"], "true");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:setAnnotationMode");
  assert.equal(chrome.postedToFrame.at(-1).enabled, true);
});

test("chrome client ignores annotation mode toggles after the session ends", async () => {
  const chrome = await createChromeHarness();

  chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  assert.equal(chrome.element("annotation")["aria-pressed"], "false");

  chrome.sendFrameMessage({ type: "lavish:endSession" });
  await flushPromises();
  const afterEndPostCount = chrome.postedToFrame.length;

  chrome.dispatchDocumentKeydown({ key: "i", metaKey: true });
  chrome.sendFrameMessage({ type: "lavish:toggleAnnotationMode" });

  assert.equal(chrome.element("annotation")["aria-pressed"], "false");
  assert.equal(chrome.postedToFrame.length, afterEndPostCount);
});

function whiteboardFetch(url) {
  if (url.includes("/whiteboard-channel")) return { ok: true };
  if (url.includes("/mermaid-sources")) {
    return { ok: true, json: async () => ({ sources: [{ index: 0, source: "flowchart TD; A-->B", hash: "hash" }] }) };
  }
  return { ok: true, json: async () => ({ whiteboard: null }) };
}

async function initializeInlineWhiteboard(chrome, token = "inline-channel") {
  const whiteboard = chrome.createInlineWhiteboard();
  chrome.sendInlineWhiteboardMessage(whiteboard, {
    type: "lavish-whiteboard:ready",
    diagramIndex: 0,
    diagramId: "mermaid-1",
    channelToken: token,
  });
  await flushPromises();
  await flushPromises();
  return whiteboard;
}

test("artifact relays cannot invoke whiteboard persistence", async () => {
  const calls = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      return whiteboardFetch(url);
    },
  });

  chrome.sendFrameMessage({
    type: "lavish:whiteboardRelay",
    diagramIndex: 0,
    message: { type: "lavish-whiteboard:save", scene: { elements: [{ id: "forged" }] } },
  });
  await flushPromises();

  assert.equal(calls.length, 0);
  assert.equal(chrome.postedToFrame.length, 0);
});

test("unverified whiteboard frames cannot invoke whiteboard persistence", async () => {
  const calls = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      return { ok: false };
    },
  });
  const whiteboard = chrome.createInlineWhiteboard();

  chrome.sendInlineWhiteboardMessage(whiteboard, {
    type: "lavish-whiteboard:ready",
    diagramIndex: 0,
    channelToken: "forged",
  });
  await flushPromises();
  chrome.sendInlineWhiteboardMessage(whiteboard, {
    type: "lavish-whiteboard:save",
    diagramIndex: 0,
    channelId: "forged",
    scene: { elements: [{ id: "forged" }] },
  });
  await flushPromises();

  assert.deepEqual(
    calls.map((call) => call.url),
    ["/api/abc/whiteboard-channel"],
  );
  assert.equal(whiteboard.posted.length, 0);
});

test("whiteboard fullscreen waits for the authenticated inline frame to flush", async () => {
  const chrome = await createChromeHarness({ fetchImpl: async (url) => whiteboardFetch(url) });
  const inline = await initializeInlineWhiteboard(chrome);
  const init = inline.posted.at(-1);
  assert.equal(init.type, "lavish-whiteboard:init");
  assert.equal(init.channelId, "inline-channel");

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:maximize",
    diagramIndex: 0,
    channelId: "inline-channel",
  });

  const prepare = inline.posted.at(-1);
  assert.equal(prepare.type, "lavish-whiteboard:prepareTeardown");
  assert.equal(
    chrome.postedToFrame.some((message) => message.type === "lavish:suspendWhiteboard"),
    false,
  );

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: prepare.flushId,
  });

  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:suspendWhiteboard");
  assert.match(chrome.element("whiteboardFrame").src, /^\/whiteboard-frame\?diagramIndex=0$/);
});

test("whiteboard close waits for the authenticated overlay frame to flush", async () => {
  const chrome = await createChromeHarness({ fetchImpl: async (url) => whiteboardFetch(url) });
  const inline = await initializeInlineWhiteboard(chrome);

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:maximize",
    diagramIndex: 0,
    channelId: "inline-channel",
  });
  const maximizePrepare = inline.posted.at(-1);
  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: maximizePrepare.flushId,
  });
  chrome.sendWhiteboardMessage({ type: "lavish-whiteboard:ready", diagramIndex: 0, channelToken: "overlay-channel" });
  await flushPromises();
  await flushPromises();

  chrome.element("whiteboardClose").click();
  const closePrepare = chrome.postedToWhiteboard.at(-1);
  assert.equal(closePrepare.type, "lavish-whiteboard:prepareTeardown");
  assert.equal(closePrepare.channelId, "overlay-channel");
  assert.notEqual(chrome.element("whiteboardFrame").src, "about:blank");

  chrome.sendWhiteboardMessage({
    type: "lavish-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "overlay-channel",
    flushId: closePrepare.flushId,
  });

  assert.equal(chrome.element("whiteboardFrame").src, "about:blank");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:resumeWhiteboard");
});

test("whiteboard fullscreen close accepts the resumed inline frame", async () => {
  const chrome = await createChromeHarness({ fetchImpl: async (url) => whiteboardFetch(url) });
  const inline = await initializeInlineWhiteboard(chrome);

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:maximize",
    diagramIndex: 0,
    channelId: "inline-channel",
  });
  const maximizePrepare = inline.posted.at(-1);
  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: maximizePrepare.flushId,
  });
  chrome.sendWhiteboardMessage({ type: "lavish-whiteboard:ready", diagramIndex: 0, channelToken: "overlay-channel" });
  await flushPromises();
  await flushPromises();

  chrome.element("whiteboardClose").click();
  const closePrepare = chrome.postedToWhiteboard.at(-1);
  chrome.sendWhiteboardMessage({
    type: "lavish-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "overlay-channel",
    flushId: closePrepare.flushId,
  });

  const resumed = chrome.createInlineWhiteboard();
  chrome.sendInlineWhiteboardMessage(resumed, {
    type: "lavish-whiteboard:ready",
    diagramIndex: 0,
    diagramId: "mermaid-1",
    channelToken: "resumed-channel",
  });
  await flushPromises();
  await flushPromises();

  assert.equal(resumed.posted.at(-1).type, "lavish-whiteboard:init");
  assert.equal(resumed.posted.at(-1).channelId, "resumed-channel");
});

test("artifact reload waits for inline whiteboards to flush", async () => {
  const chrome = await createChromeHarness({
    artifactSrc: "/artifact/abc/index.html",
    fetchImpl: async (url) => whiteboardFetch(url),
  });
  const inline = await initializeInlineWhiteboard(chrome);
  const initialLoadCount = chrome.srcLoads.length;

  chrome.element("reloadArtifact").click();
  const prepare = inline.posted.at(-1);
  assert.equal(prepare.type, "lavish-whiteboard:prepareTeardown");
  assert.equal(chrome.srcLoads.length, initialLoadCount);

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: prepare.flushId,
  });
  await flushPromises();

  assert.equal(chrome.srcLoads.length, initialLoadCount + 1);
  assert.equal(chrome.element("artifact").src, "/artifact/abc/index.html");
});

test("server restart flushes an authenticated inline whiteboard before reloading", async () => {
  let healthChecks = 0;
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (url === "/health") {
        healthChecks += 1;
        if (healthChecks === 1) throw new Error("server is restarting");
        return { ok: true };
      }
      return whiteboardFetch(url);
    },
  });
  const inline = await initializeInlineWhiteboard(chrome);

  const restart = chrome.eventSource().listeners.get("chrome-reload")();
  await flushPromises();
  chrome.runTimers(100);
  await flushPromises();

  const flush = inline.posted.at(-1);
  assert.equal(flush.type, "lavish-whiteboard:flush");
  assert.equal(chrome.reloadCount(), 0);

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:flushComplete",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: flush.flushId,
    ok: true,
  });
  await restart;

  assert.equal(chrome.reloadCount(), 1);
});

test("server restart flushes an authenticated overlay before reloading", async () => {
  let healthChecks = 0;
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (url === "/health") {
        healthChecks += 1;
        if (healthChecks === 1) throw new Error("server is restarting");
        return { ok: true };
      }
      return whiteboardFetch(url);
    },
  });
  const inline = await initializeInlineWhiteboard(chrome);
  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:maximize",
    diagramIndex: 0,
    channelId: "inline-channel",
  });
  const teardown = inline.posted.at(-1);
  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: teardown.flushId,
  });
  chrome.sendWhiteboardMessage({ type: "lavish-whiteboard:ready", diagramIndex: 0, channelToken: "overlay-channel" });
  await flushPromises();
  await flushPromises();

  const restart = chrome.eventSource().listeners.get("chrome-reload")();
  await flushPromises();
  chrome.runTimers(100);
  await flushPromises();

  const flush = chrome.postedToWhiteboard.at(-1);
  assert.equal(flush.type, "lavish-whiteboard:flush");
  assert.equal(chrome.reloadCount(), 0);

  chrome.sendWhiteboardMessage({
    type: "lavish-whiteboard:flushComplete",
    diagramIndex: 0,
    channelId: "overlay-channel",
    flushId: flush.flushId,
    ok: true,
  });
  await restart;

  assert.equal(chrome.reloadCount(), 1);
});

test("server restart bounds the wait for a whiteboard flush", async () => {
  let healthChecks = 0;
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (url === "/health") {
        healthChecks += 1;
        if (healthChecks === 1) throw new Error("server is restarting");
        return { ok: true };
      }
      return whiteboardFetch(url);
    },
  });
  const inline = await initializeInlineWhiteboard(chrome);

  const restart = chrome.eventSource().listeners.get("chrome-reload")();
  await flushPromises();
  chrome.runTimers(100);
  await flushPromises();

  assert.equal(inline.posted.at(-1).type, "lavish-whiteboard:flush");
  chrome.runTimers(1500);
  await restart;

  assert.equal(chrome.reloadCount(), 1);
});

test("whiteboard close stays responsive while overlay initialization is pending", async () => {
  let delayOverlaySources = false;
  /** @type {(() => void) | undefined} */
  let releaseOverlaySources;
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (delayOverlaySources && url.includes("/mermaid-sources")) {
        await new Promise((resolve) => {
          releaseOverlaySources = () => resolve();
        });
      }
      return whiteboardFetch(url);
    },
  });
  const inline = await initializeInlineWhiteboard(chrome);

  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:maximize",
    diagramIndex: 0,
    channelId: "inline-channel",
  });
  const maximizePrepare = inline.posted.at(-1);
  chrome.sendInlineWhiteboardMessage(inline, {
    type: "lavish-whiteboard:teardownReady",
    diagramIndex: 0,
    channelId: "inline-channel",
    flushId: maximizePrepare.flushId,
  });

  delayOverlaySources = true;
  chrome.sendWhiteboardMessage({ type: "lavish-whiteboard:ready", diagramIndex: 0, channelToken: "overlay-channel" });
  await flushPromises();
  chrome.element("whiteboardClose").click();

  assert.equal(chrome.element("whiteboardFrame").src, "about:blank");
  assert.equal(chrome.postedToFrame.at(-1).type, "lavish:resumeWhiteboard");
  assert.equal(
    chrome.postedToWhiteboard.some((message) => message.type === "lavish-whiteboard:prepareTeardown"),
    false,
  );

  releaseOverlaySources?.();
  await flushPromises();
});

test("chrome uploads captured attachment bytes and reports the server id to the capture frame", async () => {
  const requests = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, options) => {
      if (String(url).includes("/attachment-channel")) return { ok: true };
      requests.push({ url, options });
      return { ok: true, json: async () => ({ status: "stored", attachment: { id: "a".repeat(64) + ".png" } }) };
    },
  });
  const af = chrome.createAttachmentFrame();
  af.ready();
  await flushPromises();

  const bytes = new Uint8Array([1, 2, 3]).buffer;
  af.upload({ localId: "att-1", name: "mock.png", mime: "image/png", bytes });
  await flushPromises();

  assert.equal(requests[0].url, "/api/abc/attachments");
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.headers["content-type"], "image/png");
  assert.equal(requests[0].options.body, bytes);
  // The result goes back to the CAPTURE FRAME, never the artifact frame.
  const result = af.result("att-1");
  assert.equal(result.ok, true);
  assert.equal(result.id, "a".repeat(64) + ".png");
  assert.equal(result.channelId, af.token);
  assert.ok(
    !chrome.postedToFrame.some((m) => m.type === "lavish:attachmentResult"),
    "no attachment bytes or result are ever posted into the artifact realm",
  );
});

test("chrome relays only non-sensitive capture-frame state to the artifact card (root A)", async () => {
  const chrome = await createChromeHarness();
  const af = chrome.createAttachmentFrame();
  af.ready();
  await flushPromises();
  const id = "a".repeat(64) + ".png";
  af.state({
    capRejected: true,
    height: 210,
    items: [{ localId: "att-1", name: "shot.png", status: "ready", id, bytes: "SECRET" }],
  });
  const relayed = chrome.postedToFrame.filter((m) => m.type === "lavish:attachmentState").at(-1);
  assert.ok(relayed, "the chrome relays a state message to the artifact card");
  assert.equal(relayed.state.capRejected, true);
  assert.equal(relayed.state.height, 210);
  assert.deepEqual(relayed.state.items, [{ localId: "att-1", name: "shot.png", status: "ready", id, bytes: "SECRET" }]);
  // The relay carries no upload bytes of its own - only the frame's own item list.
  assert.equal(JSON.stringify(relayed).includes("lavish-attachment:upload"), false);
});

test("chrome reports an upload failure back to the capture frame", async () => {
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (String(url).includes("/attachment-channel")) return { ok: true };
      return { ok: false, json: async () => ({ error: "unsupported image type" }) };
    },
  });
  const af = chrome.createAttachmentFrame();
  af.ready();
  await flushPromises();
  af.upload({ localId: "att-9", name: "bad.svg", mime: "image/svg+xml", bytes: new Uint8Array([0]).buffer });
  await flushPromises();
  const result = af.result("att-9");
  assert.equal(result.ok, false);
  assert.equal(result.error, "unsupported image type");
});

// The two tests that used to pin "chrome deletes a removed attachment through the
// server" (and its queued-reference exception) are intentionally gone: E2 removed
// that eager delete outright, and the replacement contract - the chrome never
// honors an iframe-driven delete - is pinned above.

test("chrome renders queued-prompt attachment thumbnails from the server endpoint", async () => {
  const chrome = await createChromeHarness();
  const id = "a".repeat(64) + ".png";
  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "", selector: "h1", tag: "annotation", text: "", attachments: [{ id, name: "mock.png" }] },
  });
  const html = chrome.element("annotationPills").innerHTML;
  assert.match(html, /pill-attachment/);
  assert.match(html, new RegExp("/api/abc/attachments/" + id));
  // An image-only annotation still shows a readable label.
  assert.match(html, /Image annotation/);
});

test("a queued prompt over the thumbnail limit shows the hidden images as a +N badge (W-A)", async () => {
  // LAVISH_AXI_MAX_ATTACHMENTS_PER_PROMPT is configurable, so a prompt can legitimately
  // carry more images than the compact pill can show. The overflow must be counted, not
  // silently dropped - otherwise the queue looks like it lost the extra attachments.
  const chrome = await createChromeHarness();
  const attachments = Array.from({ length: 7 }, (_, i) => ({ id: String(i).repeat(64) + ".png", name: `i${i}.png` }));
  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "seven", selector: "h1", tag: "annotation", text: "", attachments },
  });
  const html = chrome.element("annotationPills").innerHTML;
  assert.equal(html.match(/class="pill-attachment"/g)?.length, 4, "the pill renders its four thumbnails");
  assert.match(html, /class="pill-attachment-more"[^>]*>\+3</, "the other three are counted, not hidden");
  assert.match(html, /title="3 more images"/);
});

test("a queued prompt at or under the thumbnail limit shows no +N badge (W-A)", async () => {
  const chrome = await createChromeHarness();
  const attachments = Array.from({ length: 4 }, (_, i) => ({ id: String(i).repeat(64) + ".png", name: `i${i}.png` }));
  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "four", selector: "h1", tag: "annotation", text: "", attachments },
  });
  const html = chrome.element("annotationPills").innerHTML;
  assert.equal(html.match(/class="pill-attachment"/g)?.length, 4);
  assert.doesNotMatch(html, /pill-attachment-more/);
});

test("the +N badge stays singular for a single hidden image (W-A)", async () => {
  const chrome = await createChromeHarness();
  const attachments = Array.from({ length: 5 }, (_, i) => ({ id: String(i).repeat(64) + ".png", name: `i${i}.png` }));
  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "five", selector: "h1", tag: "annotation", text: "", attachments },
  });
  assert.match(chrome.element("annotationPills").innerHTML, /title="1 more image"/);
});

test("chrome rejects an over-cap image before it hits the network", async () => {
  const requests = [];
  const chrome = await createChromeHarness({
    sessionData: { key: "abc", file: "/tmp/artifact.html", modeToggleHotkeyKey: "i", attachmentMaxBytes: 4 },
    fetchImpl: async (url, options) => {
      if (String(url).includes("/attachment-channel")) return { ok: true };
      requests.push({ url, options });
      return { ok: true, json: async () => ({ attachment: { id: "x" } }) };
    },
  });
  const af = chrome.createAttachmentFrame();
  af.ready();
  await flushPromises();
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer; // 6 bytes > 4-byte cap
  af.upload({ localId: "att-x", name: "big.png", mime: "image/png", bytes });
  await flushPromises();
  assert.equal(requests.length, 0, "an over-cap image must not be uploaded");
  const result = af.result("att-x");
  assert.equal(result.ok, false);
  assert.match(result.error, /larger than/);
});

test("a poisoned attachments array cannot wedge the queue or the tab (E5)", async () => {
  const chrome = await createChromeHarness();

  // An untrusted artifact controls the queued prompt wholesale. Dereferencing each
  // entry unvalidated throws inside render() - but the prompt is persisted BEFORE
  // the render, so the poison survives in sessionStorage and re-throws on every
  // reload, wedging the tab for good.
  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "poison", selector: "h1", tag: "annotation", text: "", attachments: [null] },
  });

  assert.deepEqual(chrome.queued(), [{ prompt: "poison", selector: "h1", tag: "annotation", text: "" }]);
  assert.doesNotMatch(chrome.element("annotationPills").innerHTML, /pill-attachment/);
});

test("only well-formed attachment refs survive the enqueue path (E5)", async () => {
  const chrome = await createChromeHarness();
  const good = "a".repeat(64) + ".png";

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: {
      prompt: "mixed",
      selector: "h1",
      tag: "annotation",
      text: "",
      attachments: [null, { id: good, name: "ok.png" }, "nope", { name: "no-id.png" }, ["nested"], { id: "" }],
    },
  });

  // The one real ref is kept; every malformed entry is dropped before persisting,
  // so what reaches the server (and the +N count) reflects only deliverable images.
  assert.deepEqual(chrome.queued()[0].attachments, [{ id: good, name: "ok.png" }]);
  assert.equal(chrome.element("annotationPills").innerHTML.match(/class="pill-attachment"/g)?.length, 1);
});

test("a non-array attachments field cannot wedge the queue (E5)", async () => {
  const chrome = await createChromeHarness();

  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "bad", selector: "h1", tag: "annotation", text: "", attachments: "not-an-array" },
  });

  assert.deepEqual(chrome.queued(), [{ prompt: "bad", selector: "h1", tag: "annotation", text: "" }]);
});

test("a poisoned prompt already in sessionStorage cannot wedge a reload (E5)", async () => {
  const chrome = await createChromeHarness({
    storedQueue: [{ prompt: "old poison", selector: "h1", tag: "annotation", text: "", attachments: [null] }],
  });

  // A tab poisoned before this fix still has the bad prompt on disk; loading it
  // must not throw, or the tab stays wedged even after upgrading.
  assert.doesNotMatch(chrome.element("annotationPills").innerHTML, /pill-attachment/);
  assert.match(chrome.element("annotationPills").innerHTML, /old poison/);
});

test("the chrome never honors an attachment delete driven by the artifact iframe (E2)", async () => {
  const requests = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ status: "removed" }) };
    },
  });

  // The iframe is untrusted, and the chrome cannot see chips that are ready but
  // not yet queued in ANOTHER tab. Honoring this delete lets one tab (or a
  // malicious artifact) destroy bytes another live card still needs, which then
  // fails as not-found on send. Reclamation belongs to the reference-aware sweeper.
  chrome.sendFrameMessage({ type: "lavish:removeAttachment", id: "a".repeat(64) + ".png" });
  await flushPromises();

  assert.deepEqual(
    requests.filter((request) => request.options?.method === "DELETE"),
    [],
  );
});

test("a queued attachment ref is projected to primitives, not kept by reference (E5)", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });
  const id = "a".repeat(64) + ".png";

  // structuredClone (what postMessage really uses) faithfully carries BigInt and
  // cycles, and neither survives JSON. Filtering entries but keeping the artifact's
  // own objects lets that junk ride along into sessionStorage and the POST body,
  // where JSON.stringify throws and the queue can no longer be sent - a subtler
  // repeat of the poisoned-queue wedge.
  const hostile = { id, name: "ok.png", big: 10n };
  hostile.self = hostile;
  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "hostile", selector: "h1", tag: "annotation", text: "", attachments: [hostile] },
  });

  assert.deepEqual(chrome.queued()[0].attachments, [{ id, name: "ok.png" }]);

  chrome.element("send").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();

  assert.equal(posts.length, 1, "the queue is still sendable");
  assert.deepEqual(posts[0].body.prompts[0].attachments, [{ id, name: "ok.png" }]);
});

test("a non-string attachment name is dropped rather than carried (E5)", async () => {
  const chrome = await createChromeHarness();
  const id = "b".repeat(64) + ".png";
  chrome.sendFrameMessage({
    type: "lavish:queuePrompt",
    prompt: { prompt: "x", selector: "h1", tag: "annotation", text: "", attachments: [{ id, name: { evil: true } }] },
  });
  assert.deepEqual(chrome.queued()[0].attachments, [{ id }]);
});

test("the chrome bounds concurrent in-flight uploads (D8)", async () => {
  let started = 0;
  /** @type {(value?: any) => void} */
  let releaseAll = () => {};
  const gate = new Promise((resolve) => {
    releaseAll = resolve;
  });
  const chrome = await createChromeHarness({
    fetchImpl: async (url) => {
      if (String(url).includes("/attachment-channel")) return { ok: true };
      started += 1;
      // Hang every upload so they all stay in flight until released.
      await gate;
      return { ok: true, json: async () => ({ attachment: { id: "a".repeat(64) + ".png" } }) };
    },
  });
  const af = chrome.createAttachmentFrame();
  af.ready();
  await flushPromises();

  // Eight small uploads at once: under the rate cap (30) and the byte quota, so only
  // an in-flight bound can stop them. Without it, all eight hit the network at once,
  // holding eight large bodies (structured clones + server buffers) concurrently.
  for (let i = 0; i < 8; i += 1) {
    af.upload({ localId: "u-" + i, mime: "image/png", bytes: new ArrayBuffer(16) });
  }
  await flushPromises();

  assert.ok(started <= 4, `at most the in-flight bound reach the network at once, got ${started}`);
  // The ones over the bound are refused (not left hanging "uploading" forever), so
  // the card can retry once capacity frees.
  const refused = af.posted.filter(
    (m) =>
      m.type === "lavish-attachment:uploadResult" &&
      m.ok === false &&
      /in flight|in-flight|concurrent|Wait a moment/i.test(m.error || ""),
  );
  assert.ok(refused.length >= 4, `the over-bound uploads are refused with a retry hint, got ${refused.length}`);

  releaseAll();
  await flushPromises();
});

test("a settled upload frees an in-flight slot for the next (D8)", async () => {
  /** @type {Array<() => void>} */
  const resolvers = [];
  const chrome = await createChromeHarness({
    fetchImpl: (url) => {
      if (String(url).includes("/attachment-channel")) return Promise.resolve({ ok: true });
      return new Promise((resolve) => {
        resolvers.push(() =>
          resolve(
            /** @type {any} */ ({ ok: true, json: async () => ({ attachment: { id: "b".repeat(64) + ".png" } }) }),
          ),
        );
      });
    },
  });
  const af = chrome.createAttachmentFrame();
  af.ready();
  await flushPromises();

  // Fill the in-flight bound.
  for (let i = 0; i < 4; i += 1) {
    af.upload({ localId: "a-" + i, mime: "image/png", bytes: new ArrayBuffer(16) });
  }
  await flushPromises();
  const startedBefore = resolvers.length;

  // Settle one; its slot must free so a fresh upload can proceed.
  resolvers[0]();
  await flushPromises();
  await flushPromises();

  af.upload({ localId: "next", mime: "image/png", bytes: new ArrayBuffer(16) });
  await flushPromises();

  assert.equal(resolvers.length, startedBefore + 1, "a freed slot admits the next upload");
});
