import assert from "node:assert/strict";
import test from "node:test";

import {
  attachmentQueueBlockReason,
  buildAttachmentControllerDeps,
  clampCardPosition,
  createAttachmentsController,
  resolveAttachmentMaxCount,
} from "../src/artifact-sdk.js";
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

test("the count cap counts only images, not UNSUPPORTED_TYPE placeholders (W1 + F4)", () => {
  const state = makeController({ maxCount: 1 });
  // A rejected non-image adds an error placeholder chip (file: null).
  state.controller.rejectUnsupported(["doc.pdf"]);
  // A valid image must still be accepted - the placeholder is a notice, not an
  // attachment, so it does not consume the single image slot.
  assert.equal(state.controller.addFiles([pngFile("a.png")]), true, "the image is accepted alongside a reject chip");
  assert.equal(state.notices.length, 0, "the unsupported placeholder did not consume the image slot");
  // But a SECOND image is genuinely over the cap of 1.
  state.controller.addFiles([pngFile("b.png")]);
  assert.match(state.notices.at(-1), /up to 1 image/);
});

test("buildAttachmentControllerDeps derives the card cap from the SERVER option and stamps the nonce (W1 + F1)", () => {
  const sent = [];
  const io = {
    acceptedMime: { "image/png": true },
    renderChip: () => "",
    documentNonce: "doc-9",
    nextLocalId: () => "x",
    sendToChrome: (message) => sent.push(message),
    createObjectUrl: () => "blob:x",
    revokeObjectUrl: () => {},
  };
  // The production wiring derives maxCount from the server option here - a hardcoded
  // revert would make these fail even though the controller test injects its own cap.
  assert.equal(buildAttachmentControllerDeps({ maxAttachmentCount: 7 }, io).maxCount, 7);
  assert.equal(buildAttachmentControllerDeps({}, io).maxCount, 4);
  assert.equal(buildAttachmentControllerDeps({ maxAttachmentCount: 0 }, io).maxCount, 4);

  // Every outgoing message is stamped with the document nonce (F1).
  buildAttachmentControllerDeps({}, io).postMessage({ type: "lavish:uploadAttachment", localId: "z" });
  assert.deepEqual(sent.at(-1), { type: "lavish:uploadAttachment", localId: "z", documentNonce: "doc-9" });
  // The acceptedMime + object-url deps are passed straight through.
  const deps = buildAttachmentControllerDeps({}, io);
  assert.equal(deps.acceptedMime, io.acceptedMime);
  assert.equal(deps.createObjectUrl, io.createObjectUrl);
});

test("attachmentQueueBlockReason blocks the queue on pending OR errored chips, using the real controller (R2.4 + W2)", () => {
  const clean = makeController();
  assert.equal(attachmentQueueBlockReason(clean.controller), null);

  const errored = makeController();
  errored.controller.rejectUnsupported(["a.pdf"]);
  assert.equal(attachmentQueueBlockReason(errored.controller), "errors");

  // An in-flight upload (fake arrayBuffer never resolves to ready) stays "uploading".
  const pending = makeController();
  pending.controller.addFiles([pngFile()]);
  assert.equal(attachmentQueueBlockReason(pending.controller), "pending");
});

test("clampCardPosition keeps the annotation card inside the viewport (W3)", () => {
  // A comfortably-fitting card just anchors below-left of the target.
  assert.deepEqual(
    clampCardPosition({ left: 100, bottom: 40 }, { width: 320, height: 200 }, { width: 1440, height: 900 }),
    { left: 100, top: 48 },
  );
  // A card whose bottom would fall off-screen (e.g. after chip rows grow it) is pulled
  // up so its full height - Queue/Cancel included - stays inside the viewport (W3).
  const grown = clampCardPosition(
    { left: 100, bottom: 800 },
    { width: 320, height: 300 },
    { width: 1440, height: 900 },
  );
  assert.equal(grown.top, 900 - 300 - 12);
  assert.ok(grown.top + 300 <= 900, "the whole card fits within the viewport height");
  // A card near the right/top edges is pulled in and floored at the 12px margin.
  assert.equal(
    clampCardPosition({ left: 1400, bottom: 40 }, { width: 320, height: 200 }, { width: 1440, height: 900 }).left,
    1440 - 320 - 12,
  );
  assert.equal(
    clampCardPosition({ left: 4, bottom: -20 }, { width: 320, height: 200 }, { width: 1440, height: 900 }).top,
    12,
  );
  assert.equal(
    clampCardPosition({ left: 4, bottom: 40 }, { width: 320, height: 200 }, { width: 1440, height: 900 }).left,
    12,
  );
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
  // ...and only an EXACT nonce match is honored, so a missing/empty or stale nonce is
  // rejected (a truthiness check would let a nonce-less crafted result through).
  assert.match(sdk, /if \(msg\.documentNonce !== documentNonce\) return;/);
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

test("the SDK bundle gates queuing via attachmentQueueBlockReason and only sends when queued (R2.4 + W2)", () => {
  assert.match(sdk, /const block = attachmentQueueBlockReason\(attachments\)/);
  assert.match(sdk, /block === "pending"/);
  assert.match(sdk, /Waiting for an image to finish uploading/);
  assert.match(sdk, /block === "errors"/);
  // W3 wiring: the card passes positionCard as onLayout so chip rows re-clamp it.
  assert.match(sdk, /onLayout: positionCard/);
  assert.match(sdk, /const queued = tryQueue\(\);\s*\n?\s*[\s\S]*?if \(queued && sendNow\) sendQueuedPrompts\(\)/);
});
