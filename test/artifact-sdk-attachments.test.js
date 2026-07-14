import assert from "node:assert/strict";
import test from "node:test";

import { createAttachmentsController, resolveAttachmentMaxCount } from "../src/artifact-sdk.js";
import { createSdkJs } from "../src/server.js";

// The annotation card lives inside the sandboxed artifact iframe, so its full
// behavior can only be exercised in a real browser. The controller logic, however,
// is factored out as `createAttachmentsController` with every browser dependency
// injected, so the count cap (W1), error-state gate (W2), re-clamp (W3), and batched
// reject render (F7) are exercised BEHAVIORALLY here with fakes - not just pattern
// matched. A few remaining assertions pin the SDK<->chrome message contract in the
// serialized bundle, where a browser is genuinely required.
const sdk = createSdkJs("0123456789abcdef");

// A minimal, image-only File stand-in for add(): the controller reads .type/.name and
// calls the injected createObjectUrl + upload (item.file.arrayBuffer()).
function pngFile(name = "img.png") {
  return { type: "image/png", name, arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)) };
}

// Build a controller wired to fakes, exposing what the tests observe.
function makeController(overrides = {}) {
  const notices = [];
  const posted = [];
  let layouts = 0;
  let localSeq = 0;
  const listEl = { innerHTML: "", hidden: true, querySelectorAll: () => [] };
  const controller = createAttachmentsController(/** @type {any} */ (listEl), {
    maxCount: 4,
    acceptedMime: { "image/png": true, "image/jpeg": true, "image/webp": true },
    renderChip: () => "|",
    nextLocalId: () => "att-" + ++localSeq,
    notify: (message) => notices.push(message),
    onLayout: () => {
      layouts += 1;
    },
    postMessage: (message) => posted.push(message),
    createObjectUrl: () => "blob:x",
    revokeObjectUrl: () => {},
    ...overrides,
  });
  return { controller, listEl, notices, posted, layoutCount: () => layouts };
}

test("resolveAttachmentMaxCount maps the server option to the cap, else falls back to 4 (W1)", () => {
  assert.equal(resolveAttachmentMaxCount({ maxAttachmentCount: 7 }), 7);
  assert.equal(resolveAttachmentMaxCount({ maxAttachmentCount: 1 }), 1);
  assert.equal(resolveAttachmentMaxCount({}), 4);
  assert.equal(resolveAttachmentMaxCount({ maxAttachmentCount: 0 }), 4);
  assert.equal(resolveAttachmentMaxCount({ maxAttachmentCount: -3 }), 4);
  assert.equal(resolveAttachmentMaxCount(), 4);
});

test("the attachment card enforces the CONFIGURED count cap, not a hardcoded value (W1)", () => {
  // Three picks over a cap of 2: the third is rejected and surfaced, not swallowed.
  const two = makeController({ maxCount: 2 });
  two.controller.addFiles([pngFile("a"), pngFile("b"), pngFile("c")]);
  assert.equal(two.notices.length, 1, "the 3rd pick over a cap of 2 is surfaced");
  assert.match(two.notices[0], /up to 2 images/);

  // The SAME three files fit under a cap of 4 - proving the guard reads the injected
  // cap. If the guard reverted to a hardcoded 4, the maxCount:2 case would stop firing.
  const four = makeController({ maxCount: 4 });
  four.controller.addFiles([pngFile("a"), pngFile("b"), pngFile("c")]);
  assert.equal(four.notices.length, 0, "three images fit under a cap of 4");

  // Singular wording when the cap is exactly 1.
  const one = makeController({ maxCount: 1 });
  one.controller.addFiles([pngFile("a"), pngFile("b")]);
  assert.match(one.notices[0], /up to 1 image\./);
});

test("hasErrors flags failed and rejected chips that collectReady would otherwise drop (W2)", () => {
  const { controller } = makeController();
  assert.equal(controller.hasErrors(), false);

  // A rejected non-image is an error chip with no ready id.
  controller.rejectUnsupported(["notes.pdf"]);
  assert.equal(controller.hasErrors(), true);
  assert.deepEqual(controller.collectReady(), [], "the error chip is never collected as ready");

  // A failed upload is likewise an error the queue path must not silently drop.
  const failed = makeController();
  failed.controller.addFiles([pngFile("a")]);
  failed.controller.handleResult("att-1", false, "", "boom");
  assert.equal(failed.controller.hasErrors(), true);
  assert.deepEqual(failed.controller.collectReady(), []);
});

