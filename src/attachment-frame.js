/* global document, window */

// The trusted attachment-capture frame (root A, R10).
//
// Image acquisition - the file picker, paste, and drop - used to run inside the
// artifact's own (untrusted) JS realm, so a hostile artifact could read the
// picked File, monkey-patch `File.prototype.arrayBuffer`, or watch the open
// shadow root and exfiltrate a user-chosen screenshot before the chrome ever
// mediated it. This module is the ONE surface where attachment bytes are ever
// touched by capture code, and it runs in a CHROME-SERVED, sandboxed iframe
// (opaque origin, no `allow-same-origin`) embedded as a sibling inside the
// annotation card. Cross-origin frame isolation means the artifact realm cannot
// reach into this frame's document, read its variables, or patch its prototypes,
// so the File objects and their bytes never exist in a realm the artifact can
// observe.
//
// The frame has NO server access (matching the whiteboard frame): it reads bytes
// locally, hands them to `window.top` (the chrome) over postMessage with a signed
// channel token, and the chrome performs the same-origin upload and reports the
// server-vetted id back. The artifact SDK only ever learns the non-sensitive
// per-item state (name, status, server id) relayed by the chrome - never bytes.
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
 * @param {{ channelToken: string, maxCount?: number, maxBytes?: number }} config
 * @param {{ classifyAttachmentBatch: Function, partitionDroppedFiles: Function, deriveAttachmentNoticeState: Function }} helpers
 */
export function createAttachmentFrame(config, helpers) {
  const { classifyAttachmentBatch, partitionDroppedFiles, deriveAttachmentNoticeState } = helpers;
  const channelToken = String(config.channelToken || "");
  const MAX_COUNT = Number.isFinite(config.maxCount) && config.maxCount > 0 ? config.maxCount : 4;
  const MAX_BYTES = Number.isFinite(config.maxBytes) && config.maxBytes > 0 ? config.maxBytes : 0;
  const ACCEPTED_MIME = { "image/png": true, "image/jpeg": true, "image/webp": true };
  // The chrome is `window.top`, reached by bypassing the artifact frame (our
  // `parent`) entirely. Messages the chrome sends back arrive with
  // `event.source === window.top`; a message forged by the artifact parent has
  // `event.source === window.parent` and is ignored, so the artifact cannot drive
  // this frame.
  const chrome = window.top;

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
        channelId: channelToken,
        capRejected,
        // The card sizes and reveals the iframe to this content height, so an empty
        // card shows no blank frame band and a grown chip list is never clipped.
        height: document.documentElement.scrollHeight,
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
            channelId: channelToken,
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

  // Only the chrome (window.top) may command this frame. The artifact parent can
  // postMessage to this iframe (it created the element), so a bare source check is
  // not enough: bind to `window.top` and the channel token.
  window.addEventListener("message", (event) => {
    if (event.source !== chrome) return;
    const msg = event.data || {};
    if (msg.channelId !== channelToken) return;
    if (msg.type === "lavish-attachment:uploadResult") {
      handleResult(msg.localId, msg.ok, msg.id, msg.error);
    } else if (msg.type === "lavish-attachment:bound") {
      // The chrome authenticated our channel and can now relay our state; report the
      // initial (empty) state so the card sizes and reveals this frame right away,
      // rather than staying hidden until the first capture.
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
  // Announce readiness so the chrome authenticates the token and binds this
  // frame's window as the current capture channel.
  chrome.postMessage({ type: "lavish-attachment:ready", channelToken }, "*");
}
