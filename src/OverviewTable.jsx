import React, { useMemo, useState } from "react";
import Icon from "./Icons.jsx";
import QualityControl from "./QualityControl.jsx";
import { inspectionTargets } from "./domain.js";
import {
  photosFor,
  commentsFor,
  recordStatus,
  terminalProgress,
} from "./inspection.js";

export default function OverviewTable({
  schedule,
  state,
  connected,
  onOpen,
  onStart,
  onQuality,
  pending = false,
}) {
  const [search, setSearch] = useState("");
  const [terminal, setTerminal] = useState("");
  const [kind, setKind] = useState("");
  const [documentation, setDocumentation] = useState("");
  const targets = useMemo(
    () => inspectionTargets(schedule),
    [schedule],
  );
  const shown = targets.filter(
    (item) =>
      (!terminal || item.terminal === terminal) &&
      (!kind || item.kind === kind) &&
      `${item.name} ${item.cables.map((c) => c.number).join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (!documentation ||
        (documentation === "documented") ===
          photosFor(item.key, state).length > 0),
  );
  return (
    <>
      <div className="filter-bar">
        <label className="search-field">
          <Icon name="search" />
          <input
            aria-label="Search overview"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search inspections…"
          />
        </label>
        <label className="select-field">
          <span className="sr-only">Terminal group</span>
          <select
            value={terminal}
            onChange={(e) => setTerminal(e.target.value)}
          >
            <option value="">All terminals</option>
            {schedule.groups.map((g) => (
              <option value={g.id} key={g.id}>
                Terminal {g.id}
              </option>
            ))}
          </select>
        </label>
        <label className="select-field">
          <span className="sr-only">Item type</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All items</option>
            <option value="equipment">Equipment only</option>
            <option value="device">Devices only</option>
            <option value="terminal">Terminals only</option>
          </select>
        </label>
        <label className="select-field">
          <span className="sr-only">Documentation filter</span>
          <select
            value={documentation}
            onChange={(e) => setDocumentation(e.target.value)}
          >
            <option value="">All documentation</option>
            <option value="documented">Documented</option>
            <option value="missing">Not documented</option>
          </select>
        </label>
      </div>
      <div className="list-heading">
        <span>
          {shown.length} of {targets.length} items
        </span>
        <span>
          QA Revision {state.project?.revision ?? schedule.project.revision}
        </span>
      </div>
      <section className="card">
        <div className="overview-scroll">
          <table className="overview-table">
            <caption className="sr-only">
              All equipment, devices, and terminal groups with shared documentation,
              quality, and QA progress
            </caption>
            <thead>
              <tr>
                <th scope="col">Inspection item</th>
                <th scope="col">Group</th>
                <th scope="col">Cable</th>
                <th scope="col">Documentation</th>
                <th scope="col">Photos</th>
                <th scope="col">Comments</th>
                <th scope="col">Quality</th>
                <th scope="col">QA review</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => {
                const photos = photosFor(item.key, state);
                const comments = commentsFor(item.key, state);
                const documented = connected && photos.length > 0;
                const record = state.records.find((r) => r.key === item.key);
                const status =
                  item.kind === "terminal"
                    ? terminalProgress(item.terminal, schedule.devices, state)
                        .done
                      ? "complete"
                      : recordStatus(item.key, state)
                    : recordStatus(item.key, state);
                return (
                  <tr
                    key={item.key}
                    className={
                      item.kind === "terminal" ? "terminal-table-row" : ""
                    }
                  >
                    <td>
                      <div className="overview-target">
                        <span
                          className="terminal-letter"
                          style={{ "--group-color": item.color }}
                        >
                          {item.kind === "terminal" ? (
                            item.terminal
                          ) : (
                            <Icon name={item.kind === "equipment" ? "equipment" : "device"} size={16} />
                          )}
                        </span>
                        <span>
                          <strong>{item.name}</strong>
                        </span>
                      </div>
                    </td>
                    <td>{item.terminal || "—"}</td>
                    <td>
                      <div className="overview-cables">
                        {item.cables.length
                          ? item.cables.map((c, i) => (
                              <span key={i}>
                                {c.number} · {c.type}
                              </span>
                            ))
                          : "—"}
                      </div>
                    </td>
                    <td>
                      {documented ? (
                        <span className="documented">
                          <Icon name="check" size={15} />
                          Documented
                        </span>
                      ) : (
                        <span className="not-documented">
                          {connected ? "Not documented" : "Sign in to view"}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="overview-number">
                        <Icon name="camera" size={14} />
                        {connected ? photos.length : "—"}
                      </span>
                    </td>
                    <td>
                      <span className="overview-number">
                        <Icon name="comment" size={14} />
                        {connected ? comments.length : "—"}
                      </span>
                    </td>
                    <td>
                      <QualityControl
                        name={item.name}
                        value={connected ? record?.quality : null}
                        disabled={!connected || pending}
                        onChange={(value) => onQuality(item.key, value)}
                      />
                    </td>
                    <td>
                      <span
                        className={`status ${connected ? status : "preview"}`}
                      >
                        {status === "complete" && connected ? (
                          <Icon name="check" size={12} />
                        ) : (
                          <span className="status-dot" />
                        )}
                        {connected
                          ? status === "complete"
                            ? "Complete"
                            : status === "in-progress"
                              ? "In progress"
                              : "Not started"
                          : "Preview"}
                      </span>
                    </td>
                    <td>
                      <button
                        className={`small-button start-button ${documented ? "" : "green"}`}
                        onClick={() =>
                          documented
                            ? onOpen(item.kind, item.id)
                            : onStart(item.kind, item.id)
                        }
                      >
                        {documented ? (
                          <>
                            <Icon name="arrow" size={13} />
                            Open record
                          </>
                        ) : (
                          <>
                            <Icon name="camera" size={13} />
                            Start documenting
                          </>
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!shown.length && (
          <div className="empty-state">
            <Icon name="search" size={28} />
            <h3>No matching items</h3>
            <p>Clear filters.</p>
          </div>
        )}
      </section>
    </>
  );
}
