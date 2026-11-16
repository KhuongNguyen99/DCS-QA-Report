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
import { recordKey, groupDevices } from "./domain.js";
import {
  photosFor,
  commentsFor,
  recordStatus,
  terminalProgress,
  inspectionProgress,
} from "./inspection.js";
import { normalizePhoto } from "./photos.js";
import CameraDialog from "./CameraDialog.jsx";
import Icon from "./Icons.jsx";
import OverviewTable from "./OverviewTable.jsx";
import CommentPanel from "./CommentPanel.jsx";

const EMPTY = { records: [], photos: [], comments: [], inspector: null };
const TITLES = {
  layout: "Conduit layout",
  devices: "QA overview",
  report: "Inspection report",
  workspace: "Shared workspace",
};
const STATUS = {
  complete: "Complete",
  "in-progress": "In progress",
  "not-started": "Not started",
};
const asset = (name) => `${import.meta.env.BASE_URL}assets/${name}`;
const date = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "";

function Modal({ title, children, onClose, className = "" }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current.showModal();
    return () => {
      ref.current?.close();
      previous?.focus?.();
    };
  }, []);
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
  const [view, setView] = useState("layout");
  const [group, setGroup] = useState(null);
  const [state, setState] = useState(EMPTY);
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  const [record, setRecord] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [camera, setCamera] = useState(null);
  const [search, setSearch] = useState("");
  const [filterGroup, setFilterGroup] = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [reporting, setReporting] = useState("");
  const [lastSync, setLastSync] = useState(null);
  const request = useRef(0);
  const backend = useMemo(() => {
    try {
      return createBackend(config);
    } catch {
      return null;
    }
  }, [config]);
  const connected = Boolean(state.inspector);
  const reportRevision = state.project?.revision ?? schedule.project.revision;
  const totals = inspectionProgress(schedule.devices, schedule.groups, state);

  const refresh = useCallback(async () => {
    if (!backend) return;
    const version = ++request.current;
    setLoading(true);
    try {
      const loaded = await backend.loadState();
      if (request.current === version) {
        setState(loaded);
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
  }, [backend]);

  useEffect(() => {
    let disposed = false;
    setChecking(true);
    setState(EMPTY);
    setSession(null);
    if (!backend) {
      setChecking(false);
      return;
    }
    backend
      .getSession()
      .then(async (value) => {
        if (disposed) return;
        setSession(value);
        if (value?.user) await refresh();
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
    };
  }, [backend, refresh]);

  useEffect(() => {
    if (!connected || !backend) return;
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
  }, [backend, connected, refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  function navigate(next, terminal = null) {
    setView(next);
    setGroup(terminal);
    setSearch("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  async function signOut() {
    try {
      await backend.signOut();
      ++request.current;
      setSession(null);
      setState(EMPTY);
      setRecord(null);
      setCamera(null);
      setDrafts({});
      setNotice("Signed out. Shared evidence is retained.");
    } catch (e) {
      setError(e.message);
    }
  }
  async function mutate(operation, message = "Saved to the shared workspace") {
    if (!connected) throw new Error("Sign in to your shared workspace first.");
    try {
      await operation();
      await refresh();
      setNotice(message);
    } catch (e) {
      setError(e.message);
      throw e;
    }
  }
  function openRecord(kind, id) {
    const device =
      kind === "device" ? schedule.devices.find((d) => d.id === id) : null;
    const target = {
      key: recordKey(kind, id),
      title: device?.name || `Terminal ${id}`,
      terminal: device?.terminal || id,
      kind,
      device,
    };
    setRecord(target);
    return target;
  }
  function scan(terminal = null) {
    if (!connected) {
      setAuthOpen(true);
      return;
    }
    setCamera({ target: null, terminal });
  }
  async function exportReport() {
    setReporting("Preparing your report…");
    setError("");
    try {
      const current = await refresh();
      if (!current)
        throw new Error("Connect to the shared workspace before exporting.");
      const snapshot = structuredClone(current);
      const { createInspectionPdf } = await import("./report.js");
      const blob = await createInspectionPdf({
        schedule,
        state: snapshot,
        backend,
        generatedAt: new Date(),
        onProgress: setReporting,
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `450k-Skid-x7-DCS-QA-Report-Rev${snapshot.project?.revision ?? reportRevision}-${new Date().toLocaleDateString("en-CA")}.pdf`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setNotice("PDF report exported with the current shared evidence.");
    } catch (e) {
      setError(e.message);
    } finally {
      setReporting("");
    }
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
          aria-label="Jeevy QA home"
        >
          <img src={asset("jeevy-logo.png")} alt="Jeevy Fabrication" />
          <span>FIELD QA</span>
        </a>
        <div className="project-tag">
          <span className="eyebrow">CURRENT PROJECT</span>
          <strong>450k Skid x7</strong>
          <span>DCS · QA Revision {reportRevision}</span>
        </div>
        <nav aria-label="Main navigation">
          {[
            ["layout", "layout", "Conduit layout"],
            ["devices", "device", "QA overview"],
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
                  {schedule.devices.length + schedule.groups.length}
                </small>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="shared-indicator">
            <Icon name="cloud" />
            <span>{connected ? "Shared workspace" : "Workspace preview"}</span>
          </div>
          <p>
            {connected
              ? "Evidence is saved to your team’s private workspace."
              : "Sign in to capture and share inspection evidence."}
          </p>
          <button
            className="inspector-chip"
            onClick={() =>
              connected ? navigate("workspace") : setAuthOpen(true)
            }
          >
            <span className="avatar">
              {connected ? (
                (state.inspector.name || state.inspector.email || "Q")
                  .slice(0, 1)
                  .toUpperCase()
              ) : (
                <Icon name="user" size={17} />
              )}
            </span>
            <span>
              <strong>
                {connected
                  ? state.inspector.name || state.inspector.email.split("@")[0]
                  : "Inspector sign-in"}
              </strong>
              <small>
                {connected ? state.inspector.email : "Connect to begin"}
              </small>
            </span>
            <Icon name="arrow" size={15} />
          </button>
        </div>
      </aside>

      <div className="workspace-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>QUALITY ASSURANCE</span>
            <i>/</i>
            <span>450K SKID X7</span>
          </div>
          <div className="topbar-actions">
            <span className={`sync-label ${connected ? "online" : ""}`}>
              <span />
              {checking
                ? "Connecting…"
                : loading
                  ? "Syncing…"
                  : connected
                    ? "All changes shared"
                    : "Not signed in"}
            </span>
            {connected ? (
              <button
                className="icon-button"
                aria-label="Refresh shared inspection"
                onClick={() => refresh().catch(() => {})}
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
              <p>
                {group && view === "layout"
                  ? "Inspect terminal evidence and every connected device."
                  : view === "layout"
                    ? "Choose a terminal to start your inspection."
                    : view === "devices"
                      ? "Documentation, quality, and QA status for every device and terminal."
                      : view === "report"
                        ? "A complete record of your team’s inspection evidence."
                        : "Private evidence, shared across your inspection team."}
              </p>
            </div>
            <div className="heading-actions">
              {["layout", "devices"].includes(view) && (
                <button className="button primary" onClick={() => scan(group)}>
                  <Icon name="scan" />
                  Scan device label
                </button>
              )}
              {view === "report" && (
                <button
                  className="button primary"
                  disabled={!connected || Boolean(reporting)}
                  onClick={exportReport}
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
          {!connected && !checking && view !== "workspace" && (
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
                    : "Sign in to add photos, leave comments, and see your team’s progress."}
                </p>
              </div>
              <button
                className="small-button"
                onClick={() =>
                  session?.user ? refresh().catch(() => {}) : setAuthOpen(true)
                }
              >
                {session?.user ? "Retry" : "Sign in"}
              </button>
            </div>
          )}

          {view === "layout" && !group && (
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
                  value={connected ? `${totals.terminals}/8` : "8"}
                  label={connected ? "Terminals complete" : "Terminal groups"}
                  icon="layout"
                />
                <Stat
                  value={connected ? totals.photos : "—"}
                  label="Evidence photos"
                  icon="camera"
                />
                <div className="overall-progress">
                  <div>
                    <span>Overall inspection</span>
                    <strong>
                      {connected
                        ? `${Math.round((totals.devices / schedule.devices.length) * 100)}%`
                        : "Preview"}
                    </strong>
                  </div>
                  <progress
                    aria-label="Device inspection completion"
                    max={schedule.devices.length}
                    value={connected ? totals.devices : 0}
                  />
                  <small>
                    {connected
                      ? "Mark each device complete after reviewing its evidence."
                      : "Shared progress appears after sign-in."}
                  </small>
                </div>
              </section>
              <section className="card map-card">
                <div className="card-heading">
                  <div>
                    <span className="eyebrow">INSPECTION MAP</span>
                    <h2>Conduit layout</h2>
                  </div>
                  <span className="subtle-label">Terminals A–H</span>
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
                  </div>
                </div>
                <div className="map-footer">
                  <span>
                    <Icon name="info" size={15} />
                    Tap a marker to inspect. On your phone, swipe to pan the
                    layout.
                  </span>
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
                    recordKey="walkdown:general"
                    title="Team observations"
                    comments={commentsFor("walkdown:general", state)}
                    draft={drafts["walkdown:general"] || ""}
                    onDraft={(value) =>
                      setDrafts((previous) => ({
                        ...previous,
                        ["walkdown:general"]:
                          typeof value === "function"
                            ? value(previous["walkdown:general"] || "")
                            : value,
                      }))
                    }
                    onPost={(text) =>
                      mutate(
                        () => backend.addComment("walkdown:general", text),
                        "Walkdown comment added",
                      )
                    }
                    connected={connected}
                    config={config}
                    backend={backend}
                  />
                </div>
              </section>
            </>
          )}

          {view === "layout" && group && (
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
                    <p>Photograph the terminal group and its connections.</p>
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
                  <button
                    className="button secondary"
                    onClick={() => openRecord("terminal", group)}
                  >
                    Inspect terminal
                    <Icon name="arrow" size={16} />
                  </button>
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
                <span>Review every device, then complete terminal QA.</span>
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

          {view === "devices" && (
            <OverviewTable
              schedule={schedule}
              state={state}
              connected={connected}
              onOpen={openRecord}
              onStart={(kind, id) => {
                const target = openRecord(kind, id);
                if (connected) setCamera({ target, terminal: target.terminal });
                else setAuthOpen(true);
              }}
              onQuality={(key, value) =>
                mutate(() => backend.setQuality(key, value), "Quality saved")
              }
            />
          )}

          {view === "report" && (
            <>
              <section className="report-hero card">
                <div className="report-emblem">
                  <Icon name="report" size={32} />
                </div>
                <div>
                  <span className="eyebrow">
                    450K SKID X7 · REVISION {reportRevision}
                  </span>
                  <h2>Your inspection, in one report</h2>
                  <p>
                    Includes all 28 devices, 8 terminal groups, photos,
                    comments, and completion status. Unfinished items are
                    clearly marked.
                  </p>
                </div>
                <span className="report-tag">
                  {connected && totals.devices === 28 && totals.terminals === 8
                    ? "Complete inspection"
                    : "Partial inspection"}
                </span>
              </section>
              <section className="stats-strip report-stats">
                <Stat
                  value={connected ? `${totals.devices}/28` : "—"}
                  label="Devices complete"
                  icon="device"
                />
                <Stat
                  value={connected ? `${totals.terminals}/8` : "—"}
                  label="Terminals complete"
                  icon="layout"
                />
                <Stat
                  value={connected ? totals.photos : "—"}
                  label="Evidence photos"
                  icon="camera"
                />
                <Stat
                  value={connected ? state.comments.length : "—"}
                  label="Comments"
                  icon="comment"
                />
              </section>
              <section className="card">
                <div className="card-heading">
                  <h2>Report coverage</h2>
                  <span className="subtle-label">
                    All terminal groups are included
                  </span>
                </div>
                <div className="coverage-list">
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
                    recordKey="walkdown:general"
                    title="Team observations"
                    comments={commentsFor("walkdown:general", state)}
                    draft={drafts["walkdown:general"] || ""}
                    onDraft={(value) =>
                      setDrafts((previous) => ({
                        ...previous,
                        ["walkdown:general"]:
                          typeof value === "function"
                            ? value(previous["walkdown:general"] || "")
                            : value,
                      }))
                    }
                    onPost={(text) =>
                      mutate(
                        () => backend.addComment("walkdown:general", text),
                        "Walkdown comment added",
                      )
                    }
                    connected={connected}
                    config={config}
                    backend={backend}
                  />
                </div>
              </section>
              <p className="report-footnote">
                <Icon name="cloud" size={16} />
                The PDF uses a fresh snapshot of your shared inspection when you
                export.
              </p>
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
              backend={backend}
              connected={connected}
              state={state}
              session={session}
              config={config}
              setConfig={setConfig}
              lastSync={lastSync}
              onSignIn={() => setAuthOpen(true)}
              onSignOut={signOut}
            />
          )}
          <footer className="app-footer">
            <span>Jeevy Fabrication · DCS Field QA</span>
            <span>
              {connected ? "Private shared workspace" : "Project preview"}
              <i>·</i>Revision {reportRevision}
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
          backend={backend}
          config={config}
          setConfig={setConfig}
          onClose={() => setAuthOpen(false)}
          onVerified={async (value) => {
            setSession(value);
            await refresh();
            setAuthOpen(false);
            setNotice("Connected to your shared inspection.");
          }}
        />
      )}
      {record && !camera && (
        <Modal
          title={record.title}
          onClose={() => setRecord(null)}
          className="record-dialog"
        >
          <RecordPanel
            target={record}
            config={config}
            draft={drafts[record.key] || ""}
            onDraft={(value) =>
              setDrafts((previous) => ({
                ...previous,
                [record.key]:
                  typeof value === "function"
                    ? value(previous[record.key] || "")
                    : value,
              }))
            }
            state={state}
            connected={connected}
            backend={backend}
            onCamera={() => {
              if (!connected) {
                setAuthOpen(true);
                return;
              }
              setCamera({ target: record, terminal: record.terminal });
            }}
            onPhoto={(photo) =>
              mutate(() => backend.addPhoto(record.key, photo))
            }
            onComment={(text) =>
              mutate(
                () => backend.addComment(record.key, text),
                "Comment added",
              )
            }
            onComplete={(complete) =>
              mutate(
                () => backend.setComplete(record.key, complete),
                complete ? "QA marked complete" : "QA reopened",
              )
            }
            onDelete={(photo) =>
              mutate(() => backend.deletePhoto(photo.id), "Photo removed")
            }
            onSignIn={() => setAuthOpen(true)}
          />
        </Modal>
      )}
      {camera && (
        <CameraDialog
          target={camera.target}
          devices={schedule.devices}
          terminal={camera.terminal}
          onClose={() => setCamera(null)}
          onMatch={(deviceId) => {
            const device = schedule.devices.find((d) => d.id === deviceId);
            if (device) {
              const target = {
                key: recordKey("device", device.id),
                title: device.name,
                terminal: device.terminal,
                kind: "device",
                device,
              };
              setCamera({ target, terminal: device.terminal });
              setRecord(target);
            }
          }}
          onPhoto={(photo) => {
            if (!camera.target)
              throw new Error("Choose a device before saving evidence.");
            return mutate(() => backend.addPhoto(camera.target.key, photo));
          }}
        />
      )}
    </div>
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

function EvidencePhoto({ photo, backend, canDelete, onDelete }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [removing, setRemoving] = useState(false);
  useEffect(() => {
    let active = true;
    backend
      .getPhotoUrl(photo)
      .then((value) => {
        if (active) setUrl(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [backend, photo.id]);
  async function remove() {
    if (
      !window.confirm(
        "Remove this evidence photo? The inspection will be reopened.",
      )
    )
      return;
    setRemoving(true);
    try {
      await onDelete(photo);
    } catch (e) {
      setError(e.message);
    } finally {
      setRemoving(false);
    }
  }
  return (
    <div className="evidence-photo">
      <button
        className="photo-open"
        disabled={!url}
        onClick={() => setExpanded(true)}
        aria-label={`View photo ${photo.name}`}
      >
        {url ? (
          <img src={url} alt={photo.name} loading="lazy" />
        ) : (
          <div className="photo-loading">
            {error ? "Photo unavailable" : <span className="spinner" />}
          </div>
        )}
      </button>
      <div className="photo-caption">
        <span>
          <strong>{photo.name}</strong>
          <small>{date(photo.createdAt)}</small>
        </span>
        {canDelete && (
          <button
            className="icon-button"
            disabled={removing}
            onClick={remove}
            aria-label={`Remove ${photo.name}`}
          >
            <Icon name="trash" size={16} />
          </button>
        )}
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {expanded && (
        <Modal
          title="Evidence photo"
          onClose={() => setExpanded(false)}
          className="photo-dialog"
        >
          <img className="full-photo" src={url} alt={photo.name} />
          <p className="photo-detail-caption">
            {photo.name} · {date(photo.createdAt)}
          </p>
        </Modal>
      )}
    </div>
  );
}

function RecordPanel({
  target,
  config,
  draft,
  onDraft,
  state,
  connected,
  backend,
  onCamera,
  onPhoto,
  onComment,
  onComplete,
  onDelete,
  onSignIn,
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
  const canComplete = connected && photos.length > 0 && devicesReady;
  useEffect(() => {
    setError("");
  }, [target.key]);
  async function action(name, operation) {
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
        <span className="terminal-badge">Terminal {target.terminal}</span>
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
      <div className="record-section-heading">
        <h3>
          Evidence photos <span>{photos.length}</span>
        </h3>
        <div>
          <button
            className="small-button"
            disabled={!connected || Boolean(busy)}
            onClick={() => input.current.click()}
          >
            <Icon name="upload" size={16} />
            Upload
          </button>
          <button
            className="small-button green"
            disabled={!connected || Boolean(busy)}
            onClick={onCamera}
          >
            <Icon name="camera" size={16} />
            Take photos
          </button>
        </div>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={upload}
      />
      {photos.length ? (
        <div className="photo-grid">
          {photos.map((photo) => (
            <EvidencePhoto
              key={photo.id}
              photo={photo}
              backend={backend}
              onDelete={onDelete}
              canDelete={
                connected &&
                (state.inspector.isAdmin ||
                  state.inspector.id === photo.createdBy)
              }
            />
          ))}
        </div>
      ) : (
        <div className="empty-photos">
          <span className="empty-photo-icon">
            <Icon name="camera" size={29} />
          </span>
          <strong>No evidence photos yet</strong>
          <p>
            {target.kind === "device"
              ? "Photograph the device label and its wiring."
              : "Photograph this terminal group and its connections."}
          </p>
          <button
            className="button secondary"
            disabled={!connected}
            onClick={onCamera}
          >
            <Icon name="camera" size={17} />
            Take the first photo
          </button>
        </div>
      )}
      {busy === "photos" && (
        <p className="save-progress" role="status">
          <span className="spinner" />
          Uploading photos to the shared workspace…
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
              ? "QA completed"
              : target.kind === "terminal"
                ? "Complete this terminal group"
                : "Finish device QA"}
          </strong>
          <p>
            {status === "complete"
              ? "Evidence reviewed and shared with your team."
              : !photos.length
                ? "Add at least one evidence photo first."
                : !devicesReady
                  ? "Complete all devices in this group before finishing terminal QA."
                  : "Review the photos and comments, then mark this item complete."}
          </p>
        </div>
        <button
          className={`button ${status === "complete" ? "secondary" : "primary"}`}
          disabled={
            !connected ||
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
              ? "Reopen QA"
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
      <div className="auth-intro">
        <span className="auth-icon">
          <Icon name="cloud" size={28} />
        </span>
        <h3>One inspection. Your whole team.</h3>
        <p>
          Sign in with an approved inspector email to share photos, comments,
          and progress.
        </p>
      </div>
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
            Check the email sent to {email}. Open the sign-in link, or enter the
            code if the email includes one.
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
        Only inspectors on your project’s allowlist can access QA evidence.
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
            onClick={connected || session?.user ? onSignOut : onSignIn}
          >
            <Icon
              name={connected || session?.user ? "logout" : "user"}
              size={17}
            />
            {connected || session?.user ? "Sign out" : "Inspector sign-in"}
          </button>
        </div>
      </section>
      <section className="card settings-card">
        <div className="card-heading">
          <h2>Project connection</h2>
          <span className="subtle-label">Administrator settings</span>
        </div>
        <div className="settings-content">
          <p>
            This app connects to your team’s Supabase project. Access is
            controlled by the inspector allowlist and private photo storage.
          </p>
          <ConfigForm config={config} onSave={setConfig} />
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
      <section className="settings-note">
        <Icon name="cloud" />
        <p>
          Photos stay in the private shared workspace. Reading a label with OCR
          happens on your device; the label image is not sent to an OCR service.
        </p>
      </section>
    </div>
  );
}

export default App;
