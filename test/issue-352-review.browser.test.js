import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test(
  "352 stale history retains the accepted alias, author query and fragment",
  { skip: !runBrowserE2e, timeout: 180_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-352-history-"));
    const entry = path.join(temp, "entry.html");
    const port = await freePort();
    const env = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-history-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };
    const cli = path.join(repoRoot, "dist", "cli.mjs");
    const browser = (...args) => run("chrome-devtools-axi", args, chromeEnv);
    try {
      await writeFile(
        entry,
        '<!doctype html><body><a href="alias.html?view=review&view=full#target">Open history target</a></body>',
      );
      await writeFile(
        path.join(temp, "a.html"),
        `<!doctype html><body><p id="target">Historical alias target</p><button onclick="history.pushState(null,'','#pushed')">Push view</button><button onclick="history.replaceState(null,'','#replaced')">Replace view</button><a href="b.html">Next document</a>
        <script>addEventListener('message', e => {
          if (e.data === 'test-history-hide') {
            dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true}));
            parent.postMessage('test-history-hidden', '*');
          }
          if (e.data === 'test-history-show') dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}));
        });</script></body>`,
      );
      await writeFile(path.join(temp, "b.html"), "<!doctype html><body><p>Second document</p></body>");
      await symlink("a.html", path.join(temp, "alias.html"));
      const opened = run(process.execPath, [cli, entry, "--no-open"], env);
      const url = opened.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, opened);
      browser("open", url);
      const evalChrome = (source) => browser("eval", source);
      await eventually(
        async () => evalChrome("() => Boolean(currentArtifactBinding)"),
        (text) => /true/.test(text),
        "entry did not bind",
      );
      evalChrome(
        '() => { annotation = false; postToFrame({type:"lavish:setAnnotationMode",enabled:false}); return true; }',
      );
      const click = (label) => {
        const line = browser("snapshot")
          .split("\n")
          .find((line) => line.includes(label));
        assert.ok(line, label);
        browser("click", "@" + line.trim().split(/\s+/)[0].replace(/^uid=/, ""));
      };
      click("Open history target");
      await eventually(
        async () =>
          evalChrome(
            '() => Array.from(historicalDestinations.values()).some(r => r.url.endsWith("alias.html?view=review&view=full#target"))',
          ),
        (text) => /true/.test(text),
        "alias receipt was not retained",
      );
      for (const [label, fragment] of [
        ["Push view", "pushed"],
        ["Replace view", "replaced"],
      ]) {
        if (fragment === "replaced")
          evalChrome(`() => {
          window.__delayedHistoryDocument = currentArtifactBinding.documentId;
          const original = window.fetch;
          window.fetch = async function(url, init) {
            const response = await original.apply(this, arguments);
            if (!window.__delayedHistorySigned && String(url).includes('/artifact-bindings/validate') && JSON.parse(init.body).destination?.url.endsWith('#replaced')) {
              window.__delayedHistorySigned = response.ok;
              await new Promise(resolve => { window.__releaseHistoryReceipt = resolve; });
            }
            return response;
          };
          return true;
        }`);
        click(label);
        if (fragment === "replaced") {
          await eventually(
            async () => evalChrome("() => window.__delayedHistorySigned"),
            (text) => /true/.test(text),
            "receipt was not signed before navigation",
          );
          continue;
        }
        await eventually(
          async () =>
            evalChrome(
              `() => Array.from(historicalDestinations.values()).some(r => r.url.endsWith("alias.html?view=review&view=full#${fragment}"))`,
            ),
          (text) => /true/.test(text),
          `successful ${label} did not get a destination receipt`,
        );
      }
      click("Next document");
      await eventually(
        async () => evalChrome("() => currentArtifactBinding?.page"),
        (text) => text.includes("b.html"),
        "second page did not bind",
      );
      evalChrome("() => { window.__releaseHistoryReceipt(); return true; }");
      await eventually(
        async () =>
          evalChrome(
            "() => Array.from(historicalDestinations.values()).some(r => r.document_id === window.__delayedHistoryDocument && r.url.endsWith('#replaced'))",
          ),
        (text) => /true/.test(text),
        "delayed A receipt was lost after B authenticated",
      );
      assert.match(evalChrome("() => currentArtifactBinding.page"), /b.html/);
      evalChrome("() => { reloadArtifact(); return true; }");
      await eventually(
        async () => evalChrome("() => currentArtifactBinding?.page"),
        (text) => text.includes("b.html"),
        "second page reload did not bind",
      );
      evalChrome(`() => {
        window.__historyRecoveryRequests = [];
        window.__historyValidation = [];
        const original = window.fetch;
        window.fetch = function(url, init) {
          if (String(url).includes('/artifact-loads/begin') && init?.body) {
            const body = JSON.parse(init.body);
            if (body.historical_page) window.__historyRecoveryRequests.push(body.historical_page);
          }
          const result = original.apply(this, arguments);
          if (String(url).includes('/artifact-bindings/validate')) result.then(r => r.clone().text().then(text => window.__historyValidation.push({input:JSON.parse(init.body),status:r.status,text})));
          return result;
        };
        return true;
      }`);
      browser("back");
      await eventually(
        async () => evalChrome("() => currentArtifactBinding?.destination"),
        (text) => text.includes("alias.html?view=review&view=full#replaced"),
        "Back lost the exact historical destination",
      );
      assert.match(browser("snapshot"), /Historical alias target/);
      // Chromium may refetch instead of using BFCache for subframe Back. Exercise
      // the persisted lifecycle explicitly too, keeping the actual SDK document.
      evalChrome(`() => {
        window.__historyHidden = false;
        window.addEventListener('message', e => { if (e.source === frame.contentWindow && e.data === 'test-history-hidden') window.__historyHidden = true; });
        frame.contentWindow.postMessage('test-history-hide', '*');
        return true;
      }`);
      await eventually(
        async () => evalChrome("() => window.__historyHidden"),
        (text) => /result:\s*"true"/.test(text),
        "SDK document did not receive pagehide",
      );
      assert.match(
        evalChrome(`async () => {
        const response = await fetch('/api/' + key + '/artifact-loads/begin', {
          method: 'POST', headers: {'content-type':'application/json'},
          body: JSON.stringify({request_id:'browser-stale-history', request_sequence: ++artifactLoadRequestSequence,
            chrome_load_token:chromeLoadToken})
        });
        if (!response.ok) throw new Error('generation advance failed');
        const load = await response.json();
        artifactLoadRevision = load.artifact_revision;
        artifactLoadToken = load.artifact_load_token;
        retireArtifactBinding();
        frame.contentWindow.postMessage('test-history-show', '*');
        return true;
      }`),
        /result:\s*"true"/,
      );
      try {
        await eventually(
          async () =>
            evalChrome(
              "() => window.__historyRecoveryRequests.length > 0 && currentArtifactBinding?.destination.endsWith('alias.html?view=review&view=full#replaced')",
            ),
          (text) => /result:\s*"true"/.test(text),
          "stale historical document did not recover through its receipt",
        );
      } catch (error) {
        assert.fail(
          String(error) +
            evalChrome(
              "() => JSON.stringify({binding:currentArtifactBinding && {id:currentArtifactBinding.documentId,token:currentArtifactBinding.token,url:currentArtifactBinding.destination},token:artifactLoadToken,ready:latestReadyDocumentId,attempt:artifactChallengeAttempt?.documentId,requests:window.__historyRecoveryRequests,validation:window.__historyValidation})",
            ),
        );
      }
      assert.match(
        evalChrome(
          "() => currentArtifactBinding.token === artifactLoadToken && currentArtifactBinding.revision === artifactLoadRevision",
        ),
        /true/,
      );
    } finally {
      cleanupRun(process.execPath, [cli, "stop", "--port", String(port)], env);
      cleanupRun("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);

test(
  "352 exact POSIX entry remains reviewable and foreign framing is blocked",
  { skip: !runBrowserE2e || path.sep !== "/", timeout: 180_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-352-exact-entry-"));
    const entry = path.join(temp, "report\\final.html");
    const stateDir = path.join(temp, "state");
    const port = await freePort();
    const env = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: stateDir,
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-exact-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };
    const cli = path.join(repoRoot, "dist", "cli.mjs");
    const browser = (...args) => run("chrome-devtools-axi", args, chromeEnv);
    const readState = async () => JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8"));
    let hostileServer = null;
    try {
      await writeFile(entry, '<!doctype html><body style="font:16px system-ui"><p>Exact entry target</p></body>');
      const opened = run(process.execPath, [cli, entry, "--no-open"], env);
      const url = opened.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, opened);
      const key = new URL(url).pathname.split("/").pop();
      browser("open", url);
      const click = (label) => {
        const line = browser("snapshot")
          .split("\n")
          .find((line) => line.includes(label));
        assert.ok(line, label);
        browser("click", "@" + line.trim().split(/\s+/)[0].replace(/^uid=/, ""));
      };
      await eventually(
        async () => browser("snapshot"),
        (tree) => tree.includes("Exact entry target") && !tree.includes("Checking layout."),
        "exact entry did not bind",
      );
      click("Exact entry target");
      browser("type", "Literal entry draft");
      const revision = (await readState()).sessions[key].artifact_revision;
      browser("eval", '() => { document.getElementById("reloadArtifact").click(); return true; }');
      await eventually(readState, (state) => state.sessions[key].artifact_revision > revision, "reload did not start");
      await eventually(
        async () => browser("snapshot"),
        (tree) => tree.includes("Literal entry draft"),
        "entry draft did not survive reload",
      );
      click('button "Queue"');
      browser("eval", '() => { document.getElementById("send").click(); return true; }');
      const state = await eventually(
        readState,
        (state) => state.sessions[key].prompts.length > 0,
        "annotation was not delivered",
      );
      assert.equal(state.sessions[key].prompts[0].page, path.basename(entry));
      assert.equal(state.sessions[key].snapshot_page, path.basename(entry));

      const artifactUrl = new URL(`/artifact/${key}/${encodeURIComponent(path.basename(entry))}`, url).href;
      const hostile = `<script>window.received=[];addEventListener('message',e=>{received.push(e.data);e.source.postMessage({type:'lavish:bind',...e.data},'*')})</script><iframe src="${artifactUrl}"></iframe>`;
      const hostilePort = await freePort();
      hostileServer = spawn(process.execPath, ["-e", HOSTILE_SERVER_SCRIPT], {
        env: {
          ...process.env,
          LAVISH_HOSTILE_PORT: String(hostilePort),
          LAVISH_HOSTILE_HTML: Buffer.from(hostile).toString("base64"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      await Promise.race([
        once(hostileServer.stdout, "data").then(([chunk]) => assert.match(String(chunk), /READY/)),
        once(hostileServer, "error").then(([error]) => Promise.reject(error)),
        once(hostileServer, "exit").then(([code]) => Promise.reject(new Error(`hostile server exited ${code}`))),
      ]);
      browser("open", `http://127.0.0.1:${hostilePort}/`);
      const result = browser(
        "eval",
        "async () => { await new Promise(r => setTimeout(r, 500)); return window.received.length; }",
      );
      assert.match(result, /result:\s*"0"/);
      assert.match(browser("console"), /frame-ancestors|refused to frame/i);
    } finally {
      if (hostileServer?.exitCode === null) {
        hostileServer.kill();
        await once(hostileServer, "exit");
      }
      cleanupRun(process.execPath, [cli, "stop", "--port", String(port)], env);
      cleanupRun("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);

const HOSTILE_SERVER_SCRIPT = String.raw`
const http = require("node:http");
const html = Buffer.from(process.env.LAVISH_HOSTILE_HTML, "base64");
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
server.listen(Number(process.env.LAVISH_HOSTILE_PORT), "127.0.0.1", () => process.stdout.write("READY\\n"));
`;

function run(command, args, env, timeout = 45_000) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function cleanupRun(command, args, env, timeout = 15_000) {
  spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

async function eventually(read, predicate, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.fail(`${message}\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
}

test("352-B01", { skip: !runBrowserE2e, timeout: 240_000 }, async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "lavish-352-b01-"));
  const entry = path.join(temp, "start.html");
  const siblingDir = path.join(temp, "sub");
  const sibling = path.join(siblingDir, "index.html");
  const stylesheet = path.join(temp, "review.css");
  const stateDir = path.join(temp, "state");
  const stateFile = path.join(stateDir, "state.json");
  await mkdir(siblingDir);
  await writeFile(stylesheet, "body { font: 16px system-ui; }\n");
  await writeFile(
    entry,
    '<!doctype html><html><head><link rel="stylesheet" href="review.css"></head><body><main><p id="entry-target">Entry review target</p><a href="sub/index.html">Open sibling review page</a></main></body></html>',
  );
  await writeFile(
    sibling,
    '<!doctype html><html><head><link rel="stylesheet" href="../review.css"></head><body><main><p id="sibling-target">Sibling review target</p></main></body></html>',
  );
  const originalBytes = new Map([
    [entry, await readFile(entry)],
    [sibling, await readFile(sibling)],
    [stylesheet, await readFile(stylesheet)],
  ]);
  const canonicalEntry = await realpath(entry);
  const port = await freePort();
  const lavishEnv = {
    LAVISH_AXI_PORT: String(port),
    LAVISH_AXI_STATE_DIR: stateDir,
    LAVISH_AXI_NO_OPEN: "1",
    LAVISH_AXI_TELEMETRY: "0",
    LAVISH_AXI_HOST: "127.0.0.1",
    LAVISH_AXI_LINK_HOST: "127.0.0.1",
  };
  const chromeEnv = {
    CHROME_DEVTOOLS_AXI_SESSION: `lavish-352-b01-${process.pid}`,
    CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
  };
  const cli = path.join(repoRoot, "dist", "cli.mjs");

  function snapshot() {
    return run("chrome-devtools-axi", ["snapshot"], chromeEnv);
  }

  function ref(pattern) {
    const tree = snapshot();
    const line = tree.split("\n").find((candidate) => pattern.test(candidate));
    assert.ok(line, `no snapshot line matching ${pattern}:\n${tree}`);
    return line.trim().split(/\s+/)[0].replace(/^uid=/, "");
  }

  function click(pattern) {
    let staleError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        run("chrome-devtools-axi", ["click", `@${ref(pattern)}`], chromeEnv);
        return;
      } catch (error) {
        if (!/STALE_REF/.test(String(error?.message || error))) throw error;
        staleError = error;
      }
    }
    throw staleError;
  }

  async function state() {
    return JSON.parse(await readFile(stateFile, "utf8"));
  }

  let observations;
  try {
    const opened = run(process.execPath, [cli, entry, "--no-open"], lavishEnv);
    const url = opened.match(/url:\s*"([^"]+)"/)?.[1];
    assert.ok(url, opened);
    const sessionKey = new URL(url).pathname.split("/").pop();
    assert.ok(sessionKey);

    run("chrome-devtools-axi", ["open", url], chromeEnv);
    run("chrome-devtools-axi", ["emulate", "--viewport", "1440x1000x1"], chromeEnv);
    const entryView = await eventually(
      async () => snapshot(),
      (tree) => tree.includes("Entry review target") && !tree.includes("Checking layout."),
      "entry document never became reviewable",
    );
    const initialState = await state();
    const initialRevision = initialState.sessions[sessionKey].artifact_revision;

    click(/Entry review target/);
    await eventually(
      async () => snapshot(),
      (tree) => /button "Queue"/.test(tree),
      "entry annotation card did not open",
    );
    run("chrome-devtools-axi", ["type", "Entry annotation note"], chromeEnv);
    click(/button "Queue"/);
    const entryQueued = await eventually(
      async () => snapshot(),
      (tree) => tree.includes("Entry annotation note"),
      "entry annotation was not queued",
    );

    click(/button "Annotate"/);
    click(/Open sibling review page/);
    const siblingView = await eventually(
      async () => snapshot(),
      (tree) => tree.includes("Sibling review target") && !tree.includes("Checking layout."),
      "authored sibling did not become reviewable",
    );
    click(/button "Annotate"/);
    click(/Sibling review target/);
    await eventually(
      async () => snapshot(),
      (tree) => /button "Queue"/.test(tree),
      "sibling annotation card did not open",
    );
    run("chrome-devtools-axi", ["type", "Sibling question note"], chromeEnv);
    click(/button "Queue"/);
    const siblingQueued = await eventually(
      async () => snapshot(),
      (tree) => tree.includes("Sibling question note"),
      "sibling question was not queued",
    );

    click(/button "More"/);
    click(/button "Reload artifact"/);
    await eventually(
      async () => snapshot(),
      (tree) => tree.includes("Sibling review target") && !tree.includes("Checking layout."),
      "reloaded sibling did not become reviewable",
    );

    run("chrome-devtools-axi", ["back"], chromeEnv);
    const backView = await eventually(
      async () => snapshot(),
      (tree) => /RootWebArea url="[^"]*\/artifact\/[^/]+\/start\.html(?:[?#][^"]*)?"/.test(tree),
      "browser Back did not restore the entry document",
    );
    click(/Entry review target/);
    await eventually(
      async () => snapshot(),
      (tree) => /button "Queue"/.test(tree),
      "BFCache-restored entry did not regain review controls",
    );
    run("chrome-devtools-axi", ["eval", "() => { history.forward(); return true; }"], chromeEnv);
    const forwardView = await eventually(
      async () => snapshot(),
      (tree) => /RootWebArea url="[^"]*\/artifact\/[^/]+\/sub\/index\.html(?:[?#][^"]*)?"/.test(tree),
      "browser Forward did not restore the sibling document",
    );
    click(/Sibling review target/);
    await eventually(
      async () => snapshot(),
      (tree) => /button "Queue"/.test(tree),
      "Forward-restored sibling did not regain review controls",
    );

    click(/button "Send to Agent"/);
    const queuedState = await eventually(
      state,
      (value) => value.sessions?.[sessionKey]?.pending_prompts === 1,
      "the active-page batch did not reach the real store",
    );
    const storedSession = queuedState.sessions[sessionKey];
    const pollOutput = run(process.execPath, [cli, "poll", entry, "--timeout-ms", "10000"], lavishEnv, 30_000);
    const consumedState = await state();
    const consumedSession = consumedState.sessions[sessionKey];
    const finalBytes = new Map(
      await Promise.all(
        [...originalBytes.keys()].map(
          /** @returns {Promise<[string, Buffer]>} */ async (file) => [file, await readFile(file)],
        ),
      ),
    );

    observations = {
      opened,
      url,
      sessionKey,
      entryView,
      entryQueued,
      siblingView,
      siblingQueued,
      backView,
      forwardView,
      initialRevision,
      storedSession,
      pollOutput,
      consumedSession,
      sessionKeys: Object.keys(queuedState.sessions),
      originalBytes,
      finalBytes,
      canonicalEntry,
    };

    await t.test("cli-entry", (child) => {
      child.plan(3);
      child.assert.match(observations.opened, /status: opened/);
      child.assert.match(observations.url, new RegExp(`/session/${observations.sessionKey}$`));
      child.assert.match(observations.entryView, /Entry review target/);
    });
    await t.test("entry-annotation", (child) => {
      child.plan(1);
      child.assert.match(observations.entryQueued, /Entry annotation note/);
    });
    await t.test("authored-sibling-question", (child) => {
      child.plan(3);
      child.assert.match(observations.siblingView, /Sibling review target/);
      child.assert.match(observations.siblingQueued, /Sibling question note/);
      child.assert.equal(observations.storedSession.prompts[0].prompt, "Sibling question note");
    });
    await t.test("back-forward", (child) => {
      child.plan(2);
      child.assert.match(observations.backView, /Entry review target/);
      child.assert.match(observations.forwardView, /Sibling review target/);
    });
    await t.test("sole-session", (child) => {
      child.plan(2);
      child.assert.deepEqual(observations.sessionKeys, [observations.sessionKey]);
      child.assert.equal(observations.storedSession.file, observations.canonicalEntry);
    });
    await t.test("prompt-pages", (child) => {
      child.plan(3);
      child.assert.deepEqual(
        observations.storedSession.prompts.map((prompt) => prompt.page),
        ["sub/index.html"],
      );
      child.assert.doesNotMatch(observations.pollOutput, /,start\.html/);
      child.assert.match(observations.pollOutput, /,sub\/index\.html/);
    });
    await t.test("single-sibling-snapshot", (child) => {
      child.plan(4);
      child.assert.equal(observations.storedSession.snapshot_page, "sub/index.html");
      child.assert.match(observations.storedSession.dom_snapshot, /Sibling review target/);
      child.assert.doesNotMatch(observations.storedSession.dom_snapshot, /Entry review target/);
      child.assert.match(observations.pollOutput, /snapshot_page: sub\/index\.html[\s\S]*dom_snapshot:/);
    });
    await t.test("pending-consumed", (child) => {
      child.plan(3);
      child.assert.match(observations.pollOutput, /status: feedback/);
      child.assert.equal(observations.consumedSession.pending_prompts, 0);
      child.assert.deepEqual(observations.consumedSession.prompts, []);
    });
    await t.test("source-bytes", (child) => {
      child.plan(3);
      for (const [file, original] of observations.originalBytes) {
        child.assert.deepEqual(observations.finalBytes.get(file), original);
      }
    });
    await t.test("reload-generation", (child) => {
      child.plan(2);
      child.assert.equal(observations.storedSession.artifact_revision > observations.initialRevision, true);
      child.assert.equal(observations.consumedSession.artifact_revision, observations.storedSession.artifact_revision);
    });
  } finally {
    cleanupRun(process.execPath, [cli, "stop", "--port", String(port)], lavishEnv);
    cleanupRun("chrome-devtools-axi", ["stop"], chromeEnv);
    await rm(temp, { recursive: true, force: true });
  }
});
