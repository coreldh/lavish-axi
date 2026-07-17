/* global document, window */

// The trusted attachment-capture frame (root A / R10; provenance redesign R12).
//
// Image acquisition - the file picker, paste, and drop - and every byte read run
// here, in a CHROME-SERVED, sandboxed iframe (opaque origin, no `allow-same-origin`).
//
// The chrome CREATES this iframe in its OWN capture overlay (its top
// document), never in the artifact realm, and binds the capture channel ONLY to the
// exact frame window it created (an `event.source` identity check). The route's
// `frame-ancestors 'self'` policy blocks the artifact from embedding it; messages from
// any other window are ignored even if they carry valid-looking correlation fields.
//
// The frame has NO server access: it reads bytes locally and hands them to
// `window.parent` (the chrome, its direct parent - never `window.top`, which a page
// framing the whole session could occupy) over postMessage; the chrome performs the
// same-origin upload and reports the server-vetted id back. The artifact SDK only
// ever learns the non-sensitive per-item state (name, status, server id) the chrome
// relays - never bytes.
//
// The pure classification helpers (`classifyAttachmentBatch`, `attachmentSizeError`,
// `partitionDroppedFiles`, `deriveAttachmentNoticeState`) are the SAME exports the
// artifact SDK used, serialized into this frame's bundle by `createAttachmentFrameJs`.

/**
 * Boot the capture controller inside the frame. References only its own argument,
 * browser globals, and the sibling helpers serialized alongside it (the same
 * same-scope-const contract `createSdkJs` uses), so it can be bundled without a
 * build step.
 *
 * @param {{ maxCount?: number, maxBytes?: number }} config
 * @param {{ classifyAttachmentBatch: Function, partitionDroppedFiles: Function, deriveAttachmentNoticeState: Function }} helpers
 */
