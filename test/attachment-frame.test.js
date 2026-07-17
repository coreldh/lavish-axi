import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { createAttachmentFrameHtml, createAttachmentFrameJs } from "../src/server.js";

// The capture frame (root A) runs the real serialized bundle in a fake DOM, so
// these assertions exercise the exact shipped code that reads image bytes OUTSIDE
// the artifact realm and reports to window.top (the chrome).

function fakeFile(name, type, size = 8) {
  return {
    name,
    type,
    size,
    arrayBuffer: async () => new ArrayBuffer(size),
  };
}

function makeElement() {
  const listeners = new Map();
  const classes = new Set();
  return {
    innerHTML: "",
    hidden: false,
    value: "",
    files: null,
    style: {},
    classList: {
      add: (n) => classes.add(n),
      remove: (n) => classes.delete(n),
      contains: (n) => classes.has(n),
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    querySelectorAll() {
      return [];
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
    click() {},
    focus() {},
    fire(type, event = {}) {
      const handler = listeners.get(type);
      if (handler) handler({ preventDefault() {}, ...event });
    },
    listeners,
  };
}

function bootFrame({ session = "sess-1", maxCount = 4, maxBytes = 0, cardNonce = "cardA" } = {}) {
  const elements = {
    list: makeElement(),
    notice: makeElement(),
    file: makeElement(),
    zone: makeElement(),
  };
  const postedToTop = [];
  const topWindow = {
    postMessage(message) {
      postedToTop.push(message);
    },
  };
  const windowListeners = new Map();
  const documentListeners = new Map();
  let objectUrlCounter = 0;
  const context = {
    console,
    window: {
      top: topWindow,
      location: {
        search:
          "?" +
          new URLSearchParams(Object.entries({ session, card: cardNonce }).filter(([, v]) => v !== "")).toString(),
      },
      addEventListener(type, handler) {
        windowListeners.set(type, handler);
      },
    },
    URLSearchParams,
    document: {
      // The frame reports body.scrollHeight (true content), NOT
      // documentElement.scrollHeight (floored at the iframe viewport).
      documentElement: { scrollHeight: 2029 },
      body: { scrollHeight: 43 },
      getElementById(id) {
        return elements[id] || null;
      },
      addEventListener(type, handler) {
        documentListeners.set(type, handler);
      },
    },
    URL: {
      createObjectURL: () => "blob:frame-" + ++objectUrlCounter,
      revokeObjectURL() {},
    },
  };
  vm.runInNewContext(createAttachmentFrameJs({ maxCount, maxBytes }), context, {
    filename: "attachment-frame.js",
  });
  return {
    elements,
    postedToTop,
    session,
    // Deliver a message "from the chrome" (event.source === window.top).
    fromTop(data) {
      const handler = windowListeners.get("message");
      assert.ok(handler, "the frame registered a message listener");
      handler({ source: topWindow, data });
    },
    fromOther(data) {
      const handler = windowListeners.get("message");
      handler({ source: { name: "artifact" }, data });
    },
    firePaste(clipboardData) {
      documentListeners.get("paste")?.({ preventDefault() {}, clipboardData });
    },
    lastState() {
      return postedToTop.filter((m) => m.type === "lavish-attachment:state").at(-1);
    },
    uploads() {
      return postedToTop.filter((m) => m.type === "lavish-attachment:upload");
    },
  };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("the frame announces readiness with its session id (R12)", () => {
  const frame = bootFrame({ session: "abc" });
  const ready = frame.postedToTop.find((m) => m.type === "lavish-attachment:ready");
  assert.ok(ready);
  assert.equal(ready.session, "abc");
});

test("the frame reports its initial state when the chrome acks the binding (reveal)", () => {
  const frame = bootFrame({ session: "abc" });
  const before = frame.postedToTop.filter((m) => m.type === "lavish-attachment:state").length;
  frame.fromTop({ type: "lavish-attachment:bound", session: "abc" });
  const state = frame.lastState();
  assert.ok(state, "an initial state is reported on bind");
  assert.equal(state.items.length, 0);
  // The reported height is the true CONTENT height (body.scrollHeight, 43), not the
  // viewport-floored documentElement.scrollHeight (2029) — else the iframe would
  // inflate to its own viewport and never shrink back when chips are removed.
  assert.equal(state.height, 43, "the reported height is body content height, not the viewport");
  assert.ok(
    frame.postedToTop.filter((m) => m.type === "lavish-attachment:state").length > before,
    "the bind ack triggers a fresh state report",
  );
});

test("the frame stamps its cardNonce on the reveal state AND every later state (R11)", async () => {
  const frame = bootFrame({ session: "abc", cardNonce: "cardA" });
  frame.fromTop({ type: "lavish-attachment:bound", session: "abc" });
  // Reveal state carries the nonce.
  assert.equal(frame.lastState().cardNonce, "cardA");
  // A capture triggers more state reports; all carry the same nonce.
  frame.elements.file.files = [fakeFile("shot.png", "image/png")];
  frame.elements.file.fire("change");
  await flush();
  const states = frame.postedToTop.filter((m) => m.type === "lavish-attachment:state");
  assert.ok(states.length >= 2, "capture produced additional state reports");
  assert.ok(
    states.every((s) => s.cardNonce === "cardA"),
    "every state report carries the card's nonce",
  );
});

test("a frame with no ?card query param stamps an empty nonce, failing closed (R11)", () => {
  const frame = bootFrame({ session: "abc", cardNonce: "" });
  frame.fromTop({ type: "lavish-attachment:bound", session: "abc" });
  assert.equal(frame.lastState().cardNonce, "", "no card param -> empty nonce (mirror fails closed)");
});

test("a card nonce with URL-special characters round-trips through the query string (R11)", () => {
  // Real nonces are [c0-9a-z], but the encode(SDK)->decode(frame) contract must be
  // exact for any value, or a legit card's own state would fail to match.
  const weird = "c1 a&b=c%d/e";
  const frame = bootFrame({ session: "abc", cardNonce: weird });
  frame.fromTop({ type: "lavish-attachment:bound", session: "abc" });
  assert.equal(frame.lastState().cardNonce, weird, "the nonce survives encode/decode intact");
});

test("a paste captured before any bound ack still ships bytes and stamps the nonce (R11)", async () => {
  // The frame captures autonomously - it does not wait for the chrome's bound ack to
  // read bytes and post the upload/state (each carrying the card nonce). Whether the
  // chrome accepts an upload before it has bound is the chrome's concern; the frame
  // never loses the capture or the nonce.
  const frame = bootFrame({ session: "abc", cardNonce: "cardA" });
  frame.firePaste({ files: [fakeFile("paste.png", "image/png")] });
  await flush();
  assert.equal(frame.uploads().length, 1, "the paste is captured and its bytes shipped");
  assert.equal(frame.uploads()[0].session, "abc");
  assert.equal(frame.lastState().cardNonce, "cardA", "the pre-bind state still carries the nonce");
});

test("a picked image is read in the frame and its bytes are shipped to window.top", async () => {
  const frame = bootFrame();
  frame.elements.file.files = [fakeFile("shot.png", "image/png")];
  frame.elements.file.fire("change");
  await flush();
  const uploads = frame.uploads();
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].session, frame.session);
  assert.equal(uploads[0].name, "shot.png");
  assert.ok(uploads[0].bytes instanceof ArrayBuffer, "the frame ships the raw bytes to the chrome");
  // While uploading, the relayed state marks the item pending and carries no bytes.
  const state = frame.lastState();
  assert.equal(state.items[0].status, "uploading");
  assert.equal(state.items[0].id, "");
  assert.equal("bytes" in state.items[0], false, "relayed state never carries bytes");
  assert.equal(typeof state.height, "number");
});

test("an upload result from the chrome marks the item ready with the server id", async () => {
  const frame = bootFrame();
  frame.elements.file.files = [fakeFile("shot.png", "image/png")];
  frame.elements.file.fire("change");
  await flush();
  const localId = frame.uploads()[0].localId;
  const id = "a".repeat(64) + ".png";
  frame.fromTop({ type: "lavish-attachment:uploadResult", session: frame.session, localId, ok: true, id });
  const state = frame.lastState();
  assert.equal(state.items[0].status, "ready");
  assert.equal(state.items[0].id, id);
});

test("the frame ignores commands not from window.top or with a wrong session (root A / R12)", async () => {
  const frame = bootFrame({ session: "real" });
  frame.elements.file.files = [fakeFile("shot.png", "image/png")];
  frame.elements.file.fire("change");
  await flush();
  const localId = frame.uploads()[0].localId;
  const id = "a".repeat(64) + ".png";
  // Not from window.top (e.g. the artifact parent posting into the frame).
  frame.fromOther({ type: "lavish-attachment:uploadResult", session: "real", localId, ok: true, id });
  // From top but a mismatched session.
  frame.fromTop({ type: "lavish-attachment:uploadResult", session: "forged", localId, ok: true, id });
  assert.equal(frame.lastState().items[0].status, "uploading", "neither hostile result marks the item ready");
});

test("an over-size image is rejected in the frame and never read (round7-a)", async () => {
  const frame = bootFrame({ maxBytes: 4 });
  frame.elements.file.files = [fakeFile("big.png", "image/png", 64)];
  frame.elements.file.fire("change");
  await flush();
  assert.equal(frame.uploads().length, 0, "the oversize file is never shipped");
  const state = frame.lastState();
  assert.equal(state.items[0].status, "error");
});

test("a pasted image is captured by the frame, not the artifact card", async () => {
  const frame = bootFrame();
  frame.firePaste({ files: [fakeFile("paste.png", "image/png")] });
  await flush();
  assert.equal(frame.uploads().length, 1);
  assert.equal(frame.uploads()[0].name, "paste.png");
});

test("the frame HTML carries NO capability token - it is inert until the chrome binds it (R12)", () => {
  // R12: the page grants nothing on its own. The session id and card nonce ride in the
  // query string the chrome sets; the chrome binds by frame identity, not any token in
  // the page. So loading /attachment-frame gives an artifact no capability.
  const html = createAttachmentFrameHtml({ maxCount: 4, maxBytes: 10 });
  assert.doesNotMatch(html, /channelToken|"channelToken"/, "no channel token is embedded");
  assert.match(html, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(html, /id="zone"/);
});

test("the frame bundle gates size before reading and reads bytes ONLY here (root A)", () => {
  const js = createAttachmentFrameJs({ maxBytes: 10 });
  // The classifier gate runs before any createObjectURL / arrayBuffer.
  const gateAt = js.indexOf("classifyAttachmentBatch(files, {");
  const urlAt = js.indexOf("URL.createObjectURL");
  assert.ok(gateAt !== -1 && urlAt !== -1);
  assert.ok(gateAt < urlAt, "the size gate precedes createObjectURL");
  assert.match(js, /attachmentSizeError\(file\.size, maxBytes\)/);
  // The frame ships bytes to window.top; it never fetches the server itself.
  assert.match(js, /lavish-attachment:upload/);
  assert.doesNotMatch(js, /fetch\(/);
});
