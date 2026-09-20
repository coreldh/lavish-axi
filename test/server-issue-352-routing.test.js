import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { serve } from "../src/server.js";

async function openAndLoad(base, file) {
  const opened = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  });
  assert.equal(opened.status, 200);
  const session = await opened.json();
  const handoffResponse = await fetch(`${base}/api/${session.key}/chrome-loads/begin`, {
    method: "POST",
    headers: { origin: base },
  });
  assert.equal(handoffResponse.status, 200);
  const handoff = await handoffResponse.json();
  const loadResponse = await fetch(`${base}/api/${session.key}/artifact-loads/begin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: "routing-test",
      request_sequence: 1,
      chrome_load_token: handoff.chrome_load_token,
    }),
  });
  assert.equal(loadResponse.status, 200);
  const load = await loadResponse.json();
  return { session, handoff, load };
}

function injectedPageContext(base, html) {
  const source = html.match(/<script src="([^"]*\/sdk\.js\?[^"]+)"><\/script>/)?.[1];
  assert.ok(source, "the review document has one injected SDK URL");
  const params = new URL(source, base).searchParams;
  return {
    page: params.get("page"),
    page_proof: params.get("page_proof"),
    route: params.get("served_route"),
  };
}

test("issue 352 routes the actual entry basename and keeps legacy virtual index explicit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-352-routing-"));
  const artifact = path.join(root, "report.html");
  try {
    await writeFile(artifact, "<!doctype html><body><main>REPORT ENTRY</main></body>");
    await writeFile(path.join(root, "index.html"), "<!doctype html><body><main>REAL INDEX</main></body>");
    await mkdir(path.join(root, "sub"));
    await writeFile(path.join(root, "sub", "page.htm"), "<!doctype html><body><main>SUB PAGE</main></body>");
    const server = await serve({ port: 0, stateFile: path.join(root, "state.json"), version: "routing-test" });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const { session, load } = await openAndLoad(base, artifact);

      const redirect = await fetch(`${base}/artifact/${session.key}`, { redirect: "manual" });
      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.get("location"), `/artifact/${session.key}/report.html`);

      const actual = await fetch(`${base}/artifact/${session.key}/report.html`);
      const actualBody = await actual.text();
      assert.equal(actual.status, 200);
      assert.match(actualBody, /REPORT ENTRY/);
      assert.match(actualBody, /page_protocol=1/);
      assert.match(actualBody, /page=report.html/);
      assert.match(actualBody, /page_proof=/);
      assert.match(actualBody, /served_route=report.html/);
      assert.equal((actualBody.match(/<script src="\/sdk\.js\?/g) || []).length, 1);

      const realIndex = await fetch(`${base}/artifact/${session.key}/index.html`);
      const realIndexBody = await realIndex.text();
      assert.equal(realIndex.status, 200);
      assert.match(realIndexBody, /REAL INDEX/);
      assert.doesNotMatch(realIndexBody, /REPORT ENTRY/);
      assert.match(realIndexBody, /page= index\.html|page=index\.html/);

      const legacy = await fetch(
        `${base}/artifact/${session.key}/index.html?artifact_revision=${load.artifact_revision}&artifact_load_token=${encodeURIComponent(load.artifact_load_token)}`,
      );
      const legacyBody = await legacy.text();
      assert.equal(legacy.status, 200);
      assert.match(legacyBody, /REPORT ENTRY/);
      assert.doesNotMatch(legacyBody, /page_protocol=1/);

      const incompleteLegacy = await fetch(
        `${base}/artifact/${session.key}/index.html?artifact_load_token=${encodeURIComponent(load.artifact_load_token)}`,
      );
      assert.equal(incompleteLegacy.status, 409);

      const sibling = await fetch(`${base}/artifact/${session.key}/sub/./page.htm`);
      assert.equal(sibling.status, 200);
      assert.match(await sibling.text(), /page=sub%2Fpage.htm/);

      const proofKey = await fetch(`${base}/artifact/${session.key}/page-proof.key`);
      assert.equal(proofKey.status, 403, "the durable signing key is never an artifact asset");
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 352 artifact reads reject a validated path swapped to an outside symlink", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-352-artifact-swap-"));
  const outside = await mkdtemp(path.join(tmpdir(), "lavish-352-artifact-outside-"));
  const artifact = path.join(root, "entry.html");
  const secret = "OUTSIDE_ARTIFACT_SENTINEL";
  let swapped = false;
  try {
    await writeFile(artifact, "<!doctype html><body>INSIDE</body>");
    const canonicalArtifact = await realpath(artifact);
    const outsideFile = path.join(outside, "secret.html");
    await writeFile(outsideFile, secret);
    const server = await serve({
      port: 0,
      stateFile: path.join(root, "state.json"),
      version: "artifact-swap-test",
      artifactPageStat: async (file, options) => {
        if (!swapped && file === canonicalArtifact) {
          swapped = true;
          await rm(canonicalArtifact);
          await symlink(outsideFile, canonicalArtifact);
        }
        return stat(file, options);
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const opened = await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: artifact }),
      }).then((response) => response.json());
      const response = await fetch(`${base}/artifact/${opened.key}/entry.html`);
      const body = await response.text();
      assert.equal(response.status, 403);
      assert.equal(swapped, true);
      assert.doesNotMatch(body, new RegExp(secret));
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("issue 352 sdk route rejects tampered proofs and tokenless page-aware loads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-352-sdk-"));
  const artifact = path.join(root, "entry.html");
  try {
    await writeFile(artifact, "<!doctype html><body><main>ENTRY</main></body>");
    const server = await serve({ port: 0, stateFile: path.join(root, "state.json"), version: "sdk-test" });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const { session } = await openAndLoad(base, artifact);
      const document = await fetch(`${base}/artifact/${session.key}/entry.html`);
      const html = await document.text();
      const script = html.match(/<script src="([^"]*\/sdk\.js\?[^"]+)"><\/script>/)?.[1];
      assert.ok(script);
      const sdkUrl = new URL(script, base);
      const proof = sdkUrl.searchParams.get("page_proof");
      assert.ok(proof);
      sdkUrl.searchParams.set("page_proof", `${proof.slice(0, -1)}${proof.endsWith("A") ? "B" : "A"}`);
      const forged = await fetch(sdkUrl);
      assert.equal(forged.status, 403);

      const recoveryUrl = new URL(`${base}/sdk.js`);
      recoveryUrl.searchParams.set("key", session.key);
      recoveryUrl.searchParams.set("page_protocol", "1");
      recoveryUrl.searchParams.set("page", "entry.html");
      recoveryUrl.searchParams.set("page_proof", proof);
      recoveryUrl.searchParams.set("served_route", "entry.html");
      recoveryUrl.searchParams.delete("artifact_revision");
      recoveryUrl.searchParams.delete("artifact_load_token");
      const recovery = await fetch(recoveryUrl);
      assert.equal(recovery.status, 409);
      assert.deepEqual(await recovery.json(), { status: "stale" });
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 352 begin-load freshly validates and returns the proven current destination", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-352-reload-destination-"));
  const artifact = path.join(root, "entry.html");
  try {
    await writeFile(artifact, "<!doctype html><body><a href='sub/page.html'>Sibling</a></body>");
    await mkdir(path.join(root, "sub"));
    await writeFile(path.join(root, "sub", "page.html"), "<!doctype html><body>SIBLING</body>");
    const server = await serve({ port: 0, stateFile: path.join(root, "state.json"), version: "reload-test" });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const { session, handoff, load } = await openAndLoad(base, artifact);
      const siblingHtml = await fetch(`${base}/artifact/${session.key}/sub/page.html`).then((response) =>
        response.text(),
      );
      const context = injectedPageContext(base, siblingHtml);
      const destination = {
        ...context,
        url: `/artifact/${session.key}/sub/page.html?view=full&view=print#section-2`,
        query: "view=full&view=print",
        fragment: "section-2",
      };
      const begin = (requestId, requestSequence, candidate) =>
        fetch(`${base}/api/${session.key}/artifact-loads/begin`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            request_id: requestId,
            request_sequence: requestSequence,
            chrome_load_token: handoff.chrome_load_token,
            destination: candidate,
          }),
        });

      const acceptedResponse = await begin("reload-sibling", 2, destination);
      assert.equal(acceptedResponse.status, 200);
      const accepted = await acceptedResponse.json();
      assert.equal(accepted.artifact_url, `/artifact/${session.key}/sub/page.html?view=full&view=print#section-2`);
      assert.equal(accepted.artifact_revision, load.artifact_revision + 1);
      assert.equal(accepted.page, "sub/page.html");
      assert.equal(accepted.page_proof, context.page_proof);
      assert.equal(accepted.served_route, "sub/page.html");

      const tampered = await begin("tampered-proof", 3, { ...destination, page_proof: "x".repeat(43) });
      assert.equal(tampered.status, 400);
      assert.deepEqual(await tampered.json(), { status: "invalid-destination" });

      const external = await begin("external-url", 4, { ...destination, url: "https://example.com/page.html" });
      assert.equal(external.status, 400);

      const reserved = await begin("reserved-query", 5, {
        ...destination,
        url: `/artifact/${session.key}/sub/page.html?__lavish_reload=authored#section-2`,
        query: "__lavish_reload=authored",
      });
      assert.equal(reserved.status, 400);

      const revision = await fetch(`${base}/api/${session.key}/layout-warnings`).then((response) => response.json());
      assert.equal(revision.revision, accepted.artifact_revision, "rejected destinations never advance the load");

      await rm(path.join(root, "sub", "page.html"));
      const deleted = await begin("deleted-page", 6, destination);
      assert.equal(deleted.status, 400, "a historical proof is not fresh file-read authorization");
      assert.deepEqual(await deleted.json(), { status: "invalid-destination" });

      await writeFile(path.join(root, "sub", "page.html"), "<!doctype html><body>REPLACED</body>");
      const retargeted = await begin("retargeted-page", 7, {
        ...destination,
        route: "entry.html",
        url: `/artifact/${session.key}/entry.html?view=full&view=print#section-2`,
        fallback_to_entry: true,
      });
      assert.equal(retargeted.status, 400);
      assert.deepEqual(await retargeted.json(), { status: "invalid-destination" });
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 352 fatal document failures retain the accepted page before SDK binding", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-352-pending-failure-"));
  const artifact = path.join(root, "entry.html");
  try {
    await writeFile(artifact, "<!doctype html><body>ENTRY</body>");
    await mkdir(path.join(root, "sub"));
    const sibling = path.join(root, "sub", "page.html");
    await writeFile(sibling, "<!doctype html><body>SIBLING</body>");
    const server = await serve({ port: 0, stateFile: path.join(root, "state.json"), version: "failure-test" });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const { session, handoff } = await openAndLoad(base, artifact);
      const context = injectedPageContext(
        base,
        await fetch(`${base}/artifact/${session.key}/sub/page.html`).then((response) => response.text()),
      );
      const acceptedResponse = await fetch(`${base}/api/${session.key}/artifact-loads/begin`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: "pending-failure",
          request_sequence: 2,
          chrome_load_token: handoff.chrome_load_token,
          destination: {
            ...context,
            url: `/artifact/${session.key}/sub/page.html`,
            query: "",
            fragment: "",
          },
        }),
      });
      assert.equal(acceptedResponse.status, 200);
      const accepted = await acceptedResponse.json();
      assert.equal(accepted.page, "sub/page.html");
      assert.equal(accepted.page_proof, context.page_proof);

      await rm(sibling);
      const documentUrl = new URL(accepted.artifact_url, base);
      documentUrl.searchParams.set("artifact_revision", String(accepted.artifact_revision));
      documentUrl.searchParams.set("artifact_load_token", accepted.artifact_load_token);
      const document = await fetch(documentUrl);
      assert.equal(document.status, 404);

      const recorded = await fetch(`${base}/api/${session.key}/artifact-failures`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({
          failures: [{ kind: "artifact-unavailable", detail: "the artifact document responded with HTTP 404" }],
          artifact_load_token: accepted.artifact_load_token,
          artifact_revision: accepted.artifact_revision,
          page: accepted.page,
          page_proof: accepted.page_proof,
          document_sequence: 1,
        }),
      });
      assert.equal(recorded.status, 200);

      const feedback = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`).then(
        (response) => response.json(),
      );
      assert.equal(feedback.status, "feedback");
      assert.equal(feedback.artifact_failures[0].page, "sub/page.html");
      assert.equal(feedback.artifact_failures[0].page_proof, undefined);
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 352 authenticates a live page binding before chrome activation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-352-binding-"));
  const artifact = path.join(root, "entry.html");
  try {
    await writeFile(artifact, "<!doctype html><body>ENTRY</body>");
    await writeFile(path.join(root, "other.html"), "<!doctype html><body>OTHER</body>");
    const server = await serve({ port: 0, stateFile: path.join(root, "state.json"), version: "binding-test" });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const { session, load } = await openAndLoad(base, artifact);
      const entryContext = injectedPageContext(
        base,
        await fetch(`${base}/artifact/${session.key}/entry.html`).then((response) => response.text()),
      );
      const otherContext = injectedPageContext(
        base,
        await fetch(`${base}/artifact/${session.key}/other.html`).then((response) => response.text()),
      );
      const validate = (body, origin = base) =>
        fetch(`${base}/api/${session.key}/artifact-bindings/validate`, {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify(body),
        });
      const binding = {
        page: entryContext.page,
        page_proof: entryContext.page_proof,
        served_route: entryContext.route,
        artifact_load_token: load.artifact_load_token,
        artifact_revision: load.artifact_revision,
      };

      assert.equal((await validate(binding)).status, 204);
      assert.equal((await validate({ ...binding, page_proof: otherContext.page_proof })).status, 403);
      assert.equal((await validate({ ...binding, served_route: "other.html" })).status, 403);
      assert.equal((await validate({ ...binding, artifact_load_token: "stale" })).status, 409);
      assert.equal((await validate(binding, "http://attacker.invalid")).status, 403);
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("issue 352 validates page claims atomically and keeps proofs out of poll output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lavish-352-context-"));
  const artifact = path.join(root, "entry.html");
  try {
    await writeFile(artifact, "<!doctype html><body><main>ENTRY CONTEXT</main></body>");
    const server = await serve({ port: 0, stateFile: path.join(root, "state.json"), version: "context-test" });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const { session } = await openAndLoad(base, artifact);
      const document = await fetch(`${base}/artifact/${session.key}/entry.html`);
      const html = await document.text();
      const script = html.match(/<script src="([^"]*\/sdk\.js\?[^"]+)"><\/script>/)?.[1];
      assert.ok(script);
      const sdkUrl = new URL(script, base);
      const proof = sdkUrl.searchParams.get("page_proof");
      assert.ok(proof);

      const invalid = await fetch(`${base}/api/${session.key}/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({
          page_protocol: 1,
          prompts: [
            {
              uid: "good-but-mixed",
              prompt: "must not persist either",
              selector: "main",
              tag: "main",
              text: "ENTRY CONTEXT",
              page: "entry.html",
              page_proof: proof,
            },
            {
              uid: "bad",
              prompt: "must not persist",
              selector: "main",
              tag: "main",
              text: "ENTRY CONTEXT",
              // This used to be normalized to null before the server saw it, which made the
              // malformed claim indistinguishable from an intentional page:null annotation.
              page: "/outside.html",
              page_proof: "",
            },
          ],
          domSnapshot: 'uid=good-but-mixed main "must not persist either"',
          snapshot_page: "entry.html",
          snapshot_page_proof: proof,
        }),
      });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).status, "invalid-page-context");
      const afterInvalid = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`).then(
        (response) => response.json(),
      );
      assert.equal(afterInvalid.status, "waiting");

      const malformedShape = await fetch(`${base}/api/${session.key}/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({
          page_protocol: 1,
          prompts: [
            {
              uid: "array-page",
              prompt: "array page must not persist",
              selector: "main",
              tag: "main",
              text: "ENTRY CONTEXT",
              // A String(array) coercion would turn this into the valid page identity.
              page: ["entry.html"],
              page_proof: proof,
            },
          ],
          snapshot_page: null,
          snapshot_page_proof: "",
        }),
      });
      assert.equal(malformedShape.status, 400);
      assert.equal((await malformedShape.json()).status, "invalid-page-context");
      const afterMalformedShape = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`).then(
        (response) => response.json(),
      );
      assert.equal(afterMalformedShape.status, "waiting");

      const legacyQueued = await fetch(`${base}/api/${session.key}/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({
          page_protocol: 1,
          prompts: [
            {
              uid: "legacy",
              prompt: "preserve pre-feature writing",
              selector: "main",
              tag: "main",
              text: "ENTRY CONTEXT",
              page: null,
              page_proof: "",
            },
          ],
          domSnapshot: "",
          snapshot_page: null,
          snapshot_page_proof: "",
        }),
      });
      assert.equal(legacyQueued.status, 200);
      const legacyFeedback = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`).then(
        (response) => response.json(),
      );
      assert.equal(legacyFeedback.status, "feedback");
      assert.equal(legacyFeedback.prompts[0].prompt, "preserve pre-feature writing");
      assert.equal(legacyFeedback.prompts[0].page, null);
      assert.equal(legacyFeedback.prompts[0].page_proof, undefined);

      const accepted = await fetch(`${base}/api/${session.key}/prompts`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({
          page_protocol: 1,
          prompts: [
            {
              uid: "good",
              prompt: "keep the page",
              selector: "main",
              tag: "main",
              text: "ENTRY CONTEXT",
              page: "entry.html",
              page_proof: proof,
            },
          ],
          domSnapshot: 'uid=good main "ENTRY CONTEXT"',
          snapshot_page: "entry.html",
          snapshot_page_proof: proof,
        }),
      });
      assert.equal(accepted.status, 200);

      const feedback = await fetch(`${base}/api/poll?file=${encodeURIComponent(artifact)}&timeoutMs=0`).then(
        (response) => response.json(),
      );
      assert.equal(feedback.status, "feedback");
      assert.equal(feedback.prompts[0].page, "entry.html");
      assert.equal(feedback.prompts[0].page_proof, undefined);
      assert.equal(feedback.snapshot_page, "entry.html");
      assert.equal(feedback.snapshot_page_proof, undefined);
      assert.match(feedback.dom_snapshot, /ENTRY CONTEXT/);
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