export function createAttachmentFrame(config, helpers) {
  const { classifyAttachmentBatch, partitionDroppedFiles, deriveAttachmentNoticeState } = helpers;
  const params = new URLSearchParams(window.location.search);
  // The chrome created THIS frame in its own DOM and stamped a fresh per-open session
  // id into the query string; the frame echoes it on every message so the chrome can
  // correlate them (R12). This id is NOT the security boundary - the chrome binds the
  // capture channel ONLY to the exact frame window it created (event.source identity),
  // which the artifact realm cannot forge - it is only a per-session correlation tag.
  const session = params.get("session") || "";
  // The nonce of the card that opened this frame, threaded in via the iframe query
  // string. Echoed on every relayed state so the artifact card's mirror can drop a
  // late state from a retired frame (R11) instead of applying it to a fresh card.
  const cardNonce = params.get("card") || "";
  const MAX_COUNT = Number.isFinite(config.maxCount) && config.maxCount > 0 ? config.maxCount : 4;
  const MAX_BYTES = Number.isFinite(config.maxBytes) && config.maxBytes > 0 ? config.maxBytes : 0;
  const ACCEPTED_MIME = { "image/png": true, "image/jpeg": true, "image/webp": true };
  // The chrome is this frame's DIRECT parent (R12: the chrome created this iframe in
  // its own overlay), so `window.parent` is the chrome. Use `window.parent`, NOT
  // `window.top`: if a hostile page were to frame the whole Lavish session, `window.top`
  // would be that attacker page and would receive the image bytes, whereas `window.parent`
  // is always the chrome that created this frame. Commands are honored only from it.
  const chrome = window.parent;

  const items = [];
  let capRejected = false;
  let localCounter = 0;

  const listEl = document.getElementById("list");
  const noticeEl = document.getElementById("notice");
  const fileInput = /** @type {HTMLInputElement} */ (document.getElementById("file"));
  const dropZone = document.getElementById("zone");

  const REMOVE_ICON =
    '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

  function escapeText(value) {
    return String(value).replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
    );
  }

  function chipHtml(item, index) {
    const name = escapeText(item.name || "image");
    const thumb = item.url
      ? '<img class="thumb" src="' + escapeText(item.url) + '" alt="">'
      : '<span class="thumb thumb-empty" aria-hidden="true"></span>';
    let status = "";
    if (item.status === "uploading") status = '<span class="status">Uploading…</span>';
    else if (item.status === "error")
      status = '<span class="status status-error">' + escapeText(item.error || "Upload failed") + "</span>";
    const retry =
      item.status === "error" && item.file
        ? '<button type="button" class="retry" data-retry="' + index + '">Retry</button>'
        : "";
    return (
      '<div class="chip' +
      (item.status === "error" ? " is-error" : "") +
      '">' +
      thumb +
      '<span class="body"><span class="name" title="' +
      name +
      '">' +
      name +
      "</span>" +
      status +
      "</span>" +
      retry +
      '<button type="button" class="remove" data-remove="' +
      index +
      '" aria-label="Remove image" title="Remove">' +
      REMOVE_ICON +
      "</button></div>"
    );
  }

  function hasPending() {
    return items.some((item) => item.status === "uploading");
  }

  function hasErrors() {
    return items.some((item) => item.status === "error");
  }

  // Report the non-sensitive per-item state up to the chrome, which relays it to
  // the artifact SDK for its Queue gating and ready-ref collection. NEVER carries
  // bytes, files, or object URLs - only the server-vetted id, display name, and
  // status. The `capRejected` flag lets the card's shared notice line explain a
  // count-cap rejection.
  function reportState() {
    chrome.postMessage(
      {
        type: "lavish-attachment:state",
        session,
        cardNonce,
        capRejected,
        // The card sizes the iframe to this content height, so a grown chip list is
        // never clipped. Measure `body.scrollHeight` (true content: the frame CSS
        // zeroes html/body margins), NOT `documentElement.scrollHeight` — the latter
        // is floored at the iframe's own viewport height, so it would inflate to
        // whatever height the card last set and never shrink back when chips are
        // removed.
        height: document.body.scrollHeight,
        items: items.map((item) => ({
          localId: item.localId,
          name: item.name,
          status: item.status,
          id: item.id,
        })),
      },
      "*",
    );
  }

  function render() {
    if (items.length < MAX_COUNT) capRejected = false;
    if (noticeEl) {
      const message = deriveAttachmentNoticeState({
        itemCount: items.length,
        maxCount: MAX_COUNT,
        capRejected,
        hasPending: hasPending(),
        hasErrors: hasErrors(),
      });
      noticeEl.textContent = message;
      noticeEl.hidden = !message;
    }
    listEl.innerHTML = items.map((item, index) => chipHtml(item, index)).join("");
    listEl.hidden = items.length === 0;
    for (const button of listEl.querySelectorAll("[data-remove]")) {
      button.addEventListener("click", () => removeAt(Number(button.getAttribute("data-remove"))));
    }
    for (const button of listEl.querySelectorAll("[data-retry]")) {
      button.addEventListener("click", () => retryAt(Number(button.getAttribute("data-retry"))));
    }
    reportState();
  }

  // Read the bytes HERE, in the trusted frame realm, and hand them to the chrome.
  // The artifact realm is never in this data path.
  function upload(item) {
    item.status = "uploading";
    item.error = "";
    render();
    item.file
      .arrayBuffer()
      .then((bytes) => {
        if (!items.includes(item)) return;
        chrome.postMessage(
          {
            type: "lavish-attachment:upload",
            session,
            localId: item.localId,
            name: item.name,
            mime: item.mime,
            bytes,
          },
          "*",
        );
      })
      .catch(() => {
        if (!items.includes(item)) return;
        item.status = "error";
        item.error = "Could not read image";
        render();
      });
  }

  function addFiles(fileList) {
    const files = [...(fileList || [])];
    const decisions = classifyAttachmentBatch(files, {
      currentCount: items.length,
      maxCount: MAX_COUNT,
      maxBytes: MAX_BYTES,
      accepted: ACCEPTED_MIME,
    });
    const toUpload = [];
    for (const decision of decisions) {
      if (decision.kind === "cap") {
        capRejected = true;
      } else if (decision.kind === "error") {
        items.push({
          localId: "att-" + ++localCounter,
          file: null,
          name: decision.file?.name || "image",
          mime: "",
          status: "error",
          id: "",
          error: decision.error,
          url: "",
        });
      } else if (decision.kind === "accept") {
        const item = {
          localId: "att-" + ++localCounter,
          file: decision.file,
          name: decision.file.name || "image",
          mime: decision.file.type,
          status: "uploading",
          id: "",
          error: "",
          url: URL.createObjectURL(decision.file),
        };
        items.push(item);
        toUpload.push(item);
      }
    }
    render();
    for (const item of toUpload) upload(item);
  }

  function removeAt(index) {
    const item = items[index];
    if (!item) return;
    if (item.url) URL.revokeObjectURL(item.url);
    items.splice(index, 1);
    render();
  }

  function retryAt(index) {
    if (items[index] && items[index].file) upload(items[index]);
  }

  function rejectUnsupportedBatch(names) {
    for (const name of names || []) {
      items.push({
        localId: "att-" + ++localCounter,
        file: null,
        name: name || "file",
        mime: "",
        status: "error",
        id: "",
        error: "UNSUPPORTED_TYPE",
        url: "",
      });
    }
    render();
  }

  function handleResult(localId, ok, id, error) {
    const item = items.find((entry) => entry.localId === localId);
    if (!item) return;
    if (ok && id) {
      item.status = "ready";
      item.id = String(id);
      item.error = "";
    } else {
      item.status = "error";
      item.error = String(error || "Upload failed");
    }
    render();
  }

  // Only the chrome (window.parent) may command this frame. This frame is a direct
  // child of the chrome's own document (R12: the chrome created it in its capture
  // overlay), so window.parent is the chrome; commands must come from it and carry
  // this frame's session id.
  window.addEventListener("message", (event) => {
    if (event.source !== chrome) return;
    const msg = event.data || {};
    if (msg.session !== session) return;
    if (msg.type === "lavish-attachment:uploadResult") {
      handleResult(msg.localId, msg.ok, msg.id, msg.error);
    } else if (msg.type === "lavish-attachment:bound") {
      // The chrome acknowledged this frame; report the initial (empty) state so the
      // overlay reveals the capture UI right away rather than waiting for a capture.
      reportState();
    }
  });

  fileInput.addEventListener("change", () => {
    addFiles(fileInput.files);
    fileInput.value = "";
  });
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });
  document.addEventListener("paste", (event) => {
    const { images } = partitionDroppedFiles(event.clipboardData, ACCEPTED_MIME);
    if (images.length) {
      event.preventDefault();
      addFiles(images);
    }
  });
  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dropping");
  });
  dropZone.addEventListener("dragleave", (event) => {
    if (event.target === dropZone) dropZone.classList.remove("is-dropping");
  });
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dropping");
    const { images, unsupported } = partitionDroppedFiles(event.dataTransfer, ACCEPTED_MIME);
    if (images.length) addFiles(images);
    if (unsupported.length) rejectUnsupportedBatch(unsupported);
  });

  render();
  // Announce readiness. The chrome binds THIS frame only because it recognizes the
  // sending window as the exact frame it created (event.source identity) - provenance
  // the artifact realm cannot forge (R12). The session id is echoed for correlation.
  chrome.postMessage({ type: "lavish-attachment:ready", session }, "*");
}
