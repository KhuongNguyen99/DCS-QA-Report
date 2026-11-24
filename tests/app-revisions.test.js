import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";
import { inspectionTargets } from "../src/domain.js";
import { deviceGraphEntries } from "../src/test-graph-order.js";

const schedule = JSON.parse(await readFile(new URL("../src/data/schedule.json", import.meta.url), "utf8"));
const SKID = "11111111-1111-4111-8111-111111111111";
const INSPECTOR = "22222222-2222-4222-8222-222222222222";
const DEVICE = "device:V-3541";
const copy = value => JSON.parse(JSON.stringify(value));
let directory;
let bundle;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "qc-app-revisions-test-"));
  const output = join(directory, "app.js");
  const mocks = {
    backend: `export const createBackend = () => window.backendMock;
      export const validateBackendConfig = value => value;`,
    config: `export const readConfig = () => ({ url: 'https://example.supabase.co', key: 'public-test-key' });
      export const saveConfig = () => {};`,
    report: `export function approvedReportDate(state) {
        if (state.project.status !== 'closed') throw new Error('Only closed revisions can export.');
        return new Date(state.project.closedAt);
      }
      export async function createInspectionPdf({ state }) {
        window.pdfExports.push(JSON.parse(JSON.stringify(state)));
        return new Blob(['test-pdf'], { type: 'application/pdf' });
      }`,
    'test-report': `export async function createTestReportPdf({ state, runId, backend, timeRanges, graphOrders }) {
      if (state.project.status !== 'closed') throw new Error('Only closed revisions can export.');
      if (typeof backend?.getPhotoUrl !== 'function') throw new Error('Private setup image access must be supplied.');
      window.testPdfExports.push({ state: JSON.parse(JSON.stringify(state)), runId,
        timeRanges: JSON.parse(JSON.stringify(timeRanges || {})), graphOrders: JSON.parse(JSON.stringify(graphOrders || {})) });
      return new Blob(['test-run-pdf'], { type: 'application/pdf' });
    }`,
    VoiceComment: `export default function VoiceComment({ disabled }) {
      return <button type="button" disabled={disabled}>Record voice comment</button>;
    }`,
    CameraDialog: `export default function CameraDialog(props) {
      window.currentCamera = props;
      return <div data-camera data-read-only={String(props.readOnly)}>
        <button onClick={props.onClose}>Close camera</button>
      </div>;
    }`,
    BulkPhotoDialog: `export default function BulkPhotoDialog(props) {
      window.currentBulk = props;
      return <div data-bulk data-read-only={String(props.readOnly)}>
        <button onClick={props.onClose}>Close test bulk queue</button>
        <button disabled={props.readOnly} onClick={() => props.onPhoto('device:V-3541', {
          name: 'new-photo.jpg', blob: new Blob(['pixels'], { type: 'image/jpeg' }), width: 800, height: 600,
        }).catch(error => { window.bulkError = error.message; })}>Save test bulk photo</button>
      </div>;
    }`,
  };
  await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "jsx",
      contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
        import App from './src/App.jsx';
        window.act = React.act; window.root = createRoot(document.getElementById('root'));
        window.mount = () => window.root.render(<React.StrictMode><App /></React.StrictMode>);`,
    },
    bundle: true, jsx: "automatic", format: "iife", outfile: output,
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env.BASE_URL": '"/"' },
    plugins: [{ name: "app-boundaries", setup(builder) {
      builder.onResolve({ filter: /[\\/](backend|config|report|test-report|VoiceComment|CameraDialog|BulkPhotoDialog)\.(js|jsx)$/ }, args => ({
        path: args.path.split(/[\\/]/).at(-1).replace(/\.(js|jsx)$/, ""), namespace: "mock",
      }));
      builder.onLoad({ filter: /.*/, namespace: "mock" }, args => ({
        contents: mocks[args.path], loader: "jsx", resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      }));
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }));
    }}], logLevel: "silent",
  });
  bundle = await readFile(output, "utf8");
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

function createServer({ initiallyClosed = false, checkedByName = "Original checker", emptyWorkspace = false } = {}) {
  const inspector = { id: INSPECTOR, name: "Kong", email: "inspector@example.com", isAdmin: true };
  const initial = {
    inspector,
    project: { walkdownId: SKID, skidName: "Current skid", nameRequired: false,
      revision: 7, status: "draft", contentVersion: 12, checkedByName,
      updatedAt: "2026-11-19T18:00:00Z" },
    records: inspectionTargets(schedule).map(target => ({ key: target.key, complete: false, quality: null })),
    photos: [{ id: "photo-1", walkdownId: SKID, recordKey: DEVICE, path: "private/photo-1.jpg",
      name: "Evidence", width: 800, height: 600, createdBy: INSPECTOR, createdAt: "2026-11-18T14:00:00Z" }],
    comments: [{ id: "comment-1", walkdownId: SKID, recordKey: DEVICE, text: "Original approved note",
      createdBy: INSPECTOR, authorName: "Kong", createdAt: "2026-11-18T14:00:00Z" }],
    testRuns: [], revisions: [],
  };
  const server = { state: copy(initial), calls: [], archives: new Map(), listeners: new Set(), hasReport: !emptyWorkspace };
  server.archives.set(6, { ...copy(initial), comments: [],
    project: { ...copy(initial.project), revision: 6, status: "closed", skidName: "Historical skid name",
      closedAt: "2026-11-18T23:30:00-06:00", closedByName: "Earlier inspector" } });
  function history() {
    server.state.revisions = [...server.archives.values()].map(snapshot => ({
      revision: snapshot.project.revision, skidName: snapshot.project.skidName,
      closedAt: snapshot.project.closedAt, closedByName: snapshot.project.closedByName,
      testRunCount: snapshot.testRuns?.length || 0,
    })).sort((a, b) => b.revision - a.revision);
  }
  server.close = () => {
    server.state.project = { ...server.state.project, status: "closed", closedBy: INSPECTOR,
      closedByName: "Kong", closedAt: "2026-11-19T18:25:00Z" };
    server.archives.set(server.state.project.revision, copy(server.state));
    history();
  };
  server.next = () => {
    server.state.project = { ...server.state.project, revision: server.state.project.revision + 1,
      status: "draft", contentVersion: 1, closedAt: null, closedBy: null, closedByName: null,
      checkedByName: null, checkedByRecordedAt: null, checkedByRecordedBy: null };
  };
  if (initiallyClosed) server.close(); else history();
  const getSession = async () => ({ user: { id: INSPECTOR } });
  const read = () => Promise.resolve(copy(server.state));
  const writable = (revision, metadata = false) => {
    assert.equal(revision, server.state.project.revision, "writes must target the viewed revision");
    assert.equal(server.state.project.status, "draft", "closed reports reject writes");
    if (!metadata) assert.ok(server.state.project.checkedByName?.trim(), "Checked by is required before evidence writes");
  };
  const backend = {
    walkdownId: SKID, getSession, loadState: read,
    subscribe(callback) { server.listeners.add(callback); return () => server.listeners.delete(callback); },
    async loadRevision(revision) {
      server.calls.push({ kind: "loadRevision", revision });
      if (!server.archives.has(revision)) throw new Error("Approve and close this revision before export.");
      return copy(server.archives.get(revision));
    },
    getPhotoUrl: async () => "https://example.invalid/private-photo.jpg",
    forRevision(revision) {
      return {
        walkdownId: SKID, revision, getSession, loadState: read,
        getPhotoUrl: backend.getPhotoUrl,
        async setCheckedBy(name, expectedName) {
          server.calls.push({ kind: "setCheckedBy", revision, name, expectedName });
          if (server.beforeSetCheckedBy) await server.beforeSetCheckedBy();
          writable(revision, true);
          if ((server.state.project.checkedByName ?? null) !== expectedName)
            throw new Error("Checked by changed. Refresh before saving.");
          server.state.project.checkedByName = name.trim();
          server.state.project.checkedByRecordedAt = "2026-11-24T18:00:00Z";
          server.state.project.checkedByRecordedBy = INSPECTOR;
          server.state.project.contentVersion += 1;
          return copy(server.state);
        },
        async approveRevision(contentVersion) {
          writable(revision);
          assert.equal(contentVersion, server.state.project.contentVersion, "approval must use reviewed content");
          server.calls.push({ kind: "approve", revision, contentVersion });
          server.close(); return copy(server.state);
        },
        async newRevision() {
          assert.equal(revision, server.state.project.revision);
          assert.equal(server.state.project.status, "closed");
          server.calls.push({ kind: "new", revision });
          server.next(); return copy(server.state);
        },
        async addComment(key, text) {
          writable(revision); server.calls.push({ kind: "addComment", revision, key, text });
          server.state.comments.push({ id: `comment-${server.state.comments.length + 1}`, walkdownId: SKID,
            recordKey: key, text, createdBy: INSPECTOR, authorName: "Kong", createdAt: "2026-11-19T18:01:00Z" });
          server.state.project.contentVersion += 1;
        },
        async deleteComment(id) {
          writable(revision); server.calls.push({ kind: "deleteComment", revision, id });
          server.state.comments = server.state.comments.filter(comment => comment.id !== id);
          server.state.project.contentVersion += 1;
        },
        async setQuality(key, quality) {
          writable(revision); server.calls.push({ kind: "setQuality", revision, key, quality });
          server.state.records.find(record => record.key === key).quality = quality;
          server.state.project.contentVersion += 1;
        },
        async addPhoto(key, photo) {
          writable(revision); server.calls.push({ kind: "addPhoto", revision, key, name: photo.name });
          const saved = { id: `photo-${server.state.photos.length + 1}`, walkdownId: SKID,
            recordKey: key, path: `private/${photo.name}`, createdBy: INSPECTOR, createdAt: "2026-11-19T18:02:00Z",
            name: photo.name, width: photo.width, height: photo.height };
          server.state.photos.push(saved); server.state.project.contentVersion += 1; return saved;
        },
        async saveTestRun(run) {
          writable(revision); server.calls.push({ kind: "saveTestRun", revision, run: copy(run) });
          const saved = { ...copy(run), walkdownId: SKID, createdBy: INSPECTOR, runVersion: (run.runVersion || 0) + 1 };
          server.state.testRuns = [...server.state.testRuns.filter(item => item.id !== run.id), saved];
          server.state.project.contentVersion += 1;
          return copy(saved);
        },
        async deleteTestRun(id, runVersion) {
          writable(revision); server.calls.push({ kind: "deleteTestRun", revision, id, runVersion });
          assert.equal(server.state.testRuns.find(run => run.id === id).runVersion, runVersion);
          server.state.testRuns = server.state.testRuns.filter(run => run.id !== id);
          server.state.project.contentVersion += 1;
        },
        async addTestSetupPhoto(runId, photo) {
          writable(revision);
          assert.equal(photo.blob.type, "image/jpeg");
          assert.ok(photo.blob.size > 0);
          server.calls.push({ kind: "addSetupPhoto", revision, runId, name: photo.name, caption: photo.caption });
          const run = server.state.testRuns.find(item => item.id === runId);
          assert.ok(run, "setup uploads must target an existing saved run");
          const saved = { id: `setup-${(run.setupPhotos?.length || 0) + 1}`, walkdownId: SKID, testRunId: runId,
            path: `private/${photo.name}`, name: photo.name, width: photo.width, height: photo.height,
            caption: photo.caption || "", createdBy: INSPECTOR, createdAt: "2026-11-19T18:02:00Z" };
          run.setupPhotos = [...(run.setupPhotos || []), saved];
          server.state.project.contentVersion += 1;
          return copy(saved);
        },
        async updateTestSetupPhoto(runId, photoId, caption) {
          writable(revision); server.calls.push({ kind: "setupCaption", revision, runId, photoId, caption });
          const photo = server.state.testRuns.find(run => run.id === runId).setupPhotos.find(item => item.id === photoId);
          photo.caption = caption; server.state.project.contentVersion += 1;
          return copy(photo);
        },
        async deleteTestSetupPhoto(runId, photoId) {
          writable(revision); server.calls.push({ kind: "removeSetup", revision, runId, photoId });
          const run = server.state.testRuns.find(item => item.id === runId);
          run.setupPhotos = run.setupPhotos.filter(item => item.id !== photoId);
          server.state.project.contentVersion += 1;
        },
        async reorderTestSetupPhotos(runId, orderedIds, expectedIds) {
          writable(revision);
          const run = server.state.testRuns.find(item => item.id === runId);
          assert.deepEqual(copy(expectedIds), run.setupPhotos.map(photo => photo.id));
          server.calls.push({ kind: 'orderSetup', revision, runId, orderedIds: copy(orderedIds), expectedIds: copy(expectedIds) });
          run.setupPhotos = Array.from(orderedIds, id => run.setupPhotos.find(photo => photo.id === id));
          server.state.project.contentVersion += 1;
          return copy(run.setupPhotos);
        },
        async reorderPhotos(key, orderedIds, expectedIds) {
          writable(revision);
          const photos = server.state.photos.filter(photo => photo.recordKey === key);
          assert.deepEqual(copy(expectedIds), photos.map(photo => photo.id));
          server.calls.push({ kind: 'orderInspection', key, revision, orderedIds: copy(orderedIds), expectedIds: copy(expectedIds) });
          const saved = orderedIds.map(id => photos.find(photo => photo.id === id));
          server.state.photos = [...server.state.photos.filter(photo => photo.recordKey !== key), ...saved];
          server.state.project.contentVersion += 1;
          return copy(saved);
        },
      };
    },
  };
  server.workspace = {
    getSession,
    async createWalkdown(name) {
      assert.equal(server.hasReport, false, "this fixture creates its first report");
      server.calls.push({ kind: "create", name });
      server.hasReport = true;
      server.state = { ...copy(initial), photos: [], comments: [], testRuns: [], revisions: [],
        project: { ...copy(initial.project), skidName: name, revision: 1, contentVersion: 1,
          checkedByName: null, checkedByRecordedAt: null, checkedByRecordedBy: null } };
      server.archives.clear();
      return { id: SKID, ...copy(server.state.project) };
    },
    async renameWalkdown(id, name, revision) {
      server.calls.push({ kind: "rename", id, name, revision });
      assert.equal(id, SKID);
      writable(revision, true);
      server.state.project.skidName = name;
      server.state.project.contentVersion += 1;
      return { id, ...copy(server.state.project) };
    },
    async listWalkdowns() {
      const { project } = server.state;
      return { inspector, walkdowns: server.hasReport ? [{ id: SKID, ...copy(project) }] : [] };
    },
    forWalkdown(id) { assert.equal(id, SKID); return backend; },
    subscribeWalkdowns: () => () => {},
  };
  return server;
}

async function setup(t, { closed = false, photos, checkedByName = "Original checker", emptyWorkspace = false } = {}) {
  const errors = [];
  const console = new VirtualConsole();
  console.on("jsdomError", error => errors.push(error.message));
  console.on("error", error => errors.push(String(error)));
  const dom = new JSDOM('<!DOCTYPE html><div id="root"></div>', {
    url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: console,
  });
  const { window } = dom;
  const server = createServer({ initiallyClosed: closed, checkedByName, emptyWorkspace });
  if (photos) server.state.photos = copy(photos);
  Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true, backendMock: server.workspace,
    pdfExports: [], testPdfExports: [], downloads: [], scrollTo() {}, structuredClone: copy });
  window.MessageChannel = class {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0) };
    }
  };
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  window.HTMLAnchorElement.prototype.click = function () { window.downloads.push({ href: this.href, name: this.download }); };
  window.URL.createObjectURL = () => "blob:report";
  window.URL.revokeObjectURL = () => {};
  window.createImageBitmap = async () => ({ width: 800, height: 600, close() {} });
  window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {}, save() {}, restore() {}, translate() {}, rotate() {} });
  window.HTMLCanvasElement.prototype.toBlob = function (callback, type) {
    callback(new window.Blob(["normalized image"], { type }));
  };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.eval(bundle);
  await window.act(async () => window.mount());
  t.after(async () => {
    await window.act(async () => window.root.unmount());
    dom.window.close();
    assert.deepEqual(errors, [], "no React or DOM errors");
  });
  const button = (name, root = window.document) => [...root.querySelectorAll("button")].find(item =>
    item.textContent.trim() === name || item.getAttribute("aria-label") === name);
  const click = async item => { assert.ok(item, "button exists"); await window.act(async () => item.click()); };
  return {
    window, document: window.document, server, button, click,
    currentExport: () => button("Export PDF", window.document.querySelector(".heading-actions")),
    async nav(name) {
      await click([...window.document.querySelectorAll("nav button")].find(item => item.querySelector("span")?.textContent === name));
    },
    async fill(element, value) {
      assert.ok(element, "input exists");
      const prototype = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      await window.act(async () => {
        Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
        element.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    },
    async notify() { await window.act(async () => { for (const listener of server.listeners) listener(); }); },
    async openDevice() {
      const row = [...window.document.querySelectorAll("tbody tr")].find(item => item.querySelector("strong")?.textContent === "V-3541");
      await click(row?.querySelector("button.start-button"));
    },
  };
}

async function checkReport(h, name = "Current revision checker") {
  await h.fill(h.document.querySelector("#checked-by-name"), name);
  await h.click(h.button("Save checked by"));
  assert.equal(h.server.state.project.checkedByName, name.trim());
}

test("App creates a report with only its skid name, then requires Checked by before any data entry", async t => {
  const h = await setup(t, { emptyWorkspace: true });
  await h.click(h.button("New skid report"));
  const creation = h.document.querySelector("dialog");
  assert.equal(creation.querySelectorAll("input").length, 1, "creation asks only for the skid name");
  assert.doesNotMatch(creation.textContent, /Checked by|Signed off by/);
  await h.fill(creation.querySelector("input"), "New inspection");
  await h.click(h.button("Create skid report", creation));
  assert.equal(h.document.querySelector("dialog"), null);
  assert.deepEqual(h.server.calls, [{ kind: "create", name: "New inspection" }]);
  const checker = h.document.querySelector("#checked-by-name");
  assert.ok(checker, "required checker form appears after the report is created");
  assert.equal(checker.value, "", "the app does not assume the current user performed the check");
  assert.equal(checker.required, true);
  assert.equal(h.button("Save checked by").disabled, true);
  assert.equal(h.button("Bulk upload photos"), undefined);
  assert.equal(h.button("Rename skid").disabled, false, "metadata naming remains available before checking");
  await h.nav("QC overview");
  assert.ok([...h.document.querySelectorAll('input[type="checkbox"]')].every(input => input.disabled));
  await h.openDevice();
  const record = h.document.querySelector("dialog.record-dialog");
  assert.equal(h.button("Upload photos", record).disabled, true);
  assert.equal(h.button("Take photos", record).disabled, true);
  assert.equal(record.querySelector("textarea"), null);
  await h.click(h.button("Close dialog", record));
  await h.nav("Test reports");
  assert.equal(h.button("Import test run"), undefined);
  await h.nav("Report");
  assert.equal(h.button("Approve & close").disabled, true);
  assert.equal(h.document.querySelector("textarea"), null);
  await h.fill(h.document.querySelector("#checked-by-name"), "   ");
  assert.equal(h.button("Save checked by").disabled, true);
  assert.equal(h.server.calls.length, 1, "blocked evidence controls send no writes");
  await checkReport(h, "  Miro Gohacki  ");
  assert.deepEqual(h.server.calls.at(-1), {
    kind: "setCheckedBy", revision: 1, name: "Miro Gohacki", expectedName: null,
  });
  assert.ok(h.document.querySelector('textarea[id="comment-walkdown:general"]'));
  assert.equal(h.button("Approve & close").disabled, false);
  assert.equal(h.button("Bulk upload photos").disabled, false);
  await h.nav("Test reports");
  assert.equal(h.button("Import test run").disabled, false);
});

test("App retains existing evidence and historical exports while Checked by is required", async t => {
  const h = await setup(t, { checkedByName: null });
  const evidence = copy({ photos: h.server.state.photos, comments: h.server.state.comments });
  await h.nav("Report");
  await h.click(h.button("Export revision 6"));
  assert.equal(h.window.pdfExports.at(-1).project.revision, 6, "legacy approved reports remain exportable");
  assert.deepEqual(copy({ photos: h.server.state.photos, comments: h.server.state.comments }), evidence);
  await checkReport(h, "Manual checker");
  assert.deepEqual(copy({ photos: h.server.state.photos, comments: h.server.state.comments }), evidence);
  await h.click(h.button("Approve & close"));
  await h.click(h.button("Confirm approval & close"));
  const approved = h.server.archives.get(7);
  assert.equal(approved.project.checkedByName, "Manual checker");
  assert.equal(approved.project.closedByName, "Kong", "sign-off comes from the authenticated approver");
  assert.match(h.document.querySelector(".revision-panel").textContent, /Checked by.*Manual checker/);
  assert.match(h.document.querySelector(".revision-panel").textContent, /Signed off by.*Kong/);
  assert.equal(h.document.querySelector("#checked-by-name"), null, "approved checker cannot be edited");
  await h.click(h.currentExport());
  assert.equal(h.window.pdfExports.at(-1).project.checkedByName, "Manual checker");
  await h.click(h.button("New revision"));
  assert.equal(h.server.state.project.checkedByName, null);
  await checkReport(h, "Next checker");
  await h.click(h.button("Export revision 7"));
  assert.equal(h.window.pdfExports.at(-1).project.checkedByName, "Manual checker", "later checker changes do not rewrite history");
});

test("App keeps a failed checker entry for retry and refuses to overwrite a concurrent name change", async t => {
  const h = await setup(t, { checkedByName: null });
  await h.nav("Report");
  await h.fill(h.document.querySelector("#checked-by-name"), "First checker");
  h.server.beforeSetCheckedBy = () => { throw new Error("Connection interrupted"); };
  await h.click(h.button("Save checked by"));
  assert.equal(h.document.querySelector("#checked-by-name").value, "First checker");
  assert.equal(h.server.state.project.checkedByName, null);
  assert.match(h.document.body.textContent, /Connection interrupted/);
  assert.equal(h.button("Approve & close").disabled, true);
  h.server.beforeSetCheckedBy = null;
  await h.click(h.button("Save checked by"));
  assert.equal(h.server.state.project.checkedByName, "First checker");
  await h.fill(h.document.querySelector("#checked-by-name"), "My correction");
  h.server.beforeSetCheckedBy = () => {
    h.server.state.project.checkedByName = "Teammate correction";
    h.server.state.project.contentVersion += 1;
  };
  await h.click(h.button("Save checked by"));
  assert.equal(h.server.state.project.checkedByName, "Teammate correction");
  assert.equal(h.server.calls.at(-1).expectedName, "First checker");
  assert.match(h.document.body.textContent, /Checked by changed.*Refresh/);
});

test("App requires approval before exporting and creates an editable next revision while retaining historical exports", async t => {
  const h = await setup(t);
  await h.nav("Report");
  assert.equal(h.currentExport().disabled, true);
  await h.click(h.currentExport());
  assert.equal(h.server.calls.length, 0);
  const draft = h.document.querySelector('textarea[id="comment-walkdown:general"]');
  await h.fill(draft, "Review this before closing");
  assert.equal(h.button("Approve & close").disabled, true);
  await h.click(h.button("Add walkdown comment"));
  assert.equal(h.server.calls.at(-1).revision, 7);
  assert.equal(h.button("Approve & close").disabled, false);
  await h.click(h.button("Approve & close"));
  await h.click(h.button("Confirm approval & close"));
  assert.deepEqual(h.server.calls.find(call => call.kind === "approve"), { kind: "approve", revision: 7, contentVersion: 13 });
  assert.equal(h.server.state.project.status, "closed");
  assert.equal(h.currentExport().disabled, false);
  assert.equal(h.document.querySelector("textarea"), null);
  await h.click(h.currentExport());
  assert.equal(h.window.pdfExports.at(-1).project.revision, 7);
  assert.match(h.window.downloads.at(-1).name, /DCS-QC-Report-Rev7-2026-11-19\.pdf$/);
  await h.click(h.button("New revision"));
  assert.equal(h.server.state.project.revision, 8);
  assert.equal(h.server.state.project.status, "draft");
  assert.equal(h.currentExport().disabled, true);
  assert.equal(h.server.state.project.checkedByName, null);
  assert.equal(h.document.querySelector("textarea"), null, "new revision requires a checker before comment entry");
  await checkReport(h);
  assert.equal(h.document.querySelector("textarea").value, "");
  await h.fill(h.document.querySelector("textarea"), "Only in revision eight");
  await h.click(h.button("Add walkdown comment"));
  assert.equal(h.server.calls.at(-1).revision, 8, "new draft edits bind to the new revision");
  await h.click(h.button("Export revision 6"));
  assert.equal(h.server.calls.at(-1).kind, "loadRevision");
  assert.equal(h.server.calls.at(-1).revision, 6);
  assert.equal(h.window.pdfExports.at(-1).project.skidName, "Historical skid name");
  assert.equal(h.window.pdfExports.at(-1).comments.length, 0, "historical export does not include current comments");
  assert.match(h.window.downloads.at(-1).name, /Historical skid name-DCS-QC-Report-Rev6-2026-11-19\.pdf$/);
  await h.click(h.button("Approve & close"));
  await h.click(h.button("Confirm approval & close"));
  assert.equal(h.server.state.project.status, "closed");
  assert.deepEqual([...h.server.archives.keys()], [6, 7, 8]);
  assert.equal(h.server.archives.get(7).comments.length, 2, "prior closed revision keeps its original comments");
});

test("App makes closed records and overview read-only, then routes deletion and quality to the new draft", async t => {
  const h = await setup(t, { closed: true });
  assert.equal(h.button("Bulk upload photos"), undefined);
  assert.equal(h.button("Rename skid").disabled, true);
  await h.nav("QC overview");
  assert.ok([...h.document.querySelectorAll('input[type="checkbox"]')].every(input => input.disabled));
  assert.equal(h.button("Start documenting"), undefined);
  await h.openDevice();
  const dialog = h.document.querySelector("dialog.record-dialog");
  assert.ok(dialog);
  assert.equal(h.button("Upload photos", dialog).disabled, true);
  assert.equal(h.button("Take photos", dialog).disabled, true);
  assert.equal(h.button("Mark complete", dialog).disabled, true);
  assert.equal(dialog.querySelector("textarea"), null);
  assert.equal(h.button("Remove comment by Kong", dialog), undefined);
  await h.click(h.button("Close dialog", dialog));
  await h.nav("Report");
  await h.click(h.button("New revision"));
  await checkReport(h);
  await h.nav("QC overview");
  await h.openDevice();
  const editing = h.document.querySelector("dialog.record-dialog");
  assert.equal(h.button("Upload photos", editing).disabled, false);
  await h.click(h.button("Remove comment by Kong", editing));
  await h.click(h.button("Remove comment", editing));
  assert.deepEqual(h.server.calls.at(-1), { kind: "deleteComment", revision: 8, id: "comment-1" });
  assert.equal(h.server.state.comments.length, 0);
  assert.equal(h.server.archives.get(7).comments.length, 1);
  const passed = editing.querySelector('input[aria-label="Passed quality for V-3541"]');
  assert.equal(passed.disabled, false);
  await h.window.act(async () => passed.click());
  assert.deepEqual(h.server.calls.at(-1), { kind: "setQuality", revision: 8, key: DEVICE, quality: "good" });
});

test("App invalidates an open review when shared content changes before approval", async t => {
  const h = await setup(t);
  await h.nav("Report");
  await h.click(h.button("Approve & close"));
  h.server.state.project.contentVersion += 1;
  await h.notify();
  assert.equal(h.button("Confirm approval & close").disabled, true);
  assert.match(h.document.body.textContent, /report changed while you were reviewing/);
  await h.click(h.button("Confirm approval & close"));
  assert.equal(h.server.calls.filter(call => call.kind === "approve").length, 0);
  await h.click(h.button("Cancel"));
  await h.click(h.button("Approve & close"));
  await h.click(h.button("Confirm approval & close"));
  assert.equal(h.server.calls.find(call => call.kind === "approve").contentVersion, 13);
});

test("App keeps a bulk queue pinned to its opening revision across remote closeout and a newer draft", async t => {
  const h = await setup(t);
  await h.click(h.button("Bulk upload photos"));
  const oldSave = h.window.currentBulk.onPhoto;
  assert.equal(h.window.currentBulk.readOnly, false);
  h.server.close();
  await h.notify();
  assert.equal(h.window.currentBulk.readOnly, true);
  assert.equal(h.button("Save test bulk photo").disabled, true);
  await assert.rejects(oldSave(DEVICE, {}), /closed or no longer active/);
  h.server.next();
  await h.notify();
  assert.equal(h.window.currentBulk.readOnly, true, "old queue is not rebound to another revision");
  await assert.rejects(oldSave(DEVICE, {}), /closed or no longer active/);
  assert.equal(h.server.calls.filter(call => call.kind === "addPhoto").length, 0);
  await h.click(h.button("Close test bulk queue"));
  await checkReport(h);
  await h.click(h.button("Bulk upload photos"));
  assert.equal(h.window.currentBulk.readOnly, false);
  await h.click(h.button("Save test bulk photo"));
  assert.deepEqual(h.server.calls.find(call => call.kind === "addPhoto"), {
    kind: "addPhoto", revision: 8, key: DEVICE, name: "new-photo.jpg",
  });
});

test("App pins an open camera's photo and quality writes to its original revision", async t => {
  const h = await setup(t);
  await h.nav("QC overview");
  await h.openDevice();
  await h.click(h.button("Take photos", h.document.querySelector("dialog.record-dialog")));
  const oldPhoto = h.window.currentCamera.onPhoto;
  const oldQuality = h.window.currentCamera.onQuality;
  assert.equal(h.window.currentCamera.readOnly, false);
  h.server.close();
  await h.notify();
  assert.equal(h.window.currentCamera.readOnly, true);
  assert.throws(() => oldPhoto({}), /camera belongs to a closed or earlier revision/);
  assert.throws(() => oldQuality("good"), /camera belongs to a closed or earlier revision/);
  h.server.next();
  await h.notify();
  assert.equal(h.server.state.project.status, "draft");
  assert.equal(h.window.currentCamera.readOnly, true, "opening another draft cannot rebind an existing camera");
  assert.throws(() => h.window.currentCamera.onPhoto({}), /camera belongs to a closed or earlier revision/);
  assert.throws(() => h.window.currentCamera.onQuality("good"), /camera belongs to a closed or earlier revision/);
  assert.equal(h.server.calls.filter(call => ["addPhoto", "setQuality"].includes(call.kind)).length, 0);
  await h.click(h.button("Close camera"));
  await checkReport(h);
  await h.click(h.button("Take photos", h.document.querySelector("dialog.record-dialog")));
  assert.equal(h.window.currentCamera.readOnly, false);
  await h.window.act(async () => h.window.currentCamera.onQuality("good"));
  await h.window.act(async () => h.window.currentCamera.onPhoto({ name: "new-camera.jpg", width: 800, height: 600 }));
  assert.deepEqual(h.server.calls.filter(call => ["addPhoto", "setQuality"].includes(call.kind)), [
    { kind: "setQuality", revision: 8, key: DEVICE, quality: "good" },
    { kind: "addPhoto", revision: 8, key: DEVICE, name: "new-camera.jpg" },
  ]);
});

test("App rejects a rename dialog from an earlier revision until it is reopened for the current draft", async t => {
  const h = await setup(t);
  await h.click(h.button("Rename skid"));
  await h.fill(h.document.querySelector("dialog input"), "Stale name");
  h.server.close();
  h.server.next();
  await h.notify();
  await h.click(h.button("Save skid name"));
  assert.equal(h.server.calls.filter(call => call.kind === "rename").length, 0, "stale dialog must not reach the rename API");
  assert.match(h.document.querySelector('dialog [role="alert"]').textContent, /report revision changed/);
  assert.equal(h.server.state.project.skidName, "Current skid");
  await h.click(h.button("Close dialog"));
  await h.click(h.button("Rename skid"));
  await h.fill(h.document.querySelector("dialog input"), "Reviewed name");
  await h.click(h.button("Save skid name"));
  assert.deepEqual(h.server.calls.find(call => call.kind === "rename"), {
    kind: "rename", id: SKID, name: "Reviewed name", revision: 8,
  });
  assert.equal(h.server.state.project.skidName, "Reviewed name");
  assert.equal(h.document.querySelector("dialog"), null);
});

test("App selects a newly created skid after saving its name", async t => {
  const h = await setup(t);
  const nextId = "33333333-3333-4333-8333-333333333333";
  const created = copy(h.server.state);
  created.project = { ...created.project, walkdownId: nextId, revision: 1, contentVersion: 1, skidName: "New skid", checkedByName: null };
  created.photos = [];
  created.comments = [];
  created.revisions = [];
  let saved = false;
  const originalList = h.server.workspace.listWalkdowns;
  const originalScope = h.server.workspace.forWalkdown;
  h.server.workspace.createWalkdown = async name => {
    assert.equal(name, "New skid");
    saved = true;
    return { id: nextId, ...copy(created.project) };
  };
  h.server.workspace.listWalkdowns = async () => {
    const workspace = await originalList();
    if (saved) workspace.walkdowns.push({ id: nextId, ...copy(created.project) });
    return workspace;
  };
  const newScope = {
    walkdownId: nextId,
    loadState: async () => copy(created),
    subscribe: () => () => {},
    forRevision: revision => ({ walkdownId: nextId, revision }),
  };
  h.server.workspace.forWalkdown = id => id === nextId ? newScope : originalScope(id);
  await h.click(h.button("New skid report"));
  await h.fill(h.document.querySelector("dialog input"), "New skid");
  await h.click(h.button("Create skid report"));
  assert.equal(saved, true);
  assert.equal(h.document.querySelector("dialog"), null);
  assert.equal(h.document.querySelector("#skid-report").value, nextId);
  assert.match(h.document.querySelector(".project-tag").textContent, /New skid.*QC Revision 1/);
  assert.equal(h.document.querySelector('textarea[id="comment-walkdown:general"]'), null);
  assert.equal(h.document.querySelector("#checked-by-name").value, "");
});

const testRun = () => ({
  id: "44444444-4444-4444-8444-444444444444", walkdownId: SKID,
  createdBy: INSPECTOR, runVersion: 1, schemaVersion: 1, name: "Valve test",
  software: { name: "Siemens PRONETA Basic", version: "3.9-test" },
  clock: { basis: "source-local", timeZone: "Source clock", startMs: null, endMs: null },
  sources: [], stations: [], devices: [], unassignedChannels: [], warnings: [],
});

function graphOrderRun() {
  const startMs = Date.UTC(2026, 10, 19, 12);
  const signals = [
    { id: "command", name: "Close command", kind: "digital", unit: "", values: [0, 1, 0] },
    { id: "feedback", name: "Close feedback", kind: "analog", unit: "V", values: [0, 0.3, 0] },
    { id: "position", name: "Position", kind: "analog", unit: "mA", values: [4, 20, 4] },
  ];
  return { ...testRun(), clock: { basis: "source-local", timeZone: "Source clock", startMs, endMs: startMs + 60_000 },
    devices: [{ id: "valve", name: "VALVE", status: "Passed", channels: signals.map(signal => ({
      id: signal.id, symbolicName: signal.name, status: "Passed", parameters: [],
      series: [{ id: `${signal.id}-series`, name: signal.name, kind: signal.kind, unit: signal.unit,
        points: [5000, 20_000, 50_000].map((offset, index) => ({ timeMs: startMs + offset, value: signal.values[index], valid: true })) }],
    })) }] };
}

async function chooseTestSetupPhotos(h, ...names) {
  const input = h.document.querySelector('.test-setup-bulk-dialog input[aria-label="Choose test setup photos"]');
  assert.ok(input, "the real test setup upload dialog is open");
  Object.defineProperty(input, "files", { configurable: true,
    value: names.map(name => new h.window.File(["image pixels"], name, { type: "image/jpeg" })) });
  await h.window.act(async () => input.dispatchEvent(new h.window.Event("change", { bubbles: true })));
  assert.equal(h.button("Save & next").disabled, false, "the selected image is prepared for review");
}

test("App retains an unsaved setup bulk queue and blocks run changes, approval, and signout until discard", async t => {
  const h = await setup(t);
  const otherRun = { ...testRun(), id: "55555555-5555-4555-8555-555555555555", name: "Pressure test" };
  h.server.state.testRuns = [testRun(), otherRun];
  await h.notify();
  await h.nav("Test reports");
  await h.click(h.button("Bulk upload photos", h.document.querySelector(".test-setup")));
  await chooseTestSetupPhotos(h, "unsaved-wiring.jpg");
  await h.fill(h.document.querySelector(".test-setup-bulk-dialog textarea"), "Unsaved setup caption");
  const runSelect = h.document.querySelector(".test-run-toolbar select");
  assert.equal(runSelect.disabled, true);
  assert.equal(runSelect.value, testRun().id);
  assert.equal(h.button("Edit run").disabled, true);
  assert.equal(h.document.querySelector("#skid-report").disabled, true);
  const leaving = new h.window.Event("beforeunload", { cancelable: true });
  h.window.dispatchEvent(leaving);
  assert.equal(leaving.defaultPrevented, true);
  await h.nav("Report");
  assert.equal(h.button("Approve & close").disabled, true);
  await h.click(h.button("Approve & close"));
  assert.equal(h.server.calls.some(call => call.kind === "approve"), false);
  await h.nav("Workspace");
  assert.equal(h.button("Sign out").disabled, true);
  await h.nav("Test reports");
  assert.equal(h.document.querySelector(".test-setup-bulk-dialog textarea").value, "Unsaved setup caption");

  const confirmations = [];
  h.window.confirm = text => { confirmations.push(text); return false; };
  await h.click(h.button("Close bulk upload"));
  assert.match(confirmations[0], /Discard 1 photo.*captions/);
  assert.equal(h.document.querySelector(".test-setup-bulk-dialog textarea").value, "Unsaved setup caption");
  assert.equal(runSelect.disabled, true);
  h.window.confirm = () => true;
  await h.click(h.button("Close bulk upload"));
  assert.equal(h.document.querySelector(".test-setup-bulk-dialog"), null);
  assert.equal(runSelect.disabled, false);
  assert.equal(h.document.querySelector("#skid-report").disabled, false);
  await h.window.act(async () => {
    runSelect.value = otherRun.id;
    runSelect.dispatchEvent(new h.window.Event("change", { bubbles: true }));
  });
  assert.equal(h.document.querySelector(".test-preview h2").textContent, otherRun.name);
  await h.nav("Report");
  assert.equal(h.button("Approve & close").disabled, false);
  await h.nav("Workspace");
  assert.equal(h.button("Sign out").disabled, false);
  assert.deepEqual(h.server.calls, [], "discarded images and captions never reach the database");
});

test("App saves bulk photos with captions once and advances after a successful write even if refresh fails", async t => {
  const h = await setup(t);
  h.server.state.testRuns = [testRun()];
  await h.notify();
  await h.nav("Test reports");
  await h.click(h.button("Bulk upload photos", h.document.querySelector(".test-setup")));
  await chooseTestSetupPhotos(h, "wiring.jpg", "air-supply.jpg");
  await h.fill(h.document.querySelector(".test-setup-bulk-dialog textarea"), "  Feedback wiring at CH0  ");
  const backend = h.server.workspace.forWalkdown(SKID), read = backend.loadState;
  let failNextRead = true;
  backend.loadState = async () => {
    if (failNextRead) { failNextRead = false; throw new Error("Connection lost after saving"); }
    return read();
  };
  await h.click(h.button("Save & next"));
  assert.deepEqual(h.server.calls, [{ kind: "addSetupPhoto", revision: 7, runId: testRun().id,
    name: "wiring.jpg", caption: "Feedback wiring at CH0" }]);
  assert.equal(h.server.state.testRuns[0].setupPhotos.length, 1);
  assert.equal(h.document.querySelector(".test-setup-caption").textContent, "Feedback wiring at CH0",
    "the committed image and caption remain visible without a successful refresh");
  assert.match(h.document.body.textContent, /change was saved, but the report could not refresh/);
  assert.equal(h.document.querySelector(".test-setup-bulk-dialog .bulk-image-caption span").textContent, "air-supply.jpg");
  assert.equal(h.document.querySelector(".test-setup-bulk-dialog textarea").value, "");
  assert.equal(h.document.querySelector('.test-setup-bulk-dialog [role="alert"]'), null,
    "a post-write refresh failure must not offer retrying the already saved image");
  assert.equal(h.button("Save & next").disabled, false);
  await h.fill(h.document.querySelector(".test-setup-bulk-dialog textarea"), "Regulated air supply at 6 bar");
  await h.click(h.button("Save & next"));
  assert.deepEqual(h.server.calls, [
    { kind: "addSetupPhoto", revision: 7, runId: testRun().id, name: "wiring.jpg", caption: "Feedback wiring at CH0" },
    { kind: "addSetupPhoto", revision: 7, runId: testRun().id, name: "air-supply.jpg", caption: "Regulated air supply at 6 bar" },
  ], "each image carries its caption in one upload call, without a separate caption write or duplicate");
  assert.equal(h.server.state.testRuns[0].setupPhotos.length, 2);
  assert.match(h.document.querySelector(".test-setup-bulk-dialog .bulk-complete").textContent, /2 photos saved/);
  await h.click(h.button("Done"));
  assert.equal(h.document.querySelector(".test-setup-bulk-dialog"), null);
  assert.equal(h.document.querySelector(".test-run-toolbar select").disabled, false);
  assert.equal(h.document.querySelector("#skid-report").disabled, false);
  await h.nav("Workspace");
  assert.equal(h.button("Sign out").disabled, false);
  await h.nav("Report");
  assert.equal(h.button("Approve & close").disabled, false);
});

test("App blocks approval for unsaved setup captions and preserves approved photos after a later removal", async t => {
  const h = await setup(t);
  const photo = { id: "setup-1", walkdownId: SKID, testRunId: testRun().id,
    path: "private/test-setup.jpg", name: "Test setup", width: 800, height: 600,
    caption: "Original caption", createdBy: INSPECTOR };
  h.server.state.testRuns = [{ ...testRun(), setupPhotos: [photo] }];
  await h.notify();
  await h.nav("Test reports");
  await h.click(h.button("Edit caption"));
  await h.fill(h.document.querySelector('.test-setup-caption-editor textarea'), "Wiring and pneumatic connections checked");
  assert.equal(h.document.querySelector("#skid-report").disabled, true);
  await h.nav("Report");
  assert.equal(h.button("Approve & close").disabled, true);
  await h.nav("Test reports");
  await h.click(h.button("Save caption"));
  assert.deepEqual(h.server.calls.at(-1), { kind: "setupCaption", revision: 7, runId: testRun().id,
    photoId: "setup-1", caption: "Wiring and pneumatic connections checked" });
  await h.nav("Report");
  assert.equal(h.button("Approve & close").disabled, false);
  await h.click(h.button("Approve & close"));
  assert.match(h.document.querySelector('[aria-label="Confirm report approval"]').textContent, /1 setup photos/);
  await h.click(h.button("Confirm approval & close"));
  await h.nav("Test reports");
  assert.equal(h.button("Add setup photos"), undefined);
  assert.equal(h.button("Edit caption"), undefined);
  assert.equal(h.button("Remove photo"), undefined);
  await h.nav("Report");
  await h.click(h.button("New revision"));
  await checkReport(h);
  await h.nav("Test reports");
  await h.click(h.button("Remove photo"));
  await h.click(h.button("Confirm removal"));
  assert.equal(h.server.calls.at(-1).kind, "removeSetup");
  assert.equal(h.server.calls.at(-1).revision, 8);
  assert.equal(h.server.state.testRuns[0].setupPhotos.length, 0);
  const archived = h.server.archives.get(7).testRuns[0].setupPhotos;
  assert.equal(archived.length, 1);
  assert.equal(archived[0].caption, "Wiring and pneumatic connections checked");
});

async function movePhotoLater(h, name) {
  const cards = Array.from(h.document.querySelectorAll('.test-setup-photo'));
  const index = cards.findIndex(card => card.querySelector('.test-setup-filename').textContent === name);
  assert.ok(index >= 0 && index + 1 < cards.length);
  const thumbnail = cards[index].querySelector('.test-setup-thumbnail');
  assert.equal(thumbnail.draggable, true);
  await h.window.act(async () => {
    for (const [target, type] of [[thumbnail, 'dragstart'], [cards[index + 1], 'drop']]) {
      const event = new h.window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { setData() {} } });
      target.dispatchEvent(event);
    }
  });
}

test('App saves setup photo order before approval and exports the original order from a later revision archive', async t => {
  const h = await setup(t);
  const photos = ['a', 'b', 'c'].map(id => ({ id: `setup-${id}`, name: `${id}.jpg`, walkdownId: SKID, testRunId: testRun().id,
    path: `private/${id}.jpg`, width: 800, height: 600, caption: `Caption ${id}`, createdBy: INSPECTOR }));
  h.server.state.testRuns = [{ ...testRun(), setupPhotos: photos }];
  await h.notify(); await h.nav('Test reports');
  await movePhotoLater(h, 'a.jpg');
  assert.deepEqual(h.server.calls.at(-1), { kind: 'orderSetup', revision: 7, runId: testRun().id,
    orderedIds: ['setup-b', 'setup-a', 'setup-c'], expectedIds: ['setup-a', 'setup-b', 'setup-c'] });
  await h.nav('Report');
  await h.click(h.button('Approve & close')); await h.click(h.button('Confirm approval & close'));
  await h.nav('Test reports'); await h.click(h.button('Export test PDF'));
  assert.deepEqual(copy(h.window.testPdfExports.at(-1).state.testRuns[0].setupPhotos.map(photo => photo.id)), ['setup-b', 'setup-a', 'setup-c']);
  assert.equal(h.document.querySelector('.test-setup-thumbnail').draggable, false);
  await h.nav('Report'); await h.click(h.button('New revision')); await checkReport(h); await h.nav('Test reports');
  await movePhotoLater(h, 'a.jpg');
  assert.deepEqual(copy(h.server.state.testRuns[0].setupPhotos.map(photo => photo.id)), ['setup-b', 'setup-c', 'setup-a']);
  await h.nav('Report'); await h.click(h.button('Export test reports revision 7'));
  assert.deepEqual(copy(h.window.testPdfExports.at(-1).state.testRuns[0].setupPhotos.map(photo => photo.id)), ['setup-b', 'setup-a', 'setup-c']);
});

const inspectionOrderPhotos = () => ['a', 'b', 'c'].map(id => ({ id: `inspection-${id}`, walkdownId: SKID, recordKey: DEVICE,
  path: `private/${id}.jpg`, name: `${id}.jpg`, width: 800, height: 600, createdBy: INSPECTOR, createdAt: '2026-11-20T12:00:00Z' }));

test("App retains pending test edits while Checked by is missing and resumes them after the name is saved", async t => {
  const h = await setup(t);
  h.server.state.testRuns = [testRun()];
  await h.notify();
  await h.nav("Test reports");
  await h.fill(h.document.querySelector('[aria-label="Overall test run comment"] textarea'), "Keep this pending observation");
  const cachedBefore = Array.from({ length: h.window.localStorage.length }, (_, i) => h.window.localStorage.key(i))
    .map(key => h.window.localStorage.getItem(key)).find(value => value.includes("Keep this pending observation"));
  assert.ok(cachedBefore, "pending authored text was cached before the gate changed");
  h.server.state.project.checkedByName = null;
  await h.notify();
  assert.equal(h.button("Save test run").disabled, true);
  assert.match(h.document.querySelector('[aria-label="Overall test run comment"]').textContent, /Keep this pending observation/);
  assert.equal(h.document.querySelector('[aria-label="Overall test run comment"] textarea'), null, "pending comments are visible but not editable before checking");
  const formText = h.document.querySelector(".test-import-form").textContent;
  assert.match(formText, /Checked by/);
  assert.doesNotMatch(formText, /Discard this draft/);
  await checkReport(h, "Confirmed checker");
  assert.equal(h.button("Save test run").disabled, false);
  assert.equal(h.document.querySelector('[aria-label="Overall test run comment"] textarea').value, "Keep this pending observation");
  await h.click(h.button("Save test run"));
  assert.equal(h.server.state.testRuns[0].comment, "Keep this pending observation");
  assert.deepEqual(h.server.calls.map(call => call.kind), ["setCheckedBy", "saveTestRun"]);
});

test('inspection image moves save immediately and remain frozen in archived PDF exports', async t => {
  const h = await setup(t, { photos: inspectionOrderPhotos() });
  await h.nav('QC overview'); await h.openDevice();
  await movePhotoLater(h, 'a.jpg');
  assert.deepEqual(h.server.calls.at(-1), { kind: 'orderInspection', key: DEVICE, revision: 7,
    orderedIds: ['inspection-b', 'inspection-a', 'inspection-c'], expectedIds: ['inspection-a', 'inspection-b', 'inspection-c'] });
  await h.click(h.button('Close dialog'));
  await h.nav('Report');
  await h.click(h.button('Approve & close')); await h.click(h.button('Confirm approval & close'));
  await h.click(h.currentExport());
  assert.deepEqual(copy(h.window.pdfExports.at(-1).photos.map(photo => photo.id)), ['inspection-b', 'inspection-a', 'inspection-c']);
  await h.click(h.button('New revision')); await checkReport(h); await h.nav('QC overview'); await h.openDevice();
  await movePhotoLater(h, 'a.jpg'); await h.click(h.button('Close dialog'));
  assert.deepEqual(copy(h.server.state.photos.map(photo => photo.id)), ['inspection-b', 'inspection-c', 'inspection-a']);
  await h.nav('Report'); await h.click(h.button('Export revision 7'));
  assert.deepEqual(copy(h.window.pdfExports.at(-1).photos.map(photo => photo.id)), ['inspection-b', 'inspection-a', 'inspection-c']);
});

test("App keeps unsaved test edits across navigation, locks approval, and exports only the archived run", async t => {
  const h = await setup(t);
  const setupPhoto = { id: "setup-1", walkdownId: SKID, testRunId: testRun().id,
    path: "private/original-setup.jpg", name: "Original setup", width: 800, height: 600,
    caption: "Approved pneumatic and feedback setup", createdBy: INSPECTOR };
  h.server.state.testRuns = [{ ...testRun(), setupPhotos: [setupPhoto],
    devices: [{ id: "V-3541", name: "V-3541", status: "Passed", channels: [] }] }];
  await h.notify();
  await h.nav("Test reports");
  assert.equal(h.button("Export test PDF").disabled, true);
  await h.fill(h.document.querySelector('[aria-label="Overall test run comment"] textarea'), "Run reviewed before approval");
  await h.fill(h.document.querySelector('.test-device-content .test-comment textarea'), "Device wiring verified\nRetest complete");
  const name = [...h.document.querySelectorAll(".test-metadata-grid label")].find(item => item.textContent === "Test run name").querySelector("input");
  await h.fill(name, "Reviewed valve test");
  assert.equal(h.document.querySelector("#skid-report").disabled, true);
  await h.nav("Workspace");
  assert.equal(h.button("Sign out").disabled, true);
  await h.nav("Report");
  assert.equal(h.button("Approve & close").disabled, true);
  await h.click(h.button("Review test reports"));
  assert.equal(name.value, "Reviewed valve test", "navigation preserves local import metadata");
  assert.equal(h.document.querySelector('[aria-label="Overall test run comment"] textarea').value, "Run reviewed before approval");
  await h.click(h.button("Save test run"));
  assert.equal(h.server.calls.at(-1).kind, "saveTestRun");
  assert.equal(h.server.calls.at(-1).revision, 7);
  assert.equal(h.server.calls.at(-1).run.runVersion, 1);
  assert.equal(h.server.state.testRuns[0].name, "Reviewed valve test");
  assert.equal(h.server.state.testRuns[0].comment, "Run reviewed before approval");
  assert.equal(h.server.state.testRuns[0].devices[0].comment, "Device wiring verified\nRetest complete");
  await h.nav("Report");
  assert.equal(h.button("Approve & close").disabled, false);
  await h.click(h.button("Approve & close"));
  assert.match(h.document.querySelector('[aria-label="Confirm report approval"]').textContent, /1 test runs/);
  await h.click(h.button("Confirm approval & close"));
  await h.nav("Test reports");
  assert.equal(h.button("Import test run"), undefined);
  assert.equal(h.button("Edit run"), undefined);
  assert.equal(h.button("Remove run"), undefined);
  await h.click(h.button("Export test PDF"));
  assert.equal(h.window.testPdfExports.at(-1).runId, testRun().id);
  assert.equal(h.window.testPdfExports.at(-1).state.project.revision, 7);
  assert.equal(h.document.querySelector('.test-comment textarea'), null, "approved comments are read-only");
  assert.equal(h.window.testPdfExports.at(-1).state.testRuns[0].comment, "Run reviewed before approval");
  assert.equal(h.window.testPdfExports.at(-1).state.testRuns[0].devices[0].comment, "Device wiring verified\nRetest complete");
  assert.deepEqual(copy(h.window.testPdfExports.at(-1).state.testRuns[0].setupPhotos), [setupPhoto]);
  assert.match(h.window.downloads.at(-1).name, /DCS-IO-Test-Report-Rev7-2026-11-19\.pdf$/);
  await h.nav("Report");
  await h.click(h.button("New revision"));
  await checkReport(h);
  await h.nav("Test reports");
  await h.click(h.button("Remove run"));
  await h.click(h.button("Confirm removal"));
  assert.equal(h.server.calls.at(-1).kind, "deleteTestRun");
  assert.equal(h.server.calls.at(-1).revision, 8);
  assert.equal(h.server.state.testRuns.length, 0);
  await h.nav("Report");
  await h.click(h.button("Export test reports revision 7"));
  assert.equal(h.window.testPdfExports.at(-1).runId, null, "history exports all runs from its closed snapshot");
  assert.equal(h.window.testPdfExports.at(-1).state.testRuns[0].name, "Reviewed valve test");
  assert.equal(h.window.testPdfExports.at(-1).state.testRuns[0].comment, "Run reviewed before approval");
  assert.equal(h.window.testPdfExports.at(-1).state.testRuns[0].devices[0].comment, "Device wiring verified\nRetest complete");
  assert.equal(h.window.testPdfExports.at(-1).state.project.revision, 7);
  assert.deepEqual(copy(h.window.testPdfExports.at(-1).state.testRuns[0].setupPhotos), [setupPhoto], "Historical export retains setup photos after the live run is removed");
});

test("App preserves a test draft but blocks saving it after another inspector closes and advances the revision", async t => {
  const h = await setup(t);
  h.server.state.testRuns = [testRun()];
  await h.notify();
  await h.nav("Test reports");
  await h.click(h.button("Edit run"));
  h.server.close();
  await h.notify();
  assert.equal(h.button("Save test run").disabled, true);
  assert.match(h.document.querySelector(".test-import-form").textContent, /local preview is retained/);
  h.server.next();
  await h.notify();
  assert.equal(h.button("Save test run").disabled, true, "an old draft is not retargeted to the new revision");
  await h.click(h.button("Save test run"));
  assert.equal(h.server.calls.filter(call => call.kind === "saveTestRun").length, 0);
  await h.click(h.button("Discard changes"));
  await checkReport(h);
  await h.click(h.button("Edit run"));
  await h.click(h.button("Save test run"));
  assert.equal(h.server.calls.at(-1).kind, "saveTestRun");
  assert.equal(h.server.calls.at(-1).revision, 8);
});

test("App exports the current device view range on approved reports even when browser storage fails", async t => {
  const h = await setup(t);
  const start = Date.UTC(2026, 10, 19, 12);
  const run = { ...testRun(), clock: { basis: 'source-local', timeZone: 'Source clock', startMs: start, endMs: start + 60_000 },
    devices: [{ id: 'valve', name: 'VALVE', status: 'Passed', channels: [{ id: 'output', symbolicName: 'Output', status: 'Passed', parameters: [],
      series: [{ id: 'state', name: 'Output state', kind: 'digital',
        points: [5000, 20_000, 50_000].map((offset, index) => ({ timeMs: start + offset, value: index % 2, valid: true })) }] }] }] };
  h.server.state.testRuns = [run];
  await h.notify();
  await h.nav('Report');
  await h.click(h.button('Approve & close'));
  await h.click(h.button('Confirm approval & close'));
  const approved = copy(h.server.state);
  await h.nav('Test reports');
  const range = async (from, to) => {
    await h.fill(h.document.querySelector('input[name="rangeStart"]'), String(start + from));
    await h.fill(h.document.querySelector('input[name="rangeEnd"]'), String(start + to));
    await h.click(h.button('Apply time range'));
  };
  await range(10_000, 40_000);
  assert.equal(h.document.querySelector('.test-comment textarea'), null);
  assert.equal(h.button('Save test run'), undefined);
  await h.click(h.button('Export test PDF'));
  assert.deepEqual(copy(h.window.testPdfExports.at(-1).timeRanges), { [run.id]: { valve: { startMs: start + 10_000, endMs: start + 40_000 } } });
  h.window.Storage.prototype.setItem = () => { throw new Error('Quota exceeded'); };
  h.window.Storage.prototype.removeItem = () => { throw new Error('Storage blocked'); };
  await range(20_000, 30_000);
  assert.match(h.document.querySelector('.test-time-axis').textContent, /could not be saved locally/);
  await h.click(h.button('Export test PDF'));
  assert.deepEqual(copy(h.window.testPdfExports.at(-1).timeRanges), { [run.id]: { valve: { startMs: start + 20_000, endMs: start + 30_000 } } });
  await h.click(h.button('Reset to auto'));
  await h.click(h.button('Export test PDF'));
  assert.deepEqual(copy(h.window.testPdfExports.at(-1).timeRanges), {}, 'an in-memory reset overrides a cache entry that could not be cleared');
  assert.equal(h.server.calls.filter(call => call.kind === 'saveTestRun').length, 0);
  assert.deepEqual(h.server.state, approved, 'view changes and PDF exports cannot alter approved evidence');
});

test("App exports the arranged graph order on approved reports even when browser storage fails", async t => {
  const h = await setup(t);
  const run = graphOrderRun();
  const [command, feedback, position] = deviceGraphEntries(run.devices[0]).map(entry => entry.key);
  h.server.state.testRuns = [run];
  await h.notify();
  await h.nav("Report");
  await h.click(h.button("Approve & close"));
  await h.click(h.button("Confirm approval & close"));
  const approved = copy(h.server.state);
  await h.nav("Test reports");
  const names = () => Array.from(h.document.querySelectorAll(".test-chart figcaption strong"), element => element.textContent);
  await h.click([...h.document.querySelectorAll("summary")].find(element => element.textContent === "Arrange graphs"));
  await h.click(h.button("Move Position up"));
  assert.deepEqual(names(), ["Close command", "Position", "Close feedback"]);
  assert.equal(h.button("Save test run"), undefined);
  await h.click(h.button("Export test PDF"));
  assert.deepEqual(copy(h.window.testPdfExports.at(-1).graphOrders), { [run.id]: { valve: [command, position, feedback] } });
  h.window.Storage.prototype.setItem = () => { throw new Error("Quota exceeded"); };
  h.window.Storage.prototype.removeItem = () => { throw new Error("Storage blocked"); };
  await h.click(h.button("Move Position up"));
  assert.deepEqual(names(), ["Position", "Close command", "Close feedback"]);
  assert.match(h.document.querySelector('[aria-label="Graph order"]').parentElement.textContent, /could not be saved/);
  await h.click(h.button("Export test PDF"));
  assert.deepEqual(copy(h.window.testPdfExports.at(-1).graphOrders), { [run.id]: { valve: [position, command, feedback] } });
  await h.click(h.button("Reset graph order"));
  assert.deepEqual(names(), ["Close command", "Close feedback", "Position"]);
  await h.click(h.button("Export test PDF"));
  assert.deepEqual(copy(h.window.testPdfExports.at(-1).graphOrders), {}, "an in-memory reset overrides a cache entry that could not be cleared");
  assert.equal(h.server.calls.filter(call => call.kind === "saveTestRun").length, 0);
  assert.deepEqual(h.server.state, approved, "arranging and exporting graphs cannot alter approved evidence");
});

test("App carries graph order into the next revision while historical PDF exports retain their own order", async t => {
  const h = await setup(t);
  const run = graphOrderRun();
  const [command, feedback, position] = deviceGraphEntries(run.devices[0]).map(entry => entry.key);
  h.server.state.testRuns = [run];
  await h.notify();
  await h.nav("Test reports");
  await h.click([...h.document.querySelectorAll("summary")].find(element => element.textContent === "Arrange graphs"));
  await h.click(h.button("Move Position up"));
  await h.click(h.button("Move Position up"));
  await h.nav("Report");
  assert.equal(h.button("Approve & close").disabled, false, "a display order does not create an unsaved evidence draft");
  await h.click(h.button("Approve & close"));
  await h.click(h.button("Confirm approval & close"));
  await h.click(h.button("New revision"));
  await h.nav("Test reports");
  const names = () => Array.from(h.document.querySelectorAll(".test-chart figcaption strong"), element => element.textContent);
  assert.deepEqual(names(), ["Position", "Close command", "Close feedback"], "the new revision starts with the saved device arrangement");
  await h.click(h.button("Move Close feedback up"));
  await h.click(h.button("Move Close feedback up"));
  assert.deepEqual(names(), ["Close feedback", "Position", "Close command"]);
  await h.nav("Report");
  await h.click(h.button("Export test reports revision 7"));
  const historical = h.window.testPdfExports.at(-1);
  assert.equal(historical.state.project.revision, 7);
  assert.deepEqual(copy(historical.graphOrders), { [run.id]: { valve: [position, command, feedback] } });
  assert.equal(h.server.state.project.revision, 8);
  assert.equal(h.server.calls.filter(call => call.kind === "saveTestRun").length, 0);
  assert.deepEqual(h.server.state.testRuns[0].devices, run.devices, "arrangements never reorder the stored source channels");
});
