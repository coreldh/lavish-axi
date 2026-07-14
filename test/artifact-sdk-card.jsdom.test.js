import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import { createSdkJs } from "../src/server.js";

// End-to-end coverage of the CONFIGURED card flow: this evaluates the serialized SDK
// bundle (createSdkJs -> createArtifactSdk -> the annotation card) inside jsdom with a
// real DOM, opens a card, and drives it. Unlike the isolated seam tests, a regression
// that bypasses the wiring - hardcoding the count cap, dropping the error gate, or
// omitting the re-clamp - is caught here because the whole chain actually runs.

// Boot the SDK bundle in a fresh jsdom window and return handles for driving the card.
/** @param {{ maxAttachmentCount?: number }} [config] */
function bootSdk({ maxAttachmentCount } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body><p id="t">hello world</p></body></html>`, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.URL.createObjectURL = () => "blob:preview";
  window.URL.revokeObjectURL = () => {};
  // jsdom doesn't implement CSS.escape, which selector() uses to build element paths.
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) window.CSS.escape = (value) => String(value).replace(/[^\w-]/g, (ch) => "\\" + ch);
  const posted = [];
  // The bundle posts to `parent` (which is the window itself in jsdom); capture it.
  window.postMessage = (message) => posted.push(message);

  window.eval(createSdkJs("0123456789abcdef", { maxAttachmentCount }));

  function openCard() {
    const target = window.document.getElementById("t");
    target.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    const host = window.document.querySelector('[data-lavish-ui="annotation-root"]');
    return host.shadowRoot.querySelector(".lavish-annotation-card");
  }

  function file(name, type = "image/png") {
    return new window.File([new Uint8Array([1, 2, 3])], name, { type });
  }

  function drop(card, files) {
    const event = new window.Event("drop", { bubbles: true, cancelable: true });
    // jsdom has no real DataTransfer for programmatic drops; the handler only reads
    // .files / .items, so a plain object stands in.
    Object.defineProperty(event, "dataTransfer", { value: { files, items: [] } });
    card.dispatchEvent(event);
  }

  return { window, posted, openCard, file, drop };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

test("configured SDK card enforces the server count cap end-to-end and stamps the nonce (W1 + F1)", async () => {
  const sdk = bootSdk({ maxAttachmentCount: 2 });
  const card = sdk.openCard();
  assert.ok(card, "clicking an element opens the annotation card");

  // Drop THREE images with a configured cap of 2: only two chips are attached and the
  // third is surfaced. A hardcoded cap of 4 would attach all three with no notice.
  sdk.drop(card, [sdk.file("a.png"), sdk.file("b.png"), sdk.file("c.png")]);
  assert.equal(card.querySelectorAll(".lavish-attachment-chip").length, 2, "only the configured cap of 2 is attached");
  assert.match(card.querySelector(".lavish-hint").textContent, /up to 2 images/);

  // The two accepted uploads post to the chrome, each stamped with a document nonce (F1).
  await flush();
  const uploads = sdk.posted.filter((m) => m && m.type === "lavish:uploadAttachment");
  assert.equal(uploads.length, 2, "each accepted image is uploaded through the chrome");
  assert.equal(
    uploads.every((m) => typeof m.documentNonce === "string" && m.documentNonce.length > 0),
    true,
    "every upload message carries a non-empty document nonce",
  );
});

test("configured SDK card blocks queuing while an attachment is in error and re-clamps on render (W2 + W3)", async () => {
  const sdk = bootSdk({ maxAttachmentCount: 4 });
  const card = sdk.openCard();

  // W3: after opening, clear the card position, then a render (from adding a chip) must
  // re-clamp it via onLayout -> positionCard. If onLayout were omitted, top stays empty.
  card.style.top = "";
  sdk.drop(card, [sdk.file("notes.pdf", "application/pdf")]);
  assert.notEqual(card.style.top, "", "adding a chip row re-clamps the card (W3 onLayout wiring)");

  // The dropped non-image is an UNSUPPORTED_TYPE error chip.
  const chip = card.querySelector(".lavish-attachment-chip.is-error");
  assert.ok(chip, "an unsupported file becomes an error chip");

  // W2: clicking Queue while an error chip is present must NOT close the card or queue.
  card.querySelector(".lavish-send").dispatchEvent(new sdk.window.MouseEvent("click", { bubbles: true }));
  await flush();
  const host = sdk.window.document.querySelector('[data-lavish-ui="annotation-root"]');
  assert.ok(host.shadowRoot.querySelector(".lavish-annotation-card"), "the card stays open on a blocked queue");
  assert.match(card.querySelector(".lavish-hint").textContent, /Retry or remove/);
  assert.equal(
    sdk.posted.some((m) => m && m.type === "lavish:queuePrompt"),
    false,
    "nothing is queued while an attachment is in error",
  );
});

test("configured SDK card partial-accepts a mixed drop end-to-end (F4)", () => {
  const sdk = bootSdk({ maxAttachmentCount: 4 });
  const card = sdk.openCard();

  // A mixed drop: one image + one unsupported file. The image attaches AND the
  // unsupported file surfaces as its own error chip - neither is silently dropped.
  sdk.drop(card, [sdk.file("shot.png"), sdk.file("archive.zip", "application/zip")]);
  assert.equal(card.querySelectorAll(".lavish-attachment-chip").length, 2, "both the image and the reject render");
  assert.equal(card.querySelectorAll(".lavish-attachment-chip.is-error").length, 1, "one UNSUPPORTED_TYPE chip");
});
