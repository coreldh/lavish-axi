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

function bootFrame({ channelToken = "tok-1", maxCount = 4, maxBytes = 0 } = {}) {
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
      addEventListener(type, handler) {
        windowListeners.set(type, handler);
      },
    },
    document: {
      documentElement: { scrollHeight: 176 },
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
  vm.runInNewContext(createAttachmentFrameJs({ channelToken, maxCount, maxBytes }), context, {
    filename: "attachment-frame.js",
  });
  return {
    elements,
    postedToTop,
    channelToken,
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

test("the frame announces readiness with its channel token", () => {
  const frame = bootFrame({ channelToken: "abc" });
  const ready = frame.postedToTop.find((m) => m.type === "lavish-attachment:ready");
  assert.ok(ready);
  assert.equal(ready.channelToken, "abc");
});

test("the frame reports its initial state when the chrome acks the binding (reveal)", () => {
  const frame = bootFrame({ channelToken: "abc" });
  const before = frame.postedToTop.filter((m) => m.type === "lavish-attachment:state").length;
  frame.fromTop({ type: "lavish-attachment:bound", channelId: "abc" });
  const state = frame.lastState();
  assert.ok(state, "an initial state is reported on bind");
  assert.equal(state.items.length, 0);
  assert.ok(state.height > 0, "the reported height lets the card size and reveal the frame");
  assert.ok(
    frame.postedToTop.filter((m) => m.type === "lavish-attachment:state").length > before,
    "the bind ack triggers a fresh state report",
  );
});

test("a picked image is read in the frame and its bytes are shipped to window.top", async () => {
  const frame = bootFrame();
  frame.elements.file.files = [fakeFile("shot.png", "image/png")];
  frame.elements.file.fire("change");
  await flush();
  const uploads = frame.uploads();
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].channelId, frame.channelToken);
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
  frame.fromTop({ type: "lavish-attachment:uploadResult", channelId: frame.channelToken, localId, ok: true, id });
  const state = frame.lastState();
  assert.equal(state.items[0].status, "ready");
  assert.equal(state.items[0].id, id);
});

test("the frame ignores results not from window.top or with a wrong channel token (root A / E1)", async () => {
  const frame = bootFrame({ channelToken: "real" });
  frame.elements.file.files = [fakeFile("shot.png", "image/png")];
  frame.elements.file.fire("change");
  await flush();
  const localId = frame.uploads()[0].localId;
  const id = "a".repeat(64) + ".png";
  // Not from window.top (e.g. the artifact parent posting into the frame).
  frame.fromOther({ type: "lavish-attachment:uploadResult", channelId: "real", localId, ok: true, id });
  // From top but wrong channel token.
  frame.fromTop({ type: "lavish-attachment:uploadResult", channelId: "forged", localId, ok: true, id });
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

test("the frame HTML carries the channel token and a scripts-only sandbox posture", () => {
  const html = createAttachmentFrameHtml("token-xyz", { maxCount: 4, maxBytes: 10 });
  assert.match(html, /token-xyz/);
  assert.match(html, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(html, /id="zone"/);
});

test("the frame bundle gates size before reading and reads bytes ONLY here (root A)", () => {
  const js = createAttachmentFrameJs({ channelToken: "t", maxBytes: 10 });
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
