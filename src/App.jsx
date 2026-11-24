import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import schedule from "./data/schedule.json";
import { createBackend, validateBackendConfig } from "./backend.js";
import { readConfig, saveConfig } from "./config.js";
import { recordKey, groupDevices, findManualDevices, inspectionTargets, revisionNumber } from "./domain.js";
import {
  photosFor,
  commentsFor,
  recordStatus,
  terminalProgress,
  inspectionProgress,
} from "./inspection.js";
import { normalizePhoto } from "./photos.js";
import CameraDialog from "./CameraDialog.jsx";
import BulkPhotoDialog from "./BulkPhotoDialog.jsx";
import Icon from "./Icons.jsx";
import OverviewTable from "./OverviewTable.jsx";
import CommentPanel from "./CommentPanel.jsx";
import QualityControl from "./QualityControl.jsx";
import RevisionPanel, { CheckedByForm } from "./RevisionPanel.jsx";
import TestReportsPanel from "./TestReportsPanel.jsx";
import PhotoGallery from "./PhotoGallery.jsx";
import { testTimeRangeScope, readTestTimeRanges, inheritTestTimeRanges } from "./test-time-ranges.js";
import { testGraphOrderScope, readTestGraphOrders, inheritTestGraphOrders } from "./test-graph-order.js";

const EMPTY = { records: [], photos: [], comments: [], testRuns: [], inspector: null };
const TARGETS = inspectionTargets(schedule);
const TITLES = {
  layout: "Conduit layout",
  devices: "QC overview",
  report: "Inspection report",
  tests: "Test reports",
  workspace: "Shared workspace",
};
const STATUS = {
  complete: "Complete",
  "in-progress": "In progress",
  "not-started": "Not started",
};
const asset = (name) => `${import.meta.env.BASE_URL}assets/${name}`;
const selectionKey = (config) => `jeevy-qa-skid:${config.url}`;
const reportViewKey = (config) => `jeevy-qa-report-view:${config.url}`;
function rememberedReportView(config) {
  try {
    const view = localStorage.getItem(reportViewKey(config));
    if (view === "report" || view === "tests") return view;
  } catch { /* A blocked browser store does not prevent navigation. */ }
  return "layout";
}
function rememberedSkid(config) {
  try {
    const id = localStorage.getItem(selectionKey(config));
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      id || "",
    )
      ? id
      : null;
  } catch {
    return null;
  }
}
function rememberSkid(config, id) {
  try {
    if (id) localStorage.setItem(selectionKey(config), id);
    else localStorage.removeItem(selectionKey(config));
  } catch {
    /* A blocked browser store does not prevent shared inspection. */
  }
}
const date = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";

function Modal({ title, children, onClose, className = "", initialFocus }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current.showModal();
    if (initialFocus) ref.current.querySelector(initialFocus)?.focus();
    return () => {
      ref.current?.close();
      previous?.focus?.();
    };
  }, [initialFocus]);
  return createPortal(
    <dialog
      ref={ref}
      className={`modal ${className}`}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="modal-header">
        <h2>{title}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      {children}
    </dialog>,
    document.body,
  );
}

function Status({ value, connected = true }) {
  return (
    <span className={`status ${connected ? value : "preview"}`}>
      {value === "complete" && connected ? (
        <Icon name="check" size={13} />
      ) : (
        <span className="status-dot" />
      )}
      {connected ? STATUS[value] : "Preview"}
    </span>
  );
}

