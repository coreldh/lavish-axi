import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

    run("chrome-devtools-axi", ["back"], chromeEnv);
    const backView = await eventually(
      async () => snapshot(),
      (tree) => /RootWebArea url="[^"]*\/artifact\/[^/]+\/start\.html(?:[?#][^"]*)?"/.test(tree),
      "browser Back did not restore the entry document",
    );
    run("chrome-devtools-axi", ["eval", "() => { history.forward(); return true; }"], chromeEnv);
    const forwardView = await eventually(
      async () => snapshot(),
      (tree) => /RootWebArea url="[^"]*\/artifact\/[^/]+\/sub\/index\.html(?:[?#][^"]*)?"/.test(tree),
      "browser Forward did not restore the sibling document",
    );

    click(/button "Send to Agent"/);
    const queuedState = await eventually(
      state,
      (value) => value.sessions?.[sessionKey]?.pending_prompts === 2,
      "the mixed-page batch did not reach the real store",
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
      child.plan(2);
      child.assert.match(observations.entryQueued, /Entry annotation note/);
      child.assert.equal(observations.storedSession.prompts[0].prompt, "Entry annotation note");
    });
    await t.test("authored-sibling-question", (child) => {
      child.plan(3);
      child.assert.match(observations.siblingView, /Sibling review target/);
      child.assert.match(observations.siblingQueued, /Sibling question note/);
      child.assert.equal(observations.storedSession.prompts[1].prompt, "Sibling question note");
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
        ["start.html", "sub/index.html"],
      );
      child.assert.match(observations.pollOutput, /,start\.html/);
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
    await t.test("same-generation", (child) => {
      child.plan(2);
      child.assert.equal(observations.storedSession.artifact_revision, observations.initialRevision);
      child.assert.equal(observations.consumedSession.artifact_revision, observations.initialRevision);
    });
  } finally {
    cleanupRun(process.execPath, [cli, "stop", "--port", String(port)], lavishEnv);
    cleanupRun("chrome-devtools-axi", ["stop"], chromeEnv);
    await rm(temp, { recursive: true, force: true });
  }
});