test("the card re-clamps into the viewport by calling onLayout after every render (W3)", () => {
  const state = makeController();
  const initial = state.layoutCount(); // one render at construction
  assert.ok(initial >= 1, "the controller renders (and clamps) once on creation");
  state.controller.rejectUnsupported(["a.pdf"]);
  assert.equal(state.layoutCount(), initial + 1, "adding a chip row re-clamps exactly once");
});

test("rejectUnsupported adds one chip per file but renders ONCE for the batch (F7)", () => {
  const state = makeController();
  const before = state.layoutCount();
  state.controller.rejectUnsupported(["a.pdf", "b.zip", "c.doc"]);
  assert.equal(state.layoutCount(), before + 1, "three unsupported files -> a single render, not quadratic");
  assert.equal(state.listEl.innerHTML, "|||", "one chip per unsupported file");
  assert.equal(state.controller.hasErrors(), true);
});

test("collectReady returns only ready ids and their display names", () => {
  const { controller } = makeController();
  controller.addFiles([pngFile("shot.png")]);
  controller.handleResult("att-1", true, "a".repeat(64) + ".png");
  assert.deepEqual(controller.collectReady(), [{ id: "a".repeat(64) + ".png", name: "shot.png" }]);
  assert.equal(controller.hasReady(), true);
});

test("the SDK bundle uploads captured images through the chrome and applies results", () => {
  assert.match(sdk, /"lavish:uploadAttachment"/);
  assert.match(sdk, /\.arrayBuffer\(\)/);
  assert.match(sdk, /"lavish:attachmentResult"/);
  assert.match(sdk, /handleResult\(msg\.localId, msg\.ok, msg\.id, msg\.error\)/);
  assert.match(sdk, /data-attachment-retry/);
});

test("upload results are bound to the document by a nonce so a stale reload can't cross-mark a chip (F1)", () => {
  assert.match(sdk, /const documentNonce =/);
  // Stamped on every outgoing controller message...
  assert.match(sdk, /\.\.\.message, documentNonce/);
  // ...and stale results (from a pre-reload document) are dropped on the way in.
  assert.match(sdk, /msg\.documentNonce && msg\.documentNonce !== documentNonce/);
});

test("a mixed drop partial-accepts images AND reports unsupported files (F4)", () => {
  assert.match(sdk, /partitionDroppedFiles/);
  assert.match(sdk, /if \(images\.length\) attachments\.addFiles\(images\)/);
  assert.match(sdk, /if \(unsupportedNames\.length\) attachments\.rejectUnsupported\(unsupportedNames\)/);
  assert.match(sdk, /error: "UNSUPPORTED_TYPE"/);
});

test("the card no longer eagerly deletes a removed chip's file, deferring to the sweeper (F6)", () => {
  // Removing a chip must not issue a cross-tab-unsafe DELETE; reclamation is the
  // reference-aware sweeper's job now, so the SDK never sends removeAttachment.
  assert.doesNotMatch(sdk, /lavish:removeAttachment/);
  assert.doesNotMatch(sdk, /other\.id === item\.id/);
});

test("the SDK bundle carries ready attachment refs on the queued prompt", () => {
  assert.match(sdk, /options\.attachments/);
  assert.match(sdk, /item\.attachments = attachments/);
  assert.match(sdk, /queuePrompt\(prompt, \{ \.\.\.c, queueKey: "", attachments: readyAttachments \}\)/);
});

test("the SDK bundle only accepts PNG, JPEG, and WebP images", () => {
  assert.match(sdk, /ATTACHMENT_ACCEPTED_MIME = \{ "image\/png": true, "image\/jpeg": true, "image\/webp": true \}/);
  assert.match(sdk, /accept="image\/png,image\/jpeg,image\/webp"/);
});

test("the SDK bundle renders chips with a thumbnail, name, status, and a titled remove control", () => {
  assert.match(sdk, /lavish-attachment-thumb/);
  assert.match(sdk, /lavish-attachment-name/);
  assert.match(sdk, /Uploading…/);
  assert.match(sdk, /revokeObjectURL/);
  assert.match(sdk, /aria-label="Remove image" title="Remove"/);
  assert.match(sdk, /lavish-attachment-remove/);
});

test("the SDK bundle gates queuing until in-flight uploads settle and errors clear (R2.4 + W2)", () => {
  assert.match(sdk, /if \(attachments\.hasPending\(\)\)/);
  assert.match(sdk, /Waiting for an image to finish uploading/);
  assert.match(sdk, /if \(attachments\.hasErrors\(\)\)/);
  assert.match(sdk, /const queued = tryQueue\(\);\s*\n?\s*[\s\S]*?if \(queued && sendNow\) sendQueuedPrompts\(\)/);
});