function App() {
  const [config, setConfig] = useState(readConfig);
  const [view, setView] = useState(() => rememberedReportView(config));
  const [group, setGroup] = useState(null);
  const [state, setState] = useState(EMPTY);
  const [workspace, setWorkspace] = useState({
    inspector: null,
    walkdowns: [],
  });
  const [selectedId, setSelectedId] = useState(() =>
    rememberedSkid(readConfig()),
  );
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const [skidDialog, setSkidDialog] = useState(null);
  const skidEditScope = useRef(null);
  const [pending, setPending] = useState(0);
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  const [record, setRecord] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [testDraftDirty, setTestDraftDirty] = useState(false);
  const [timeRangeChanges, setTimeRangeChanges] = useState({});
  const changeTimeRange = useCallback((scope, runId, deviceId, range) => {
    if (!scope || !runId) return;
    setTimeRangeChanges(previous => ({ ...previous, [scope]: { ...previous[scope],
      [runId]: { ...previous[scope]?.[runId], [deviceId]: range } } }));
  }, []);
  const [graphOrderChanges, setGraphOrderChanges] = useState({});
  const changeGraphOrder = useCallback((scope, runId, deviceId, order) => {
    if (!scope || !runId) return;
    setGraphOrderChanges(previous => ({ ...previous, [scope]: { ...previous[scope],
      [runId]: { ...previous[scope]?.[runId], [deviceId]: order === null ? null : [...order] } } }));
  }, []);
  const [camera, setCamera] = useState(null);
  const [manualEntry, setManualEntry] = useState(false);
  const [bulkUpload, setBulkUpload] = useState(null);
  const [search, setSearch] = useState("");
  const [filterGroup, setFilterGroup] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [reporting, setReporting] = useState("");
  const [lastSync, setLastSync] = useState(null);
  const request = useRef(0);
  const workspaceRequest = useRef(0);
  const workspaceBackend = useMemo(() => {
    try {
      return createBackend(config);
    } catch {
      return null;
    }
  }, [config]);
  const backend = useMemo(
    () => selectedId && workspaceBackend?.forWalkdown(selectedId),
    [workspaceBackend, selectedId],
  );
  const signedIn = Boolean(workspace.inspector);
  const activeBackend = useRef(null);
  activeBackend.current = signedIn ? backend : null;
  const inspector = workspace.inspector || state.inspector;
  const selectedSkid = workspace.walkdowns.find(
    (item) => item.id === selectedId,
  );
  const connected = Boolean(
    state.inspector &&
    state.project?.walkdownId === selectedId &&
    !state.project?.nameRequired,
  );
  const switchBlocked = Boolean(
    pending || reporting || camera || record || manualEntry || bulkUpload || testDraftDirty,
  );
  const reportRevision = state.project?.revision ?? selectedSkid?.revision ?? 1;
  const displayedRevision = revisionNumber(state.project ?? selectedSkid, reportRevision);
  const revisionStatus = state.project?.status;
  const draftOpen = connected && revisionStatus === "draft";
  const checkerRequired = draftOpen && !state.project.checkedByName?.trim();
  const editable = draftOpen && !checkerRequired;
  const writeBackend = useMemo(
    () => backend && Number.isSafeInteger(reportRevision) && reportRevision > 0
      ? backend.forRevision(reportRevision) : null,
    [backend, reportRevision],
  );
  const activeEditor = useRef(null);
  activeEditor.current = editable ? writeBackend : null;
  const activeDraft = useRef(null);
  activeDraft.current = draftOpen ? writeBackend : null;
  const checkerSaving = useRef(false);
  const transitionRef = useRef(false);
  const exportingRef = useRef(false);
  const draftPrefix = `${selectedId}:${reportRevision}:`;
  const hasDraftComments = Object.entries(drafts)
    .some(([key, value]) => key.startsWith(draftPrefix) && value.trim());
  const totals = inspectionProgress(schedule.devices, schedule.groups, state, schedule.equipment);
  const completedTargets = totals.devices + totals.terminals + totals.equipment;

  const loadWorkspace = useCallback(async () => {
    if (!workspaceBackend) return;
    const version = ++workspaceRequest.current;
    const loaded = await workspaceBackend.listWalkdowns();
    if (workspaceRequest.current !== version) return;
    setWorkspace(loaded);
    const current = selectedIdRef.current;
    const next =
      loaded.walkdowns.find((item) => item.id === current)?.id ||
      loaded.walkdowns[0]?.id ||
      null;
    if (next !== current) {
      ++request.current;
      selectedIdRef.current = next;
      setSelectedId(next);
      setState(EMPTY);
      setRecord(null);
      setCamera(null);
      setBulkUpload(null);
    }
    rememberSkid(config, next);
    return loaded;
  }, [workspaceBackend, config]);

  const refresh = useCallback(async () => {
    if (!backend || activeBackend.current !== backend) return;
    const version = ++request.current;
    setLoading(true);
    try {
      const loaded = await backend.loadState();
      if (
        activeBackend.current === backend &&
        request.current === version &&
        selectedIdRef.current === backend.walkdownId
      ) {
        inheritTestTimeRanges(config.url, loaded);
        inheritTestGraphOrders(config.url, loaded);
        setState(loaded);
        setWorkspace((previous) => ({
          ...previous,
          walkdowns: previous.walkdowns.map((item) =>
            item.id === backend.walkdownId
              ? {
                  ...item,
                  skidName: loaded.project.skidName,
                  revision: loaded.project.revision,
                  revisionNumberBase: loaded.project.revisionNumberBase,
                  status: loaded.project.status,
                  contentVersion: loaded.project.contentVersion,
                  nameRequired: loaded.project.nameRequired,
                  updatedAt: loaded.project.updatedAt,
                }
              : item,
          ),
        }));
        setLastSync(new Date());
        setError("");
      }
      return loaded;
    } catch (e) {
      if (request.current === version) setError(e.message);
      throw e;
    } finally {
      if (request.current === version) setLoading(false);
    }
  }, [backend, config.url]);

  useEffect(() => {
    let disposed = false;
    setChecking(true);
    ++workspaceRequest.current;
    ++request.current;
    const remembered = rememberedSkid(config);
    selectedIdRef.current = remembered;
    setSelectedId(remembered);
    setWorkspace({ inspector: null, walkdowns: [] });
    setState(EMPTY);
    setSession(null);
    setRecord(null);
    setCamera(null);
    setBulkUpload(null);
    setDrafts({});
    if (!workspaceBackend) {
      setChecking(false);
      return;
    }
    workspaceBackend
      .getSession()
      .then(async (value) => {
        if (disposed) return;
        setSession(value);
        if (value?.user) await loadWorkspace();
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      })
      .finally(() => {
        if (!disposed) setChecking(false);
      });
    return () => {
      disposed = true;
      ++request.current;
      ++workspaceRequest.current;
    };
  }, [workspaceBackend, loadWorkspace, config]);

  useEffect(() => {
    ++request.current;
    setState(EMPTY);
    setManualEntry(false);
    setBulkUpload(null);
    if (signedIn && backend) refresh().catch(() => {});
  }, [backend, signedIn, refresh]);

  useEffect(() => {
    if (!workspaceBackend || !signedIn) return;
    let active = true;
    const unsubscribe = workspaceBackend.subscribeWalkdowns(async () => {
      try {
        const currentSession = await workspaceBackend.getSession();
        if (!active) return;
        setSession(currentSession);
        if (!currentSession?.user) {
          ++request.current;
          ++workspaceRequest.current;
          setWorkspace({ inspector: null, walkdowns: [] });
          setState(EMPTY);
          setRecord(null);
          setCamera(null);
          setBulkUpload(null);
          setDrafts({});
          return;
        }
        await loadWorkspace();
      } catch (e) {
        if (active) setError(e.message);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [workspaceBackend, signedIn, loadWorkspace]);

  useEffect(() => {
    if (!signedIn || !backend) return;
    const reload = () => {
      if (document.visibilityState === "visible") refresh().catch(() => {});
    };
    const unsubscribe = backend.subscribe(reload);
    const timer = setInterval(reload, 30000);
    window.addEventListener("focus", reload);
    window.addEventListener("online", reload);
    return () => {
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener("focus", reload);
      window.removeEventListener("online", reload);
    };
  }, [backend, signedIn, refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  function navigate(next, terminal = null) {
    setView(next);
    try {
      if (next === "report" || next === "tests") localStorage.setItem(reportViewKey(config), next);
      else localStorage.removeItem(reportViewKey(config));
    } catch { /* The page still opens when browser storage is unavailable. */ }
    setGroup(terminal);
    setSearch("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function chooseSkid(id) {
    if (switchBlocked) return;
    ++request.current;
    selectedIdRef.current = id;
    setSelectedId(id);
    rememberSkid(config, id);
    setState(EMPTY);
    setRecord(null);
    setCamera(null);
    setBulkUpload(null);
    setError("");
    setGroup(null);
  }
  function draftFor(key) {
    return drafts[`${draftPrefix}${key}`] || "";
  }
  function updateDraft(key, value) {
    if (!editable || activeEditor.current !== writeBackend) return;
    const scopedKey = `${draftPrefix}${key}`;
    setDrafts((previous) => ({
      ...previous,
      [scopedKey]:
        typeof value === "function" ? value(previous[scopedKey] || "") : value,
    }));
  }
  function openSkidDialog(mode) {
    skidEditScope.current = { mode, id: selectedId, revision: reportRevision };
    setSkidDialog(mode);
  }
  async function saveSkid(name) {
    const scope = skidEditScope.current;
    if (!scope) throw new Error("Reopen the skid name dialog and try again.");
    if (scope.mode !== "new" && (scope.id !== selectedIdRef.current || scope.revision !== reportRevision))
      throw new Error("This report revision changed. Close this dialog and review the current report before renaming it.");
    const saved =
      scope.mode === "new"
        ? await workspaceBackend.createWalkdown(name)
        : await workspaceBackend.renameWalkdown(scope.id, name, scope.revision);
    await loadWorkspace();
    if (saved.id !== selectedId) chooseSkid(saved.id);
    setSkidDialog(null);
    if (saved.id === selectedId) await refresh();
    setNotice(skidDialog === "new" ? "Skid report created" : "Skid name saved");
  }
  async function signOut() {
    if (testDraftDirty) {
      setError("Save or discard your test run changes before signing out.");
      navigate("tests");
      return;
    }
    try {
      await workspaceBackend.signOut();
      ++request.current;
      ++workspaceRequest.current;
      setSession(null);
      setWorkspace({ inspector: null, walkdowns: [] });
      setState(EMPTY);
      setRecord(null);
      setCamera(null);
      setBulkUpload(null);
      setDrafts({});
      setNotice("Signed out. Shared evidence is retained.");
    } catch (e) {
      setError(e.message);
    }
  }
  async function mutate(operation, message = "Saved to the shared workspace") {
    if (!connected)
      throw new Error(
        "Choose a named skid report before adding inspection evidence.",
      );
    if (checkerRequired)
      throw new Error("Save Checked by before adding or changing inspection evidence. Your pending work is retained.");
    if (!editable || activeEditor.current !== writeBackend)
      throw new Error("This revision is closed or has changed. Open Report and start a new revision to continue editing.");
    setPending((count) => count + 1);
    try {
      const result = await operation();
      // A committed save stays successful even if its following refresh fails.
      await refresh().catch(() => setError("Your change was saved, but the report could not refresh. Reconnect and refresh to see the latest evidence."));
      setNotice(message);
      return result;
    } catch (e) {
      setError(e.message);
      refresh().catch(() => {});
      throw e;
    } finally {
      setPending((count) => count - 1);
    }
  }
  function openRecord(kind, id) {
    const item = TARGETS.find((target) => target.kind === kind && target.id === id);
    if (!item) throw new Error("Choose an item from the inspection schedule.");
    const target = { ...item, title: item.name };
    setRecord(target);
    return target;
  }
  function scan(terminal = null) {
    if (!readyToDocument()) return;
    openCamera(null, terminal);
  }
  function openCamera(target, terminal) {
    if (!readyToDocument()) return;
    setCamera({ target, terminal, backend: writeBackend, revision: reportRevision });
  }
  function readyToDocument() {
    if (editable) return true;
    if (!signedIn) setAuthOpen(true);
    else if (checkerRequired) {
      setError("Save Checked by before entering inspection or test data.");
      document.getElementById("checked-by-name")?.focus();
    }
    else if (connected) {
      setError("This revision is locked. Open Report and choose New revision to continue editing.");
      navigate("report");
    }
    else setError("Create or name a skid report before documenting devices.");
    return false;
  }
  function enterDeviceName() {
    if (!readyToDocument()) return;
    setCamera(null);
    setRecord(null);
    setManualEntry(true);
  }
  function startBulkUpload() {
    if (!readyToDocument()) return;
    setCamera(null);
    setRecord(null);
    setManualEntry(false);
    setBulkUpload({ backend: writeBackend, walkdownId: selectedId, skidName: state.project.skidName, revision: reportRevision });
  }
  async function saveBulkPhoto(key, photo) {
    const scope = bulkUpload;
    if (checkerRequired) throw new Error("Save Checked by before uploading evidence. Your selected photos are retained.");
    if (!scope || activeEditor.current !== scope.backend || selectedIdRef.current !== scope.walkdownId)
      throw new Error("This report revision is closed or no longer active. Start a new revision before uploading more evidence.");
    setPending((count) => count + 1);
    try {
      const saved = await scope.backend.addPhoto(key, photo);
      if (activeEditor.current === scope.backend) {
        // A failed refresh must not turn a successful save into a retry/duplicate.
        refresh().catch(() => {
          if (activeEditor.current === scope.backend)
            setError("Your photo was saved, but the report could not refresh. Reconnect and refresh to see the latest evidence.");
        });
      }
      return saved;
    } finally {
      setPending((count) => count - 1);
    }
  }
  function startDeviceEvidence(deviceId) {
    const device = schedule.devices.find((item) => item.id === deviceId);
    if (!device || !readyToDocument()) return;
    const target = openRecord("device", deviceId);
    setManualEntry(false);
    openCamera(target, device.terminal);
  }
  async function changeRevision(action, review) {
    if (!connected || transitionRef.current || pending || reporting) return;
    if (review.walkdownId && review.walkdownId !== selectedId)
      throw new Error("Select the report you reviewed before approving.");
    if (action === "approve" && !state.project.checkedByName?.trim())
      throw new Error("Save Checked by before approving this revision.");
    if (action === "approve" && hasDraftComments)
      throw new Error("Post or clear your draft comments before approving this revision.");
    if (action === "approve" && testDraftDirty)
      throw new Error("Save or discard your test run changes before approving this revision.");
    const scope = backend.forRevision(review.revision);
    transitionRef.current = true;
    setPending((count) => count + 1);
    setError("");
    try {
      const saved = action === "approve"
        ? await scope.approveRevision(review.contentVersion)
        : await scope.newRevision();
      if (activeBackend.current === backend && selectedIdRef.current === backend.walkdownId) {
        ++request.current;
        inheritTestTimeRanges(config.url, saved);
        inheritTestGraphOrders(config.url, saved);
        setState(saved);
        setLoading(false);
        setLastSync(new Date());
        setNotice(action === "approve"
          ? `Revision ${revisionNumber(saved.project)} approved and closed`
          : `Revision ${revisionNumber(saved.project)} created. Save Checked by before entering data.`);
        loadWorkspace().catch(() => {});
      }
    } catch (e) {
      setError(e.message);
      refresh().catch(() => {});
      throw e;
    } finally {
      transitionRef.current = false;
      setPending((count) => count - 1);
    }
  }

  async function saveCheckedBy(name, expectedName, expectedRevision, walkdownId) {
    const scope = writeBackend;
    if (!draftOpen || !scope || activeBackend.current !== backend || activeDraft.current !== scope || expectedRevision !== reportRevision
      || walkdownId !== selectedIdRef.current || walkdownId !== scope.walkdownId)
      throw new Error("This draft changed. Reopen the current report before saving Checked by.");
    if (checkerSaving.current || transitionRef.current || pending || reporting)
      throw new Error("Wait for the current save to finish, then save Checked by.");
    const trimmed = name.trim();
    if (!trimmed || Array.from(trimmed).length > 120 || /[\u0000-\u001f\u007f-\u009f]/u.test(trimmed))
      throw new Error("Enter a name of 1–120 characters without control characters.");
    checkerSaving.current = true;
    setPending(count => count + 1); setError("");
    try {
      const saved = await scope.setCheckedBy(trimmed, expectedName);
      if (activeDraft.current === scope && activeBackend.current === backend && selectedIdRef.current === walkdownId) {
        ++request.current;
        setState(saved); setLoading(false); setLastSync(new Date());
        setNotice("Checked by saved.");
      }
      return saved;
    } catch (failure) {
      if (activeBackend.current === backend && selectedIdRef.current === walkdownId) {
        setError(failure.message);
        await refresh().catch(() => {});
      }
      throw failure;
    } finally {
      checkerSaving.current = false;
      setPending(count => count - 1);
    }
  }
  async function exportReport(revision = reportRevision, kind = "qc", runId = null) {
    if (!connected || exportingRef.current) return;
    exportingRef.current = true;
    setReporting("Preparing your report…");
    setError("");
    try {
      const snapshot = await backend.loadRevision(revision);
      const { createInspectionPdf, approvedReportDate } = await import("./report.js");
      const generatedAt = approvedReportDate(snapshot);
      const rangeScope = testTimeRangeScope(config.url, inspector?.id, snapshot.project.walkdownId, snapshot.project.revision);
      const orderScope = testGraphOrderScope(config.url, inspector?.id, snapshot.project.walkdownId, snapshot.project.revision);
      const blob = kind === "tests"
        ? await (await import("./test-report.js")).createTestReportPdf({
          state: snapshot, runId, backend, onProgress: setReporting,
          timeRanges: readTestTimeRanges(rangeScope, snapshot.testRuns || [], timeRangeChanges[rangeScope]),
          graphOrders: readTestGraphOrders(orderScope, snapshot.testRuns || [], graphOrderChanges[orderScope]),
        })
        : await createInspectionPdf({
          schedule, state: snapshot, backend, onProgress: setReporting,
        });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      const skidFilename = snapshot.project.skidName
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
        .replace(/[. ]+$/g, "");
      const reportName = kind === "tests" ? "DCS-IO-Test-Report" : "DCS-QC-Report";
      anchor.download = `450k-Skid-x7-${skidFilename}-${reportName}-Rev${revisionNumber(snapshot.project)}-${generatedAt.toISOString().slice(0, 10)}.pdf`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setNotice(`Approved revision ${revisionNumber(snapshot.project)} exported`);
    } catch (e) {
      setError(e.message);
    } finally {
      exportingRef.current = false;
      setReporting("");
    }
  }
  const exportTestReport = (revision = reportRevision, runId = null) => exportReport(revision, "tests", runId);

  async function saveTestRun(run, expectedRevision) {
    if (checkerRequired) throw new Error("Save Checked by to resume this test run. Your pending changes are retained.");
    if (expectedRevision !== reportRevision || activeEditor.current !== writeBackend)
      throw new Error("This test import belongs to an earlier revision. Reopen it in the current draft.");
    return mutate(() => writeBackend.saveTestRun(run), "Test run saved to this revision");
  }

  async function deleteTestRun(run, expectedRevision) {
    if (checkerRequired) throw new Error("Save Checked by before changing test reports.");
    if (expectedRevision !== reportRevision || activeEditor.current !== writeBackend)
      throw new Error("This report revision changed. Refresh before removing a test run.");
    return mutate(() => writeBackend.deleteTestRun(run.id, run.runVersion), "Test run removed from this draft");
  }

  function setupPhotoScope(run, expectedRevision) {
    if (checkerRequired) throw new Error("Save Checked by before changing test setup photos.");
    if (!writeBackend || expectedRevision !== reportRevision || activeEditor.current !== writeBackend
      || (run.walkdownId && run.walkdownId !== selectedId))
      throw new Error("This setup belongs to an earlier report revision. Reopen the current draft before editing photos.");
    return writeBackend;
  }

  function updateSetupPhotos(runId, expectedRevision, walkdownId, update) {
    setState(previous => previous.project?.walkdownId === walkdownId
      && previous.project.revision === expectedRevision && previous.project.status === "draft"
      ? { ...previous, testRuns: (previous.testRuns || []).map(run => run.id === runId
        ? { ...run, setupPhotos: update(run.setupPhotos || []) } : run) }
      : previous);
  }

  async function addTestSetupPhoto(run, photo, expectedRevision) {
    const scope = setupPhotoScope(run, expectedRevision);
    return mutate(async () => {
      const saved = await scope.addTestSetupPhoto(run.id, photo);
      updateSetupPhotos(run.id, expectedRevision, scope.walkdownId,
        photos => [...photos.filter(item => item.id !== saved.id), saved]);
      return saved;
    }, "Setup photo saved to this revision");
  }

  async function updateTestSetupPhoto(run, photo, caption, expectedRevision) {
    const scope = setupPhotoScope(run, expectedRevision);
    return mutate(async () => {
      const saved = await scope.updateTestSetupPhoto(run.id, photo.id, caption);
      updateSetupPhotos(run.id, expectedRevision, scope.walkdownId,
        photos => photos.map(item => item.id === saved.id ? saved : item));
      return saved;
    }, "Setup photo caption saved");
  }

  async function deleteTestSetupPhoto(run, photo, expectedRevision) {
    const scope = setupPhotoScope(run, expectedRevision);
    return mutate(async () => {
      await scope.deleteTestSetupPhoto(run.id, photo.id);
      updateSetupPhotos(run.id, expectedRevision, scope.walkdownId,
        photos => photos.filter(item => item.id !== photo.id));
    }, "Setup photo removed from this draft");
  }

  async function reorderTestSetupPhotos(run, orderedIds, expectedIds, expectedRevision) {
    const scope = setupPhotoScope(run, expectedRevision);
    return mutate(async () => {
      const saved = await scope.reorderTestSetupPhotos(run.id, orderedIds, expectedIds);
      updateSetupPhotos(run.id, expectedRevision, scope.walkdownId, () => saved);
      return saved;
    }, "Setup photo order saved");
  }

  async function reorderInspectionPhotos(key, orderedIds, expectedIds, expectedRevision) {
    const scope = writeBackend;
    if (!scope || activeEditor.current !== scope || expectedRevision !== reportRevision)
      throw new Error("This photo order belongs to an earlier revision. Reopen the current draft.");
    return mutate(async () => {
      const saved = await scope.reorderPhotos(key, orderedIds, expectedIds);
      setState(previous => previous.project?.walkdownId === scope.walkdownId && previous.project.revision === expectedRevision
        && previous.project.status === 'draft' ? { ...previous,
          photos: [...previous.photos.filter(photo => photo.recordKey !== key), ...saved] } : previous);
      return saved;
    }, "Evidence photo order saved");
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          href="#layout"
          onClick={(e) => {
            e.preventDefault();
            navigate("layout");
          }}
          className="brand"
          aria-label="Jeevy QC home"
        >
          <img src={asset("jeevy-logo.png")} alt="Jeevy Fabrication" />
          <span>FIELD QC</span>
        </a>
        <div className="project-tag">
          <span className="eyebrow">CURRENT SKID REPORT</span>
          <strong>{selectedSkid?.skidName || "450k Skid x7"}</strong>
          <span>
            {connected ? `QC Revision ${displayedRevision}` : "DCS · Field QC"}
          </span>
        </div>
        <nav aria-label="Main navigation">
          {[
            ["layout", "layout", "Conduit layout"],
            ["devices", "device", "QC overview"],
            ["tests", "equipment", "Test reports"],
            ["report", "report", "Report"],
            ["workspace", "settings", "Workspace"],
          ].map(([id, icon, label]) => (
            <button
              key={id}
              className={view === id ? "nav-link active" : "nav-link"}
              onClick={() => navigate(id)}
            >
              <Icon name={icon} />
              <span>{label}</span>
              {id === "devices" && (
                <small>
                  {TARGETS.length}
                </small>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="shared-indicator">
            <Icon name="cloud" />
            <span>{signedIn ? "Shared workspace" : "Workspace preview"}</span>
          </div>
          <button
            className="inspector-chip"
            onClick={() =>
              signedIn ? navigate("workspace") : setAuthOpen(true)
            }
          >
            <span className="avatar">
              {signedIn ? (
                (inspector.name || inspector.email || "Q")
                  .slice(0, 1)
                  .toUpperCase()
              ) : (
                <Icon name="user" size={17} />
              )}
            </span>
            <span>
              <strong>
                {signedIn
                  ? inspector.name || inspector.email.split("@")[0]
                  : "Inspector sign-in"}
              </strong>
              <small>{signedIn ? inspector.email : "Connect to begin"}</small>
            </span>
            <Icon name="arrow" size={15} />
          </button>
        </div>
      </aside>

      <div className="workspace-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>QUALITY CONTROL</span>
            <i>/</i>
            <span>450K SKID X7</span>
          </div>
          <div className="topbar-actions">
            <span className={`sync-label ${signedIn ? "online" : ""}`}>
              <span />
              {checking
                ? "Connecting…"
                : loading
                  ? "Syncing…"
                  : pending
                    ? "Saving…"
                    : testDraftDirty
                      ? "Unsaved test changes"
                      : signedIn
                        ? "All changes shared"
                        : "Not signed in"}
            </span>
            {signedIn ? (
              <button
                className="icon-button"
                aria-label="Refresh shared inspection"
                onClick={() =>
                  Promise.all([
                    loadWorkspace(),
                    backend ? refresh() : Promise.resolve(),
                  ]).catch((e) => setError(e.message))
                }
                disabled={loading}
              >
                <Icon name="refresh" size={17} />
              </button>
            ) : (
              <button
                className="small-button"
                onClick={() => setAuthOpen(true)}
              >
                Sign in
              </button>
            )}
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <span className="eyebrow">450K SKID X7 · DCS</span>
              <h1>
                {group && view === "layout"
                  ? `Terminal ${group}`
                  : TITLES[view]}
              </h1>
            </div>
            <div className="heading-actions">
              {["layout", "devices"].includes(view) && (!connected || editable) && (
                <>
                  <button
                    className="button primary"
                    onClick={() => scan(group)}
                  >
                    <Icon name="scan" />
                    Scan device label
                  </button>
                  <button
                    className="button secondary"
                    onClick={enterDeviceName}
                  >
                    <Icon name="search" />
                    Enter device name
                  </button>
                </>
              )}
              {["layout", "devices", "report"].includes(view) && (!connected || editable) && (
                <button className="button secondary" onClick={startBulkUpload}>
                  <Icon name="upload" />
                  Bulk upload photos
                </button>
              )}
              {view === "report" && (
                <button
                  className="button primary"
                  disabled={!connected || revisionStatus !== "closed" || pending > 0 || Boolean(reporting)}
                  onClick={() => exportReport()}
                >
                  <Icon name="download" />
                  {reporting ? "Exporting…" : "Export PDF"}
                </button>
              )}
            </div>
          </div>

          {error && (
            <div className="message error" role="alert">
              <Icon name="info" />
              <div>
                <strong>We couldn’t complete that action</strong>
                <p>{error}</p>
              </div>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <Icon name="close" size={17} />
              </button>
            </div>
          )}
          {!signedIn && !checking && view !== "workspace" && (
            <div className="message preview-message">
              <Icon name="cloud" />
              <div>
                <strong>
                  {session?.user
                    ? "Finish connecting your inspector account"
                    : "You’re viewing the project layout"}
                </strong>
                <p>
                  {session?.user
                    ? "Your account is signed in, but the shared inspection could not be loaded. Check your inspector access or retry."
                    : "Sign in to document a skid."}
                </p>
              </div>
              <button
                className="small-button"
                onClick={() =>
                  session?.user
                    ? loadWorkspace().catch((e) => setError(e.message))
                    : setAuthOpen(true)
                }
              >
                {session?.user ? "Retry" : "Sign in"}
              </button>
            </div>
          )}

          {signedIn && (
            <section
              className="skid-picker card"
              aria-label="Skid report selection"
            >
              <label htmlFor="skid-report">
                <span className="eyebrow">SKID REPORT</span>
                <select
                  id="skid-report"
                  value={selectedId || ""}
                  disabled={switchBlocked || loading}
                  onChange={(event) => chooseSkid(event.target.value)}
                >
                  {!workspace.walkdowns.length && (
                    <option value="">Choose a skid report</option>
                  )}
                  {workspace.walkdowns.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.skidName}
                      {item.nameRequired ? " — name required" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className="skid-picker-actions">
                <button
                  className="small-button"
                  disabled={!selectedSkid || switchBlocked || loading || (!selectedSkid.nameRequired && !draftOpen)}
                  onClick={() => openSkidDialog("rename")}
                >
                  Rename skid
                </button>
                <button
                  className="small-button green"
                  disabled={switchBlocked || loading}
                  onClick={() => openSkidDialog("new")}
                >
                  New skid report
                </button>
              </div>
            </section>
          )}

          {checkerRequired && <section className="card checked-by-required" aria-label="Checked by required">
            <span className="eyebrow">BEFORE DATA ENTRY</span>
            <h2>Add the checker’s name</h2>
            <p>Save Checked by to add or change inspection and test evidence in this revision. You can keep viewing the report and its history.</p>
            <CheckedByForm key={`${selectedId}:${reportRevision}`} project={state.project}
              pending={pending > 0 || Boolean(reporting)} onSave={saveCheckedBy} />
          </section>}

          {connected && revisionStatus === "closed" && view !== "report" && view !== "workspace" && (
            <div className="message revision-locked-notice">
              <Icon name="check" />
              <div><strong>Revision {displayedRevision} is approved and closed</strong><p>Open Report to export this revision or start a new one.</p></div>
              <button className="small-button" onClick={() => navigate("report")}>Open report</button>
            </div>
          )}

          {signedIn && !connected && view !== "workspace" && (
            <section className="card skid-empty">
              <Icon name="report" size={32} />
              <h2>
                {loading
                  ? "Loading skid report…"
                  : selectedSkid?.nameRequired
                    ? "Name this skid before starting QC"
                    : selectedSkid
                      ? "Load this skid report to continue"
                      : "Create a report for your skid"}
              </h2>
              {selectedSkid && (
                <p>
                  {selectedSkid.nameRequired
                    ? "Name the existing inspection to continue."
                    : "Unable to load this skid. Retry."}
                </p>
              )}
              {!loading && (
                <button
                  className="button primary"
                  onClick={() =>
                    selectedSkid && !selectedSkid.nameRequired
                      ? refresh().catch(() => {})
                      : openSkidDialog(
                          selectedSkid?.nameRequired ? "rename" : "new",
                        )
                  }
                >
                  {selectedSkid?.nameRequired
                    ? "Name this skid"
                    : selectedSkid
                      ? "Retry loading report"
                      : "New skid report"}
                </button>
              )}
            </section>
          )}

          {(connected || !signedIn) && view === "layout" && !group && (
            <>
              <section className="stats-strip" aria-label="Inspection progress">
                <Stat
                  value={
                    connected
                      ? `${totals.devices}/${schedule.devices.length}`
                      : schedule.devices.length
                  }
                  label={connected ? "Devices complete" : "Devices to inspect"}
                  icon="device"
                />
                <Stat
                  value={connected ? `${totals.terminals}/${schedule.groups.length}` : schedule.groups.length}
                  label={connected ? "Terminals complete" : "Terminal groups"}
                  icon="layout"
                />
                <Stat
                  value={connected ? `${totals.equipment}/${schedule.equipment.length}` : schedule.equipment.length}
                  label={connected ? "Equipment complete" : "Equipment to inspect"}
                  icon="equipment"
                />
                <div className="overall-progress">
                  <div>
                    <span>Overall inspection</span>
                    <strong>
                      {connected
                        ? `${Math.round((completedTargets / TARGETS.length) * 100)}%`
                        : "Preview"}
                    </strong>
                  </div>
                  <progress
                    aria-label="Overall inspection completion"
                    max={TARGETS.length}
                    value={connected ? completedTargets : 0}
                  />
                </div>
              </section>
              <section className="card map-card">
                <div className="card-heading">
                  <div>
                    <span className="eyebrow">INSPECTION MAP</span>
                    <h2>Conduit layout</h2>
                  </div>
                </div>
                <div className="map-scroll">
                  <div className="map-stage">
                    <img
                      src={asset("conduit-layout.png")}
                      alt="DCS conduit layout with terminal locations A through H, Control Box, Solenoids Box, and Transducer Panel"
                    />
                    {schedule.groups.map((g) => {
                      const p = terminalProgress(g.id, schedule.devices, state);
                      return (
                        <button
                          key={g.id}
                          aria-label={`Open terminal ${g.id}${connected && p.done ? ", complete" : ""}`}
                          className={`map-pin ${connected && p.done ? "done" : ""}`}
                          style={{
                            left: `${g.hotspot.x}%`,
                            top: `${g.hotspot.y}%`,
                          }}
                          onClick={() => navigate("layout", g.id)}
                        >
                          <span>{g.id}</span>
                          {connected && p.done && (
                            <Icon name="check" size={11} />
                          )}
                        </button>
                      );
                    })}
                    {schedule.equipment.map((item) => {
                      const status = recordStatus(recordKey("equipment", item.id), state);
                      return (
                        <button
                          key={item.id}
                          aria-label={`Open ${item.name}${connected && status === "complete" ? ", complete" : ""}`}
                          className={`map-pin map-equipment ${connected ? status : ""} ${connected && status === "complete" ? "done" : ""}`}
                          style={{ left: `${item.hotspot.x}%`, top: `${item.hotspot.y}%` }}
                          onClick={() => openRecord("equipment", item.id)}
                        >
                          <span>{item.name}</span>
                          {connected && status === "complete" && <Icon name="check" size={11} />}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="map-footer">
                  <div className="legend">
                    <span>
                      <i className="empty" />
                      Not started
                    </span>
                    <span>
                      <i className="started" />
                      In progress
                    </span>
                    <span>
                      <i className="finished" />
                      Complete
                    </span>
                  </div>
                </div>
              </section>
              <div className="section-heading">
                <h2>Equipment</h2>
              </div>
              <div className="equipment-grid">
                {schedule.equipment.map((item) => (
                  <EquipmentCard
                    key={item.id} item={item} state={state} connected={connected}
                    onClick={() => openRecord("equipment", item.id)}
                  />
                ))}
              </div>
              <div className="section-heading">
                <h2>Terminal groups</h2>
                <span>
                  {schedule.groups.length} groups · {schedule.devices.length}{" "}
                  devices
                </span>
              </div>
              <div className="terminal-grid">
                {schedule.groups.map((g) => (
                  <TerminalCard
                    key={g.id}
                    group={g}
                    state={state}
                    connected={connected}
                    onClick={() => navigate("layout", g.id)}
                  />
                ))}
              </div>
              <section className="card general-comments-card">
                <div className="card-heading">
                  <div>
                    <span className="eyebrow">WHOLE WALKDOWN</span>
                    <h2>General walkdown comments</h2>
                  </div>
                  <Icon name="comment" />
                </div>
                <div className="general-comments-content">
                  <CommentPanel
                    key={`${selectedId}:${reportRevision}:walkdown:general`}
                    recordKey="walkdown:general"
                    title="Team observations"
                    comments={commentsFor("walkdown:general", state)}
                    draft={draftFor("walkdown:general")}
                    onDraft={(value) => updateDraft("walkdown:general", value)}
                    onPost={(text) =>
                      mutate(
                        () => writeBackend.addComment("walkdown:general", text),
                        "Walkdown comment added",
                      )
                    }
                    connected={connected}
                    inspector={inspector}
                    readOnly={!editable}
                    onDelete={(id) => mutate(() => writeBackend.deleteComment(id), "Comment removed")}
                    config={config}
                    backend={writeBackend}
                  />
                </div>
              </section>
            </>
          )}

          {(connected || !signedIn) && view === "layout" && group && (
            <>
              <button
                className="text-button back-link"
                onClick={() => navigate("layout")}
              >
                <Icon name="back" size={17} />
                All terminals
              </button>
              <div className="terminal-overview">
                <div className="card terminal-evidence">
                  <div
                    className="terminal-letter large"
                    style={{
                      "--group-color": schedule.groups.find(
                        (g) => g.id === group,
                      ).color,
                    }}
                  >
                    {group}
                  </div>
                  <div>
                    <h2>Terminal {group} evidence</h2>
                    <div className="inline-meta">
                      <span>
                        <Icon name="camera" size={15} />
                        {
                          photosFor(recordKey("terminal", group), state).length
                        }{" "}
                        photos
                      </span>
                      <span>
                        <Icon name="comment" size={15} />
                        {
                          commentsFor(recordKey("terminal", group), state)
                            .length
                        }{" "}
                        comments
                      </span>
                    </div>
                  </div>
                  <TerminalActions
                    key={`${selectedId}:${group}`}
                    group={group}
                    state={state}
                    connected={connected}
                    readOnly={!editable}
                    pending={pending > 0}
                    onInspect={() => openRecord("terminal", group)}
                    onComplete={() =>
                      mutate(
                        () =>
                          writeBackend.setComplete(
                            recordKey("terminal", group),
                            true,
                          ),
                        `Terminal ${group} marked complete`,
                      )
                    }
                  />
                </div>
                <div className="card terminal-progress-card">
                  <span className="eyebrow">DEVICE COVERAGE</span>
                  <strong>
                    {terminalProgress(group, schedule.devices, state).complete}
                    <span>
                      {" "}
                      / {groupDevices(schedule.devices, group).length}
                    </span>
                  </strong>
                  <progress
                    aria-label={`Terminal ${group} device progress`}
                    value={
                      terminalProgress(group, schedule.devices, state).complete
                    }
                    max={groupDevices(schedule.devices, group).length}
                  />
                  <span>devices complete</span>
                </div>
              </div>
              <div className="section-heading">
                <h2>Devices in terminal {group}</h2>
              </div>
              <div className="card device-list">
                {groupDevices(schedule.devices, group).map((device) => (
                  <DeviceRow
                    key={device.id}
                    device={device}
                    state={state}
                    connected={connected}
                    onClick={() => openRecord("device", device.id)}
                  />
                ))}
              </div>
            </>
          )}

          {(connected || !signedIn) && view === "devices" && (
            <OverviewTable
              schedule={schedule}
              state={state}
              connected={connected}
              readOnly={!editable}
              pending={pending > 0}
              onOpen={openRecord}
              onStart={(kind, id) => {
                const target = openRecord(kind, id);
                if (readyToDocument()) openCamera(target, target.terminal);
              }}
              onQuality={(key, value) =>
                mutate(() => writeBackend.setQuality(key, value), "Quality saved")
              }
            />
          )}

          {connected && <div hidden={view !== "tests"}>
            <TestReportsPanel
              key={selectedId}
              project={state.project}
              runs={state.testRuns || []}
              inspector={inspector}
              storageScope={config.url}
              timeRangeChanges={timeRangeChanges}
              onTimeRangeChange={changeTimeRange}
              graphOrderChanges={graphOrderChanges}
              onGraphOrderChange={changeGraphOrder}
              readOnly={!editable}
              checkerRequired={checkerRequired}
              pending={pending > 0 || Boolean(reporting)}
              exportProgress={reporting}
              onSave={saveTestRun}
              onDelete={deleteTestRun}
              getPhotoUrl={backend.getPhotoUrl}
              onAddSetupPhoto={addTestSetupPhoto}
              onUpdateSetupPhoto={updateTestSetupPhoto}
              onRemoveSetupPhoto={deleteTestSetupPhoto}
              onReorderSetupPhotos={reorderTestSetupPhotos}
              onExport={(runId) => exportTestReport(reportRevision, runId)}
              onReview={() => navigate("report")}
              onDirtyChange={setTestDraftDirty}
            />
          </div>}
          {!signedIn && view === "tests" && <section className="card test-empty">
            <Icon name="equipment" size={36} />
            <h2>PRONETA I/O test reports</h2>
            <p>Sign in and choose a skid to import CSV results, event logs, and parameter files. Review devices and aligned graphs, then approve the revision to export.</p>
            <button type="button" className="button primary" onClick={() => setAuthOpen(true)}>Sign in to import</button>
          </section>}

          {(connected || !signedIn) && view === "report" && (
            <>
              <section className="report-hero card">
                <div className="report-emblem">
                  <Icon name="report" size={32} />
                </div>
                <div>
                  <span className="eyebrow">
                    450K SKID X7 · REVISION {displayedRevision}
                  </span>
                  <h2>
                    {selectedSkid?.skidName
                      ? `${selectedSkid.skidName} — QC Report`
                      : "Your inspection, in one report"}
                  </h2>
                </div>
                <span className="report-tag">
                  {connected && completedTargets === TARGETS.length
                    ? "Complete inspection"
                    : "Partial inspection"}
                </span>
              </section>
              {connected && (
                <RevisionPanel
                  key={`${selectedId}:${reportRevision}`}
                  project={state.project}
                  revisions={state.revisions || []}
                  testRunCount={state.testRuns?.length || 0}
                  setupPhotoCount={(state.testRuns || []).reduce((count, run) => count + (run.setupPhotos?.length || 0), 0)}
                  hasDraftTests={testDraftDirty}
                  photoCount={state.photos.length}
                  commentCount={state.comments.length}
                  completedCount={completedTargets}
                  targetCount={TARGETS.length}
                  pending={pending > 0 || Boolean(reporting)}
                  hasDraftComments={hasDraftComments}
                  onSaveCheckedBy={saveCheckedBy}
                  onApprove={(review) => changeRevision("approve", review)}
                  onNewRevision={(revision) => changeRevision("new", { revision })}
                  onExport={exportReport}
                  onExportTests={exportTestReport}
                />
              )}
              {connected && ((state.testRuns?.length || 0) > 0 || testDraftDirty) && <div className="card test-report-link">
                <div><strong>{state.testRuns?.length || 0} saved test runs in revision {displayedRevision}</strong>
                  <p>{testDraftDirty ? checkerRequired ? "Save Checked by to resume your retained test run changes." : "You have unsaved test run changes. Save or discard them before approval." : "Setup photos, software details, recorded results, parameters, and graphs share this report’s revision lock."}</p></div>
                <button type="button" className="button secondary" onClick={() => navigate("tests")}>Review test reports</button>
              </div>}
              <section className="stats-strip report-stats">
                <Stat
                  value={connected ? `${totals.devices}/${schedule.devices.length}` : "—"}
                  label="Devices complete"
                  icon="device"
                />
                <Stat
                  value={connected ? `${totals.terminals}/${schedule.groups.length}` : "—"}
                  label="Terminals complete"
                  icon="layout"
                />
                <Stat
                  value={connected ? totals.photos : "—"}
                  label="Evidence photos"
                  icon="camera"
                />
                <Stat
                  value={connected ? `${totals.equipment}/${schedule.equipment.length}` : "—"}
                  label="Equipment complete"
                  icon="equipment"
                />
              </section>
              <section className="card">
                <div className="card-heading">
                  <h2>Report coverage</h2>
                </div>
                <div className="coverage-list">
                  {schedule.equipment.map((item) => {
                    const key = recordKey("equipment", item.id);
                    return (
                      <div className="coverage-row" key={key}>
                        <div className="terminal-letter" style={{ "--group-color": item.color }}>
                          <Icon name="equipment" size={17} />
                        </div>
                        <strong>{item.name}</strong>
                        <span>{photosFor(key, state).length} photos</span>
                        <span>{commentsFor(key, state).length} comments</span>
                        <Status value={recordStatus(key, state)} connected={connected} />
                      </div>
                    );
                  })}
                  {schedule.groups.map((g) => {
                    const p = terminalProgress(g.id, schedule.devices, state);
                    return (
                      <div className="coverage-row" key={g.id}>
                        <div
                          className="terminal-letter"
                          style={{ "--group-color": g.color }}
                        >
                          {g.id}
                        </div>
                        <strong>Terminal {g.id}</strong>
                        <span>
                          {p.complete} / {p.total} devices
                        </span>
                        <span>{p.terminalPhotos} terminal photos</span>
                        <Status
                          value={
                            p.done
                              ? "complete"
                              : p.started
                                ? "in-progress"
                                : "not-started"
                          }
                          connected={connected}
                        />
                      </div>
                    );
                  })}
                </div>
              </section>
              <section className="card general-comments-card">
                <div className="card-heading">
                  <div>
                    <span className="eyebrow">WHOLE WALKDOWN</span>
                    <h2>General walkdown comments</h2>
                  </div>
                  <Icon name="comment" />
                </div>
                <div className="general-comments-content">
                  <CommentPanel
                    key={`${selectedId}:${reportRevision}:walkdown:general`}
                    recordKey="walkdown:general"
                    title="Team observations"
                    comments={commentsFor("walkdown:general", state)}
                    draft={draftFor("walkdown:general")}
                    onDraft={(value) => updateDraft("walkdown:general", value)}
                    onPost={(text) =>
                      mutate(
                        () => writeBackend.addComment("walkdown:general", text),
                        "Walkdown comment added",
                      )
                    }
                    connected={connected}
                    inspector={inspector}
                    readOnly={!editable}
                    onDelete={(id) => mutate(() => writeBackend.deleteComment(id), "Comment removed")}
                    config={config}
                    backend={writeBackend}
                  />
                </div>
              </section>
              {reporting && (
                <div className="report-progress" role="status">
                  <span className="spinner" />
                  {reporting}
                </div>
              )}
            </>
          )}

          {view === "workspace" && (
            <Workspace
              backend={workspaceBackend}
              connected={signedIn}
              state={{ ...state, inspector }}
              session={session}
              config={config}
              setConfig={setConfig}
              lastSync={lastSync}
              onSignIn={() => setAuthOpen(true)}
              onSignOut={signOut}
              hasDraftTests={testDraftDirty}
            />
          )}
          <footer className="app-footer">
            <span>Jeevy Fabrication · DCS Field QC</span>
            <span>
              {connected ? "Private shared workspace" : "Project preview"}
              <i>·</i>Revision {displayedRevision}
              {connected && <> · {state.project.skidName}</>}
            </span>
          </footer>
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Icon name="check" size={18} />
          {notice}
        </div>
      )}
      {authOpen && (
        <AuthDialog
          backend={workspaceBackend}
          config={config}
          setConfig={setConfig}
          onClose={() => setAuthOpen(false)}
          onVerified={async (value) => {
            setSession(value);
            await loadWorkspace();
            setAuthOpen(false);
            setNotice("Connected. Select a skid report or create one.");
          }}
        />
      )}
      {skidDialog && (
        <SkidDialog
          mode={skidDialog}
          current={selectedSkid}
          onSave={saveSkid}
          onClose={() => setSkidDialog(null)}
        />
      )}
      {manualEntry && editable && (
        <Modal
          title="Enter device name"
          onClose={() => setManualEntry(false)}
          className="auth-dialog"
          initialFocus="#manual-device-name"
        >
          <ManualDeviceEntry
            skidName={state.project.skidName}
            onSelect={startDeviceEvidence}
          />
        </Modal>
      )}
      {bulkUpload && connected && (
        <BulkPhotoDialog
          key={bulkUpload.walkdownId}
          targets={TARGETS}
          skidName={bulkUpload.skidName}
          readOnly={!editable || bulkUpload.revision !== reportRevision}
          onPhoto={saveBulkPhoto}
          onClose={() => setBulkUpload(null)}
        />
      )}
      {record && !camera && !manualEntry && (
        <Modal
          title={record.title}
          onClose={() => setRecord(null)}
          className="record-dialog"
        >
          <RecordPanel
            key={`${selectedId}:${reportRevision}:${record.key}`}
            target={record}
            config={config}
            draft={draftFor(record.key)}
            onDraft={(value) => updateDraft(record.key, value)}
            state={state}
            connected={connected}
            readOnly={!editable}
            checkerRequired={checkerRequired}
            qualityDisabled={pending > 0}
            onQuality={(value) =>
              mutate(
                () => writeBackend.setQuality(record.key, value),
                "Quality saved",
              )
            }
            backend={writeBackend || backend}
            onCamera={() => {
              if (!readyToDocument()) return;
              openCamera(record, record.terminal);
            }}
            onPhoto={(photo) =>
              mutate(() => writeBackend.addPhoto(record.key, photo))
            }
            onComment={(text) =>
              mutate(
                () => writeBackend.addComment(record.key, text),
                "Comment added",
              )
            }
            onDeleteComment={(id) => mutate(() => writeBackend.deleteComment(id), "Comment removed")}
            onComplete={(complete) =>
              mutate(
                () => writeBackend.setComplete(record.key, complete),
                complete ? "QC marked complete" : "QC reopened",
              )
            }
            onDelete={(photo) =>
              mutate(() => writeBackend.deletePhoto(photo.id), "Photo removed")
            }
            onReorder={(ordered, expected, revision) => reorderInspectionPhotos(record.key, ordered, expected, revision)}
            onSignIn={() => setAuthOpen(true)}
          />
        </Modal>
      )}
      {camera && (
        <CameraDialog
          skidName={state.project?.skidName}
          target={camera.target}
          devices={schedule.devices}
          terminal={camera.terminal}
          quality={
            state.records.find((item) => item.key === camera.target?.key)
              ?.quality ?? null
          }
          qualityDisabled={!editable || pending > 0}
          readOnly={!editable || camera.backend !== writeBackend}
          onQuality={(value) => {
            if (activeEditor.current !== camera.backend)
              throw new Error("This camera belongs to a closed or earlier revision. Reopen it from the current draft.");
            return mutate(
              () => camera.backend.setQuality(camera.target.key, value),
              "Quality saved",
            );
          }}
          onClose={() => setCamera(null)}
          onMatch={(id) => {
            if (activeEditor.current === camera.backend) startDeviceEvidence(id);
          }}
          onManualEntry={enterDeviceName}
          onPhoto={(photo) => {
            if (!camera.target)
              throw new Error("Choose a device before saving evidence.");
            if (activeEditor.current !== camera.backend)
              throw new Error("This camera belongs to a closed or earlier revision. Reopen it from the current draft.");
            return mutate(() => camera.backend.addPhoto(camera.target.key, photo));
          }}
        />
      )}
    </div>
  );
}

function TerminalActions({
  group,
  state,
  connected,
  readOnly = false,
  pending,
  onInspect,
  onComplete,
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const savingRef = useRef(false);
  const progress = terminalProgress(group, schedule.devices, state);
  const ready =
    connected && !readOnly &&
    progress.total > 0 &&
    progress.complete === progress.total &&
    progress.terminalPhotos > 0;
  async function complete() {
    if (!ready || progress.done || pending || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      await onComplete();
    } catch (e) {
      setError(e.message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  return (
    <div className="terminal-evidence-actions">
      <button
        className="button secondary"
        onClick={onInspect}
        disabled={saving}
      >
        Inspect terminal <Icon name="arrow" size={16} />
      </button>
      <button
        className="button primary"
        onClick={complete}
        disabled={!ready || progress.done || saving || pending}
      >
        <Icon name="check" size={16} />
        {saving ? "Saving…" : progress.done ? "Complete" : "Mark complete"}
      </button>
      {connected && !ready && !progress.done && (
        <small>
          {!progress.terminalPhotos
            ? "Add a terminal photo first."
            : "Complete every device in this group first."}
        </small>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ManualDeviceEntry({ skidName, onSelect }) {
  const [query, setQuery] = useState("");
  const devices = findManualDevices(query, schedule.devices);
  return (
    <div className="manual-device-entry">
      <p className="help-text">Skid: {skidName}</p>
      <label htmlFor="manual-device-name">Device name</label>
      <input
        id="manual-device-name"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        autoFocus
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={120}
        placeholder="e.g. V-3541"
      />
      <p className="help-text" role="status">
        {devices.length
          ? `${devices.length} matching device${devices.length === 1 ? "" : "s"}`
          : "No scheduled devices match. Check the device name and try again."}
      </p>
      <ul className="manual-device-results">
        {devices.map((device) => (
          <li key={device.id}>
            <button
              type="button"
              onClick={() => onSelect(device.id)}
              aria-label={`Select ${device.name}, Terminal ${device.terminal}`}
            >
              <span>
                <strong>{device.name}</strong>
                <small>Terminal {device.terminal}</small>
              </span>
              <Icon name="camera" size={18} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SkidDialog({ mode, current, onSave, onClose }) {
  const [name, setName] = useState(
    mode === "rename" && !current?.nameRequired ? current?.skidName || "" : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal
      title={mode === "new" ? "New skid report" : "Name skid report"}
      onClose={() => {
        if (!saving) onClose();
      }}
      className="auth-dialog"
    >
      <form
        className="auth-form"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          setError("");
          try {
            await onSave(name.trim());
          } catch (e) {
            setError(e.message);
          } finally {
            setSaving(false);
          }
        }}
      >
        <label>
          Skid name
          <input
            autoFocus
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Skid 07"
            disabled={saving}
            autoComplete="off"
          />
        </label>
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
        <button
          className="button primary full-width"
          type="submit"
          disabled={saving || !name.trim()}
        >
          {saving
            ? "Saving…"
            : mode === "new"
              ? "Create skid report"
              : "Save skid name"}
        </button>
      </form>
    </Modal>
  );
}

function Stat({ value, label, icon }) {
  return (
    <div className="stat">
      <span className="stat-icon">
        <Icon name={icon} />
      </span>
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

function TerminalCard({ group, state, connected, onClick }) {
  const p = terminalProgress(group.id, schedule.devices, state);
  return (
    <button
      className={`terminal-card ${connected && p.done ? "done" : ""}`}
      onClick={onClick}
      style={{ "--group-color": group.color }}
      aria-label={`Inspect terminal ${group.id}`}
    >
      <div className="terminal-card-top">
        <span className="terminal-letter">{group.id}</span>
        {connected && p.done ? (
          <span className="complete-circle">
            <Icon name="check" size={17} />
          </span>
        ) : (
          <Icon name="arrow" size={16} />
        )}
      </div>
      <strong>Terminal {group.id}</strong>
      <span>
        {connected
          ? `${p.complete} of ${p.total} devices complete`
          : `${p.total} devices to inspect`}
      </span>
      <progress
        aria-label={`Terminal ${group.id} progress`}
        max={p.total}
        value={connected ? p.complete : 0}
      />
      <div className="terminal-card-bottom">
        <span>
          <Icon name="camera" size={14} />
          {connected ? p.terminalPhotos : "—"}
        </span>
        <Status
          value={
            p.done ? "complete" : p.started ? "in-progress" : "not-started"
          }
          connected={connected}
        />
      </div>
    </button>
  );
}

function EquipmentCard({ item, state, connected, onClick }) {
  const key = recordKey("equipment", item.id);
  const status = recordStatus(key, state);
  return (
    <button
      className={`terminal-card equipment-card ${connected && status === "complete" ? "done" : ""}`}
      onClick={onClick}
      style={{ "--group-color": item.color }}
      aria-label={`Inspect ${item.name}`}
    >
      <div className="terminal-card-top">
        <span className="terminal-letter"><Icon name="equipment" size={18} /></span>
        {connected && status === "complete"
          ? <span className="complete-circle"><Icon name="check" size={17} /></span>
          : <Icon name="arrow" size={16} />}
      </div>
      <strong>{item.name}</strong>
      <div className="terminal-card-bottom">
        <span><Icon name="camera" size={14} />{connected ? photosFor(key, state).length : "—"}</span>
        <Status value={status} connected={connected} />
      </div>
    </button>
  );
}

function DeviceRow({ device, state, connected, onClick }) {
  const key = recordKey("device", device.id);
  const status = recordStatus(key, state);
  return (
    <button
      className="device-row"
      onClick={onClick}
      aria-label={`Inspect ${device.name}`}
    >
      <span className={`device-status-icon ${connected ? status : ""}`}>
        <Icon
          name={connected && status === "complete" ? "check" : "device"}
          size={21}
        />
      </span>
      <span className="device-name">
        <strong>{device.name}</strong>
        <small>Terminal {device.terminal}</small>
      </span>
      <span className="cable-badges">
        {device.cables.map((c, i) => (
          <span key={i}>
            Cable {c.number}
            <small>{c.type}</small>
          </span>
        ))}
      </span>
      <span className="device-photo-count">
        <Icon name="camera" size={16} />
        {photosFor(key, state).length}
      </span>
      <Status value={status} connected={connected} />
      <Icon name="arrow" size={16} />
    </button>
  );
}

function RecordPanel({
  target,
  config,
  draft,
  onDraft,
  state,
  connected,
  readOnly = false,
  checkerRequired = false,
  qualityDisabled,
  onQuality,
  backend,
  onCamera,
  onPhoto,
  onComment,
  onDeleteComment,
  onComplete,
  onDelete,
  onSignIn,
  onReorder,
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const input = useRef(null);
  const photos = photosFor(target.key, state);
  const comments = commentsFor(target.key, state);
  const status = recordStatus(target.key, state);
  const devicesReady =
    target.kind !== "terminal" ||
    terminalProgress(target.terminal, schedule.devices, state).complete ===
      groupDevices(schedule.devices, target.terminal).length;
  const canComplete = connected && !readOnly && photos.length > 0 && devicesReady;
  useEffect(() => {
    setError("");
  }, [target.key]);
  async function action(name, operation) {
    if (readOnly) return false;
    setBusy(name);
    setError("");
    try {
      await operation();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy("");
    }
  }
  async function upload(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    await action("photos", async () => {
      for (const file of files) {
        const photo = await normalizePhoto(file, file.name);
        await onPhoto(photo);
      }
    });
  }
  return (
    <div className="record-content">
      <div className="record-summary">
        <span className="terminal-badge">Skid: {state.project?.skidName}</span>
        {target.terminal && <span className="terminal-badge">Terminal {target.terminal}</span>}
        <Status value={status} connected={connected} />
        {target.device && (
          <span className="record-cables">
            {target.device.cables.map((c, i) => (
              <span key={i}>
                Cable {c.number} · {c.type}
              </span>
            ))}
          </span>
        )}
      </div>
      {!connected && (
        <div className="inline-notice">
          Sign in to capture shared inspection evidence.
          <button className="text-button" onClick={onSignIn}>
            Sign in
          </button>
        </div>
      )}
      {connected && readOnly && (
        <div className="inline-notice">{checkerRequired
          ? "Save Checked by in the report workspace before changing evidence or results. Your pending work is retained."
          : "This revision is locked. Start a new revision from Report to change evidence or results."}</div>
      )}
      <section className="record-quality">
        <h3>Quality</h3>
        <QualityControl
          name={target.title}
          value={
            state.records.find((item) => item.key === target.key)?.quality ??
            null
          }
          disabled={!connected || readOnly || qualityDisabled || Boolean(busy)}
          onChange={onQuality}
        />
      </section>
      <PhotoGallery kind="inspection" run={{ id: target.key, walkdownId: state.project?.walkdownId, setupPhotos: photos }}
        revision={state.project?.revision} readOnly={!connected || readOnly} pending={qualityDisabled || Boolean(busy)}
        getPhotoUrl={backend?.getPhotoUrl}
        onReorderPhotos={(_run, ordered, expected, revision) => onReorder(ordered, expected, revision)}
        onRemovePhoto={(_run, photo) => onDelete(photo)}
        canRemovePhoto={photo => connected && (state.inspector.isAdmin || state.inspector.id === photo.createdBy)}
        headerActions={
        <div>
          <button
            className="small-button"
            disabled={!connected || readOnly || Boolean(busy) || qualityDisabled}
            onClick={() => input.current.click()}
          >
            <Icon name="upload" size={16} />
            Upload photos
          </button>
          <button
            className="small-button green"
            disabled={!connected || readOnly || Boolean(busy) || qualityDisabled}
            onClick={onCamera}
          >
            <Icon name="camera" size={16} />
            Take photos
          </button>
        </div>
        } />
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        disabled={!connected || readOnly || qualityDisabled || Boolean(busy)}
        onChange={upload}
      />
      {busy === "photos" && (
        <p className="save-progress" role="status">
          <span className="spinner" />
          Uploading photos…
        </p>
      )}
      <CommentPanel
        key={target.key}
        recordKey={target.key}
        title="Inspection comments"
        comments={comments}
        draft={draft}
        onDraft={onDraft}
        onPost={onComment}
        connected={connected}
        inspector={state.inspector}
        readOnly={readOnly}
        onDelete={onDeleteComment}
        config={config}
        backend={backend}
      />

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="completion-bar">
        <div>
          <strong>
            {status === "complete"
              ? "QC completed"
              : target.kind === "terminal"
                ? "Complete this terminal group"
                : target.kind === "equipment"
                  ? "Finish equipment QC"
                  : "Finish device QC"}
          </strong>
          {status !== "complete" && (!photos.length || !devicesReady) && (
            <p>
              {!photos.length
                ? "Add a photo first."
                : "Complete all devices first."}
            </p>
          )}
        </div>
        <button
          className={`button ${status === "complete" ? "secondary" : "primary"}`}
          disabled={
            !connected ||
            readOnly ||
            Boolean(busy) ||
            (status !== "complete" && !canComplete)
          }
          onClick={() =>
            action("complete", () => onComplete(status !== "complete"))
          }
        >
          <Icon name={status === "complete" ? "refresh" : "check"} size={18} />
          {busy === "complete"
            ? "Saving…"
            : status === "complete"
              ? "Reopen QC"
              : "Mark complete"}
        </button>
      </div>
    </div>
  );
}

function AuthDialog({ backend, config, setConfig, onClose, onVerified }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!backend)
        throw new Error("Configure the shared workspace before signing in.");
      if (!sent) {
        await backend.requestCode(email);
        setSent(true);
      } else {
        const value = await backend.verifyCode(email, code);
        await onVerified(value);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Inspector sign-in" onClose={onClose} className="auth-dialog">
      <form className="auth-form" onSubmit={submit}>
        <label>
          Email address
          <input
            autoComplete="email"
            type="email"
            required
            value={email}
            disabled={sent || busy}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@jeevyfabrication.com"
          />
        </label>
        {sent && (
          <label>
            Verification code (if included)
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6,10}"
              required
              value={code}
              onChange={(e) => setCode(e.target.value.trim())}
              placeholder="Code from your email"
            />
          </label>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        {sent && (
          <p className="help-text">
            Open the sign-in link sent to {email}, or enter its code.
          </p>
        )}
        <button
          className="button primary full-width"
          type="submit"
          disabled={busy || !backend}
        >
          {busy ? (
            <>
              <span className="spinner" />
              Connecting…
            </>
          ) : sent ? (
            "Verify code and sign in"
          ) : (
            "Email me a sign-in link"
          )}
        </button>
        {sent && (
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={() => {
              setSent(false);
              setCode("");
              setError("");
            }}
          >
            Use another email or resend sign-in email
          </button>
        )}
      </form>
      <p className="auth-footer">
        <Icon name="info" size={15} />
        Approved inspectors only.
      </p>
      {!backend && <ConfigForm config={config} onSave={setConfig} />}
    </Modal>
  );
}

function ConfigForm({ config, onSave }) {
  const [url, setUrl] = useState(config.url || "");
  const [key, setKey] = useState(config.key || "");
  const [error, setError] = useState("");
  return (
    <form
      className="config-form"
      onSubmit={(e) => {
        e.preventDefault();
        try {
          const valid = validateBackendConfig({ url, key });
          saveConfig(valid);
          onSave(valid);
          setError("");
        } catch (e) {
          setError(e.message);
        }
      }}
    >
      <label>
        Supabase project URL
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          autoComplete="off"
        />
      </label>
      <label>
        Public publishable key
        <input
          type="text"
          required
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          spellCheck="false"
        />
      </label>
      <p className="help-text">
        Use a public publishable key. Never enter a secret or service-role key.
      </p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="button secondary">
        Save workspace connection
      </button>
    </form>
  );
}

function Workspace({
  backend,
  connected,
  state,
  session,
  config,
  setConfig,
  lastSync,
  onSignIn,
  onSignOut,
  hasDraftTests = false,
}) {
  return (
    <div className="workspace-settings">
      <section className="card settings-card">
        <div className="card-heading">
          <h2>Inspector account</h2>
          <Status
            value={connected ? "complete" : "not-started"}
            connected={connected}
          />
        </div>
        <div className="settings-content">
          <div className="account-summary">
            <span className="avatar large">
              <Icon name="user" size={25} />
            </span>
            <div>
              <h3>
                {connected
                  ? state.inspector.name || state.inspector.email
                  : "Sign in to your team’s workspace"}
              </h3>
              <p>
                {connected
                  ? state.inspector.email
                  : "Photos and comments are stored privately and shared with approved inspectors."}
              </p>
              {connected && <small>Last synced {date(lastSync)}</small>}
            </div>
          </div>
          <button
            className="button secondary"
            disabled={hasDraftTests}
            onClick={connected || session?.user ? onSignOut : onSignIn}
          >
            <Icon
              name={connected || session?.user ? "logout" : "user"}
              size={17}
            />
            {connected || session?.user ? "Sign out" : "Inspector sign-in"}
          </button>
          {hasDraftTests && <p className="help-text">Save or discard your changes in Test reports before signing out or changing the connection.</p>}
        </div>
      </section>
      <section className="card settings-card">
        <div className="card-heading">
          <h2>Project connection</h2>
          <span className="subtle-label">Administrator settings</span>
        </div>
        <div className="settings-content">
          <fieldset disabled={hasDraftTests} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <ConfigForm config={config} onSave={setConfig} />
          </fieldset>
          <a
            className="text-link"
            href="https://github.com/KhuongNguyen99/DCS-QA-Report/blob/main/supabase/SETUP.md"
            target="_blank"
            rel="noreferrer"
          >
            Open workspace setup guide
            <Icon name="arrow" size={15} />
          </a>
        </div>
      </section>
    </div>
  );
}

export default App;
