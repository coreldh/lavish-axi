import assert from "node:assert/strict";
import test from "node:test";

import {
  attachmentSizeError,
  attachmentStateAppliesToCard,
  classifyAttachmentBatch,
  deriveAttachmentNoticeState,
  partitionDroppedFiles,
} from "../src/artifact-sdk.js";
import { createSdkJs } from "../src/server.js";

// The annotation card lives inside the sandboxed artifact iframe, so its image
// attachment behavior can only be exercised in a real browser. These assertions
// pin the SDK <-> chrome message contract in the serialized bundle. Since root A,
// image acquisition and every byte live in the chrome-served capture frame
// (`/attachment-frame`); the artifact-realm SDK only embeds that frame and mirrors
// the non-sensitive state the chrome relays. The invariant test below proves the
// bundle has NO byte path at all.
const sdk = createSdkJs("0123456789abcdef");

// ROOT A INVARIANT (R10): no path reachable from the artifact/untrusted realm can
// obtain raw image bytes or invoke a write/delete. The SDK bundle is the entire
// artifact-realm surface, so this is checkable directly on the serialized text.
test("the SDK bundle has NO attachment byte path or write/delete (root A invariant)", () => {
  // No byte reads of a captured file, no object URLs of raw bytes, no file input.
  assert.doesNotMatch(sdk, /\.arrayBuffer\(\)/, "the artifact realm never reads file bytes");
  assert.doesNotMatch(sdk, /createObjectURL/, "the artifact realm never materializes raw image bytes");
  assert.doesNotMatch(sdk, /type="file"/, "the artifact realm hosts no file picker");
  assert.doesNotMatch(sdk, /FileReader/, "the artifact realm uses no FileReader");
  // No same-origin server write/delete of attachments from the artifact realm.
  assert.doesNotMatch(sdk, /fetch\(/, "the artifact realm makes no server requests");
  assert.doesNotMatch(sdk, /lavish:uploadAttachment/, "the artifact realm never ships bytes to the chrome");
  assert.doesNotMatch(sdk, /method:\s*"DELETE"/, "the artifact realm invokes no delete");
  // The capture surface is a chrome-served, sandboxed frame - not artifact DOM.
  assert.match(sdk, /src="\/attachment-frame\?card=/);
  assert.match(sdk, /sandbox="allow-scripts allow-popups"/);
});

test("the SDK bundle embeds the chrome-served capture frame and mirrors its state (root A)", () => {
  // The card embeds the isolated frame and reacts only to chrome-relayed state.
  assert.match(sdk, /class="lavish-attach-frame"/);
  assert.match(sdk, /if \(msg\.type === "lavish:attachmentState"\)/);
  assert.match(sdk, /activeAttachments\?\.applyState\(msg\.state \|\| \{\}\)/);
  // The mirror is coerced to primitives - never the relayed objects by reference.
  assert.match(sdk, /function applyState\(state\)/);
  assert.match(sdk, /typeof item\?\.id === "string"/);
});

test("the SDK bundle correlates every relayed state with the active card (R11, stale-frame drop)", () => {
  // Each card mints a fresh nonce, threads it into its frame's iframe query string,
  // and applyState drops any relayed state whose nonce does not match this card's -
  // so a retired frame's late state never lands on a freshly opened card.
  assert.match(sdk, /const attachmentStateAppliesToCard=/);
  assert.match(sdk, /if \(!attachmentStateAppliesToCard\(state, cardNonce\)\) return;/);
  assert.match(sdk, /\/attachment-frame\?card=['"] \+\s*\n?\s*encodeURIComponent\(cardNonce\)/);
  assert.match(sdk, /makeAttachmentsController\(\{\s*\n?\s*notify,\s*\n?\s*cardNonce,/);
});

test("a freshly opened card cannot pick up a retired frame's screenshot via a stale token (R11)", () => {
  // The defect: card A attaches a screenshot; the user closes A and opens card B;
  // A's still-bound frame relays its late state, which (unfiltered) lands on B's
  // mirror - so B queues A's screenshot onto the wrong annotation. The fix
  // correlates every relayed state with the ACTIVE card's nonce.
  const aShot = {
    cardNonce: "cardA",
    items: [{ localId: "att-1", name: "secret.png", status: "ready", id: "a".repeat(64) + ".png" }],
  };
  // Card B (nonce "cardB") must DROP card A's late state - it never sees the shot.
  assert.equal(attachmentStateAppliesToCard(aShot, "cardB"), false);
  // The legitimate flow is intact: a card applies its OWN frame's state.
  assert.equal(attachmentStateAppliesToCard({ cardNonce: "cardB", items: [] }, "cardB"), true);
  assert.equal(
    attachmentStateAppliesToCard({ cardNonce: "cardA", items: aShot.items }, "cardA"),
    true,
    "card A applies its own frame's state",
  );
  // A state with no nonce, or a card with no nonce, never applies (fail-closed).
  assert.equal(attachmentStateAppliesToCard({ items: [] }, "cardB"), false);
  assert.equal(attachmentStateAppliesToCard(aShot, ""), false);
  assert.equal(attachmentStateAppliesToCard(null, "cardB"), false);
});

test("the SDK bundle carries ready attachment refs on the queued prompt", () => {
  assert.match(sdk, /options\.attachments/);
  assert.match(sdk, /item\.attachments = attachments/);
  assert.match(sdk, /queuePrompt\(prompt, \{ \.\.\.c, queueKey: "", attachments: readyAttachments \}\)/);
});

test("the SDK bundle gates queuing until in-flight uploads settle (R2.4)", () => {
  // hasPending flags any still-uploading (mirrored) chip, and the queue path bails
  // on it so an in-flight image is never silently dropped by collectReady/closeCard.
  assert.match(sdk, /function hasPending\(\)\s*\{\s*return items\.some\(\(item\) => item\.status === "uploading"\)/);
  assert.match(sdk, /if \(attachments\.hasPending\(\)\)/);
  assert.match(sdk, /Waiting for an image to finish uploading/);
  // "Send now" only fires when the queue actually happened.
  assert.match(sdk, /const queued = tryQueue\(\);\s*\n?\s*[\s\S]*?if \(queued && sendNow\) sendQueuedPrompts\(\)/);
});

test("the count-cap notice reads as an error, not as the passive keyboard hint", () => {
  // The cap notice replaces the card's gray hint line, so without its own error
  // styling it reads as passive help text and a rejected drop goes unnoticed.
  assert.match(sdk, /lavish-hint-alert/);
  assert.match(sdk, /\.lavish-hint-alert\{[^}]*color:#ff9d7a/);
  assert.match(sdk, /attachNotice\.classList\.add\("lavish-hint-alert"\)/);
  // Clearing the notice restores the neutral hint instead of leaving stale red text.
  assert.match(sdk, /attachNotice\.classList\.remove\("lavish-hint-alert"\)/);
});

test("the count-cap notice persists until attachment capacity is created", () => {
  const cap = "You can attach up to 4 images.";
  const waiting = "Waiting for an image to finish uploading…";
  const failed = "An image couldn't be attached. Retry or remove it before queuing.";
  const state = { itemCount: 4, maxCount: 4, capRejected: true, queueBlocked: false };

  assert.equal(deriveAttachmentNoticeState(state), cap);
  assert.equal(deriveAttachmentNoticeState({ ...state, queueBlocked: true, hasPending: true }), waiting);
  assert.equal(deriveAttachmentNoticeState({ ...state, queueBlocked: true, hasErrors: true }), failed);
  assert.equal(deriveAttachmentNoticeState({ ...state, queueBlocked: true, hasPending: true }), waiting);
  assert.equal(deriveAttachmentNoticeState({ ...state, queueBlocked: true }), cap);
  assert.equal(deriveAttachmentNoticeState({ ...state, itemCount: 3 }), "");

  assert.match(sdk, /notify\(\s*deriveAttachmentNoticeState\(/);
  assert.match(sdk, /attachNotice\.classList\.add\("lavish-hint-alert"\)/);
  // The mirror clears its queue-block once no relayed item is pending/errored.
  assert.match(sdk, /if \(!hasPending\(\) && !hasErrors\(\)\) queueBlocked = false/);
});

// The three tests that pinned the eager-delete classifier (`classifyAttachmentDelete`,
// its W-B "defer" parking, and the bundle's removeAttachment posting) are gone with
// it: E2 removed iframe-driven deletes outright, so the chrome never honors one and
// the reference-aware sweeper owns reclamation. See chrome-client-queue.test.js.

// E1 (cross-document result correlation) is now subsumed by the capture-frame
// architecture (root A): an upload result is delivered by the chrome ONLY to the
// bound frame's window carrying that frame's channel token, and a fresh card mints
// a fresh frame + token, so a stale result can never land on a new document's chip.
// See attachment-frame.test.js (frame-side channel binding) and
// chrome-client-queue.test.js (the chrome refuses unbound/mismatched-token frames).

const ACCEPTED = { "image/png": true, "image/jpeg": true, "image/webp": true };
const file = (name, type) => ({ name, type });

test("a mixed drop attaches the images AND reports every unsupported file (W4-a)", () => {
  // The ruled behavior: partial-accept. Keep the images the user dropped, and
  // surface one visible error chip per unsupported companion. Reporting the
  // unsupported files only when there were NO images is what made a mixed drop
  // swallow them silently.
  const { images, unsupported } = partitionDroppedFiles(
    { files: [file("shot.png", "image/png"), file("report.pdf", "application/pdf"), file("notes.txt", "text/plain")] },
    ACCEPTED,
  );

  assert.deepEqual(
    images.map((image) => image.name),
    ["shot.png"],
  );
  assert.deepEqual(unsupported, ["report.pdf", "notes.txt"]);
});

test("an all-image drop reports nothing unsupported (W4-a)", () => {
  const { images, unsupported } = partitionDroppedFiles(
    { files: [file("a.png", "image/png"), file("b.webp", "image/webp")] },
    ACCEPTED,
  );
  assert.equal(images.length, 2);
  assert.deepEqual(unsupported, []);
});

test("an all-unsupported drop reports each file and attaches none (W4-a)", () => {
  const { images, unsupported } = partitionDroppedFiles(
    { files: [file("report.pdf", "application/pdf"), file("archive.zip", "application/zip")] },
    ACCEPTED,
  );
  assert.deepEqual(images, []);
  assert.deepEqual(unsupported, ["report.pdf", "archive.zip"]);
});

test("a nameless unsupported file still gets a chip label (W4-a)", () => {
  const { unsupported } = partitionDroppedFiles({ files: [file("", "application/pdf")] }, ACCEPTED);
  assert.deepEqual(unsupported, ["file"]);
});

test("a pasted item list partitions the same way (W4-a)", () => {
  const png = file("pasted.png", "image/png");
  const { images, unsupported } = partitionDroppedFiles(
    {
      items: [
        { kind: "file", type: "image/png", getAsFile: () => png },
        { kind: "file", type: "application/pdf", getAsFile: () => file("x.pdf", "application/pdf") },
        { kind: "string", type: "text/plain", getAsFile: () => null },
      ],
    },
    ACCEPTED,
  );
  assert.deepEqual(images, [png]);
  assert.deepEqual(unsupported, ["file"]);
});

test("an empty drop partitions to nothing (W4-a)", () => {
  assert.deepEqual(partitionDroppedFiles(null, ACCEPTED), { images: [], unsupported: [] });
  assert.deepEqual(partitionDroppedFiles({}, ACCEPTED), { images: [], unsupported: [] });
});

test("attachmentSizeError rejects an over-limit file before it is read (round7-a)", () => {
  const cap = 10 * 1024 * 1024; // 10 MiB
  // Within the limit (and the boundary) is accepted.
  assert.equal(attachmentSizeError(1024, cap), "");
  assert.equal(attachmentSizeError(cap, cap), "");
  // Over the limit is rejected with a message that names the cap.
  const over = attachmentSizeError(cap + 1, cap);
  assert.notEqual(over, "");
  assert.match(over, /larger than/i);
  assert.match(over, /MB/);
  // A huge drop - the case that would otherwise be allocated + structured-cloned
  // into the chrome before any check - is refused.
  assert.notEqual(attachmentSizeError(2 * 1024 * 1024 * 1024, cap), "");
  // An unwired/disabled limit imposes no client-side gate (the server still caps).
  assert.equal(attachmentSizeError(cap + 1, 0), "");
  assert.equal(attachmentSizeError(cap + 1, undefined), "");
  assert.equal(attachmentSizeError(cap + 1, -1), "");
  // A non-finite size never throws and never falsely rejects.
  assert.equal(attachmentSizeError(NaN, cap), "");
});

// The size-gate-before-read and the batched classifier/drop wiring are now pinned
// against the CAPTURE FRAME bundle (root A), where acquisition lives - see
// attachment-frame.test.js. The pure classifier behavior is still pinned here.

test("classifyAttachmentBatch decides a whole drop in one pass (D7)", () => {
  const accepted = { "image/png": true };
  const cap = 10 * 1024 * 1024;
  const files = [
    { type: "image/png", size: 1 }, // accept (count 2 -> 3)
    { type: "application/pdf", size: 1 }, // skip: wrong mime
    { type: "image/png", size: 20 * 1024 * 1024 }, // error: over size
    { type: "image/png", size: 1 }, // accept (count 3 -> 4)
    { type: "image/png", size: 1 }, // cap: count already at max 4
  ];
  const decisions = classifyAttachmentBatch(files, {
    currentCount: 2,
    maxCount: 4,
    maxBytes: cap,
    accepted,
  });
  assert.deepEqual(
    decisions.map((d) => d.kind),
    ["accept", "skip", "error", "accept", "cap"],
  );
  // Only accepts carry the file forward for upload; the size error carries its message.
  assert.equal(decisions.filter((d) => d.kind === "accept").length, 2);
  assert.match(decisions.find((d) => d.kind === "error").error, /larger than/i);
  // Count cap is honored ACROSS the batch, not reset per file.
  const allImages = classifyAttachmentBatch(
    [
      { type: "image/png", size: 1 },
      { type: "image/png", size: 1 },
      { type: "image/png", size: 1 },
    ],
    {
      currentCount: 0,
      maxCount: 2,
      maxBytes: 0,
      accepted,
    },
  );
  assert.deepEqual(
    allImages.map((d) => d.kind),
    ["accept", "accept", "cap"],
  );
});

// The batched-render (D7) wiring now lives in the capture frame - pinned in
// attachment-frame.test.js.
