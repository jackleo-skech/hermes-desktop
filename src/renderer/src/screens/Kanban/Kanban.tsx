import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Plus,
  Refresh,
  X,
  Zap,
  Trash,
  Alert,
  Check,
  Ban,
  RotateCcw,
  Sparkles,
} from "../../assets/icons";

interface KanbanProps {
  profile?: string;
  visible?: boolean;
}

interface KanbanTask {
  id: string;
  title: string;
  body: string | null;
  assignee: string | null;
  status: string;
  priority: number;
  tenant: string | null;
  workspace_kind: string;
  workspace_path: string | null;
  created_by: string | null;
  created_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  result: string | null;
  skills: string[];
  max_retries: number | null;
}

interface KanbanBoard {
  slug: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  is_current: boolean;
  archived?: boolean;
  total: number;
  counts: Record<string, number>;
  db_path?: string;
}

interface KanbanComment {
  id: number;
  task_id: string;
  author: string | null;
  body: string;
  created_at: number;
}

interface KanbanEvent {
  id: number;
  task_id: string;
  kind: string;
  payload: Record<string, unknown> | null;
  created_at: number;
  run_id: number | null;
}

interface KanbanRun {
  id: number;
  task_id: string;
  profile: string | null;
  status: string | null;
  outcome: string | null;
  summary: string | null;
  error: string | null;
  started_at: number | null;
  ended_at: number | null;
  last_heartbeat_at: number | null;
}

interface KanbanTaskDetail {
  task: KanbanTask;
  comments: KanbanComment[];
  events: KanbanEvent[];
  parents: string[];
  children: string[];
  runs: KanbanRun[];
  latest_summary: string | null;
}

const COLUMNS: { key: string; label: string }[] = [
  { key: "triage", label: "Triage" },
  { key: "todo", label: "To-do" },
  { key: "ready", label: "Ready" },
  { key: "running", label: "Running" },
  { key: "blocked", label: "Blocked" },
  { key: "done", label: "Done" },
];

const POLL_INTERVAL_MS = 6000;

// Sentinel slug for the read-only Claw3D HQ virtual board. Distinct from any
// real hermes-agent kanban board slug (which is bash-safe alphanumeric per
// the backend CLI).
const HQ_BOARD_SLUG = "__claw3d_hq__";

// localStorage key for remembering which board the user last viewed across
// sessions. Stored value is either a real board slug or HQ_BOARD_SLUG.
const ACTIVE_BOARD_LS_KEY = "hermes:kanban:active-board";

function readStoredActiveBoard(): string | null {
  try {
    const v = window.localStorage.getItem(ACTIVE_BOARD_LS_KEY);
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}

function priorityLabel(p: number): string {
  if (p >= 10) return "P0";
  if (p >= 5) return "P1";
  if (p > 0) return "P2";
  return "";
}

function ageLabel(createdAt: number | null): string {
  if (!createdAt) return "";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - createdAt));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function Kanban({ profile, visible }: KanbanProps): React.JSX.Element {
  const [boards, setBoards] = useState<KanbanBoard[]>([]);
  const [tasks, setTasks] = useState<KanbanTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showNewBoard, setShowNewBoard] = useState(false);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KanbanTaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [remoteUnsupported, setRemoteUnsupported] = useState(false);
  const [profileOptions, setProfileOptions] = useState<string[]>([]);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);

  // When the Claw3D HQ virtual board is active we route reads to the
  // task-store JSON on the remote (via kanbanListClaw3dHqTasks) and hide all
  // mutation affordances. Initialized from localStorage so the user's last
  // selection survives reloads; null means "follow the real boards'
  // is_current" until autoDefaultRef below decides otherwise.
  const [activeBoardSlug, setActiveBoardSlug] = useState<string | null>(
    readStoredActiveBoard,
  );
  const isHqActive = activeBoardSlug === HQ_BOARD_SLUG;
  const [hqAvailable, setHqAvailable] = useState(false);
  // One-shot guard: only auto-default to HQ on the first loadAll. After
  // that, respect the user's explicit choice (including switching back to
  // Default), and never re-jump them to HQ on subsequent refreshes.
  const autoDefaultedRef = useRef(false);

  // Create task form
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [newAssignee, setNewAssignee] = useState("");
  const [newPriority, setNewPriority] = useState("0");
  const [newWorkspace, setNewWorkspace] = useState("scratch");
  const [newWorkspaceDir, setNewWorkspaceDir] = useState("");
  const [newTriage, setNewTriage] = useState(false);

  // New board form
  const [newBoardSlug, setNewBoardSlug] = useState("");
  const [newBoardName, setNewBoardName] = useState("");

  const currentBoard = useMemo(
    () => boards.find((b) => b.is_current) ?? null,
    [boards],
  );

  const loadAll = useCallback(
    async (silent = false): Promise<void> => {
      if (!silent) setLoading(true);
      try {
        // Always refresh the real boards list, plus either the active real
        // board's tasks OR the Claw3D HQ tasks depending on which is selected.
        const wantHq = activeBoardSlug === HQ_BOARD_SLUG;
        type TasksRes = {
          success: boolean;
          data?: KanbanTask[];
          error?: string;
        };
        const [boardsRes, tasksRes, hqRes] = await Promise.all([
          window.hermesAPI.kanbanListBoards(false, profile),
          wantHq
            ? Promise.resolve<TasksRes>({ success: true, data: [] })
            : window.hermesAPI.kanbanListTasks({
                includeArchived: false,
                profile,
              }),
          window.hermesAPI.kanbanListClaw3dHqTasks(),
        ]);
        if (!boardsRes.success) {
          // Only the genuine unsupported-mode result (plain remote HTTP)
          // flips the "switch modes" screen. A real SSH-Kanban failure
          // must surface its actual error rather than be mislabelled as a
          // mode problem — its message can contain the word "remote"
          // without the mode being unsupported (issue #319).
          if (boardsRes.unsupportedMode) {
            setRemoteUnsupported(true);
            return;
          }
          setError(boardsRes.error || "Failed to load boards");
          return;
        }
        // HQ availability: we treat the board as available whenever the SSH
        // reader succeeds (even with zero tasks — that's a valid empty board).
        // Failure (not in SSH mode, file unreadable) → hide the chip entirely.
        const hqOk = hqRes.success;
        const hqTasks = hqOk ? hqRes.data || [] : [];
        setHqAvailable(hqOk);
        setRemoteUnsupported(false);
        setBoards(boardsRes.data || []);

        // One-shot auto-default to HQ: if this is the first load AND the
        // user has no stored preference AND HQ is available, jump straight
        // to HQ. `hqOk` already implies SSH tunnel mode (the SSH reader
        // only succeeds when conn.mode === "ssh"), so this also satisfies
        // "if I'm running tunnel mode, use tunnel not default". After this
        // one-shot fires, respect the user's explicit choice — never
        // re-jump them on subsequent refreshes.
        if (!autoDefaultedRef.current && activeBoardSlug === null && hqOk) {
          autoDefaultedRef.current = true;
          setActiveBoardSlug(HQ_BOARD_SLUG);
          setTasks(hqTasks);
          setError("");
          return;
        }
        autoDefaultedRef.current = true;

        if (wantHq) {
          setTasks(hqTasks);
        } else {
          if (!tasksRes.success) {
            setError(tasksRes.error || "Failed to load tasks");
            return;
          }
          setTasks(tasksRes.data || []);
        }
        setError("");
      } catch (e) {
        setError((e as Error).message);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [profile, activeBoardSlug],
  );

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Persist the user's board choice across reloads. Skip the initial null
  // state (= "not yet decided") so we don't overwrite a previously-stored
  // value before auto-default fires.
  useEffect(() => {
    if (activeBoardSlug === null) return;
    try {
      window.localStorage.setItem(ACTIVE_BOARD_LS_KEY, activeBoardSlug);
    } catch {
      // localStorage unavailable (private mode, quota) — fall back to
      // session-only memory of the selection.
    }
  }, [activeBoardSlug]);

  useEffect(() => {
    if (!showCreate) return;
    window.hermesAPI.listProfiles().then((profiles) => {
      setProfileOptions(profiles.map((p) => p.name));
    });
  }, [showCreate]);

  // Light polling while the tab is visible — the gateway dispatcher writes
  // to kanban.db out-of-band, so we need to refresh to surface state moves
  // (e.g. ready → running once a worker claims a task).
  useEffect(() => {
    if (visible === false) return;
    const id = setInterval(() => loadAll(true), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [loadAll, visible]);

  useEffect(() => {
    if (!detailTaskId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    window.hermesAPI.kanbanGetTask(detailTaskId, profile).then((res) => {
      if (cancelled) return;
      if (res.success && res.data) setDetail(res.data);
      setDetailLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [detailTaskId, profile]);

  const tasksByStatus = useMemo(() => {
    const grouped: Record<string, KanbanTask[]> = {};
    for (const col of COLUMNS) grouped[col.key] = [];
    for (const task of tasks) {
      const col = COLUMNS.some((c) => c.key === task.status)
        ? task.status
        : "todo";
      grouped[col] = grouped[col] || [];
      grouped[col].push(task);
    }
    // Stable ordering: priority DESC, created_at ASC (matches backend)
    for (const k of Object.keys(grouped)) {
      grouped[k].sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return (a.created_at || 0) - (b.created_at || 0);
      });
    }
    return grouped;
  }, [tasks]);

  function resetCreateForm(): void {
    setNewTitle("");
    setNewBody("");
    setNewAssignee("");
    setNewPriority("0");
    setNewWorkspace("scratch");
    setNewWorkspaceDir("");
    setNewTriage(false);
  }

  async function handlePickWorkspaceFolder(): Promise<void> {
    const dir = await window.hermesAPI.selectFolder();
    if (dir) setNewWorkspaceDir(dir);
  }

  async function handleCreate(): Promise<void> {
    if (!newTitle.trim()) return;
    let workspaceArg: string | undefined;
    if (newWorkspace === "dir") {
      if (!newWorkspaceDir) {
        setError("Pick a workspace folder first.");
        return;
      }
      workspaceArg = `dir:${newWorkspaceDir}`;
    } else {
      workspaceArg = newWorkspace || undefined;
    }
    setActionBusy("create");
    const res = await window.hermesAPI.kanbanCreateTask(
      {
        title: newTitle.trim(),
        body: newBody.trim() || undefined,
        assignee: newAssignee.trim() || undefined,
        priority: parseInt(newPriority, 10) || 0,
        workspace: workspaceArg,
        triage: newTriage || undefined,
      },
      profile,
    );
    setActionBusy(null);
    if (!res.success) {
      setError(res.error || "Failed to create task");
      return;
    }
    setShowCreate(false);
    resetCreateForm();
    loadAll(true);
  }

  async function handleBoardSwitch(slug: string): Promise<void> {
    // HQ is a virtual, renderer-only view; don't call the backend switch RPC.
    if (slug === HQ_BOARD_SLUG) {
      if (isHqActive) return;
      setActiveBoardSlug(HQ_BOARD_SLUG);
      setDetailTaskId(null);
      return;
    }
    if (currentBoard?.slug === slug && !isHqActive) return;
    setActionBusy("board-switch");
    const res = await window.hermesAPI.kanbanSwitchBoard(slug, profile);
    setActionBusy(null);
    if (!res.success) {
      setError(res.error || "Failed to switch board");
      return;
    }
    setActiveBoardSlug(slug);
    loadAll();
  }

  async function handleCreateBoard(): Promise<void> {
    if (!newBoardSlug.trim()) return;
    setActionBusy("board-create");
    const res = await window.hermesAPI.kanbanCreateBoard(
      newBoardSlug.trim(),
      newBoardName.trim() || undefined,
      true,
      profile,
    );
    setActionBusy(null);
    if (!res.success) {
      setError(res.error || "Failed to create board");
      return;
    }
    setShowNewBoard(false);
    setNewBoardSlug("");
    setNewBoardName("");
    loadAll();
  }

  async function handleMove(task: KanbanTask, target: string): Promise<void> {
    if (task.status === target) return;
    setActionBusy(task.id);
    let res: { success: boolean; error?: string };
    if (target === "done") {
      res = await window.hermesAPI.kanbanCompleteTask(
        task.id,
        undefined,
        profile,
      );
    } else if (target === "blocked") {
      const reason = window.prompt("Reason for blocking?") || "";
      res = await window.hermesAPI.kanbanBlockTask(
        task.id,
        reason || undefined,
        profile,
      );
    } else if (target === "ready" && task.status === "blocked") {
      res = await window.hermesAPI.kanbanUnblockTask(task.id, profile);
    } else {
      setActionBusy(null);
      setError(
        `Cannot move ${task.status} → ${target} from the desktop. Use the agent or CLI.`,
      );
      return;
    }
    setActionBusy(null);
    if (!res.success) {
      setError(res.error || "Failed to move task");
      return;
    }
    loadAll(true);
  }

  async function handleSpecify(task: KanbanTask): Promise<void> {
    setActionBusy(task.id);
    const res = await window.hermesAPI.kanbanSpecifyTask(task.id, profile);
    setActionBusy(null);
    if (!res.success) {
      setError(res.error || "Failed to specify task");
      return;
    }
    loadAll(true);
  }

  function isValidDragTransition(from: string, to: string): boolean {
    if (from === to) return false;
    if (to === "done") return true;
    if (
      to === "blocked" &&
      (from === "todo" || from === "ready" || from === "running")
    )
      return true;
    if (to === "ready" && from === "blocked") return true;
    return false;
  }

  async function handleDrop(task: KanbanTask, target: string): Promise<void> {
    if (!isValidDragTransition(task.status, target)) return;
    if (target === "done") {
      if (!window.confirm(`Mark "${task.title}" as done?`)) return;
    }
    await handleMove(task, target);
  }

  async function handleArchive(task: KanbanTask): Promise<void> {
    if (!window.confirm(`Archive "${task.title}"?`)) return;
    setActionBusy(task.id);
    const res = await window.hermesAPI.kanbanArchiveTask(task.id, profile);
    setActionBusy(null);
    if (!res.success) {
      setError(res.error || "Failed to archive task");
      return;
    }
    if (detailTaskId === task.id) setDetailTaskId(null);
    loadAll(true);
  }

  async function handleReclaim(task: KanbanTask): Promise<void> {
    setActionBusy(task.id);
    const res = await window.hermesAPI.kanbanReclaimTask(
      task.id,
      "reclaimed from desktop",
      profile,
    );
    setActionBusy(null);
    if (!res.success) setError(res.error || "Failed to reclaim");
    else loadAll(true);
  }

  async function handleDispatch(): Promise<void> {
    setActionBusy("dispatch");
    const res = await window.hermesAPI.kanbanDispatchOnce(false, profile);
    setActionBusy(null);
    if (!res.success) {
      setError(res.error || "Dispatch failed");
      return;
    }
    loadAll(true);
  }

  if (remoteUnsupported) {
    return (
      <div className="kanban-container">
        <div className="kanban-empty">
          <p className="schedules-empty-text">
            Kanban requires a local Hermes install or SSH tunnel mode.
          </p>
          <p className="schedules-empty-hint">
            Plain remote (HTTP + API key) mode does not yet expose the kanban
            API. Switch to local or SSH tunnel mode in Settings to manage the
            board.
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="kanban-container">
        <div className="schedules-loading">
          <div className="loading-spinner" />
        </div>
      </div>
    );
  }

  return (
    <div className="kanban-container">
      <div className="kanban-header">
        <div>
          <h2 className="schedules-title">Kanban</h2>
          <p className="schedules-subtitle">
            Durable multi-agent board for tasks the agent can pick up and finish
            on its own.
          </p>
        </div>
        <div className="schedules-header-actions">
          <button
            className="btn btn-secondary"
            onClick={() => loadAll()}
            disabled={actionBusy !== null}
          >
            <Refresh size={14} />
            Refresh
          </button>
          {!isHqActive && (
            <>
              <button
                className="btn btn-secondary"
                onClick={handleDispatch}
                disabled={actionBusy !== null}
                data-tooltip="Run one dispatcher pass — promote ready tasks and spawn workers"
              >
                <Zap size={14} />
                Dispatch
              </button>
              <button
                className="btn btn-primary"
                onClick={() => setShowCreate(true)}
              >
                <Plus size={14} />
                New task
              </button>
            </>
          )}
        </div>
      </div>

      {(boards.length > 0 || hqAvailable) && (
        <div className="kanban-boards-bar">
          {boards.map((b) => {
            const active = isHqActive ? false : b.is_current;
            return (
              <button
                key={b.slug}
                className={`kanban-board-chip${
                  active ? " kanban-board-chip-active" : ""
                }`}
                onClick={() => handleBoardSwitch(b.slug)}
                disabled={actionBusy === "board-switch"}
                title={b.description || b.slug}
              >
                {active && <span className="kanban-board-dot" />}
                <span>{b.name || b.slug}</span>
                <span className="kanban-board-count">{b.total}</span>
              </button>
            );
          })}
          {hqAvailable && (
            <button
              key={HQ_BOARD_SLUG}
              className={`kanban-board-chip${
                isHqActive ? " kanban-board-chip-active" : ""
              }`}
              onClick={() => handleBoardSwitch(HQ_BOARD_SLUG)}
              disabled={actionBusy === "board-switch"}
              title="Claw3D headquarters board (read-only mirror)"
            >
              {isHqActive && <span className="kanban-board-dot" />}
              <span>HQ (Claw3D)</span>
              <span className="kanban-board-count">
                {isHqActive ? tasks.length : ""}
              </span>
            </button>
          )}
          {!isHqActive && (
            <button
              className="kanban-board-chip kanban-board-chip-add"
              onClick={() => setShowNewBoard(true)}
            >
              <Plus size={12} />
              New board
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="skills-error">
          {error}
          <button
            className="btn-ghost"
            title="Dismiss error"
            onClick={() => setError("")}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {isHqActive && (
        <div className="kanban-hq-banner">
          Read-only mirror of Claw3D&apos;s headquarters board. Edits made here
          would not sync — use the Office screen to manage HQ tasks.
        </div>
      )}

      <div className="kanban-columns">
        {COLUMNS.map((col) => {
          const colTasks = tasksByStatus[col.key] || [];
          const draggingTask = draggingTaskId
            ? tasks.find((t) => t.id === draggingTaskId)
            : null;
          const canDropHere =
            !!draggingTask &&
            isValidDragTransition(draggingTask.status, col.key);
          return (
            <div
              key={col.key}
              className={`kanban-column${
                dragOverCol === col.key && canDropHere && !isHqActive
                  ? " kanban-column-drop"
                  : ""
              }`}
              onDragOver={(e) => {
                if (isHqActive || !canDropHere) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragOverCol !== col.key) setDragOverCol(col.key);
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                if (dragOverCol === col.key) setDragOverCol(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragOverCol(null);
                if (isHqActive || !draggingTask) return;
                handleDrop(draggingTask, col.key);
              }}
            >
              <div className="kanban-column-header">
                <span className="kanban-column-title">{col.label}</span>
                <span className="kanban-column-count">{colTasks.length}</span>
              </div>
              <div className="kanban-column-body">
                {colTasks.length === 0 && (
                  <div className="kanban-column-empty">—</div>
                )}
                {colTasks.map((task) => {
                  const prio = priorityLabel(task.priority);
                  const age = ageLabel(task.created_at);
                  return (
                    <div
                      key={task.id}
                      className={`kanban-card${
                        draggingTaskId === task.id
                          ? " kanban-card-dragging"
                          : ""
                      }${isHqActive ? " kanban-card-readonly" : ""}`}
                      draggable={!isHqActive}
                      onDragStart={(e) => {
                        if (isHqActive) return;
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", task.id);
                        setDraggingTaskId(task.id);
                      }}
                      onDragEnd={() => {
                        setDraggingTaskId(null);
                        setDragOverCol(null);
                      }}
                      onClick={() => {
                        if (isHqActive) return;
                        setDetailTaskId(task.id);
                      }}
                    >
                      <div className="kanban-card-title">{task.title}</div>
                      <div className="kanban-card-meta">
                        {prio && (
                          <span className="kanban-pill kanban-pill-prio">
                            {prio}
                          </span>
                        )}
                        {task.assignee && (
                          <span className="kanban-pill">@{task.assignee}</span>
                        )}
                        {task.tenant && (
                          <span className="kanban-pill">{task.tenant}</span>
                        )}
                        {age && <span className="kanban-pill-age">{age}</span>}
                      </div>
                      <div className="kanban-card-actions">
                        {isHqActive && (
                          <span className="kanban-pill kanban-pill-readonly">
                            read-only
                          </span>
                        )}
                        {!isHqActive && task.status === "triage" && (
                          <button
                            className="btn-ghost kanban-card-action"
                            data-tooltip="Specify (expand spec → to-do)"
                            title="Specify (expand spec → to-do)"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSpecify(task);
                            }}
                            disabled={actionBusy === task.id}
                          >
                            <Sparkles size={14} />
                          </button>
                        )}
                        {!isHqActive && task.status === "ready" && (
                          <button
                            className="btn-ghost kanban-card-action"
                            data-tooltip="Mark done"
                            title="Mark done"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMove(task, "done");
                            }}
                            disabled={actionBusy === task.id}
                          >
                            <Check size={14} />
                          </button>
                        )}
                        {!isHqActive && task.status === "running" && (
                          <button
                            className="btn-ghost kanban-card-action"
                            data-tooltip="Reclaim worker"
                            title="Reclaim worker"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleReclaim(task);
                            }}
                            disabled={actionBusy === task.id}
                          >
                            <Alert size={14} />
                          </button>
                        )}
                        {!isHqActive && task.status === "blocked" && (
                          <button
                            className="btn-ghost kanban-card-action"
                            data-tooltip="Unblock"
                            title="Unblock"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMove(task, "ready");
                            }}
                            disabled={actionBusy === task.id}
                          >
                            <RotateCcw size={14} />
                          </button>
                        )}
                        {!isHqActive &&
                          (task.status === "todo" ||
                            task.status === "ready") && (
                            <button
                              className="btn-ghost kanban-card-action"
                              data-tooltip="Block"
                              title="Block"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleMove(task, "blocked");
                              }}
                              disabled={actionBusy === task.id}
                            >
                              <Ban size={14} />
                            </button>
                          )}
                        {!isHqActive && (
                          <button
                            className="btn-ghost kanban-card-action kanban-card-action-danger"
                            data-tooltip="Archive"
                            title="Archive"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleArchive(task);
                            }}
                            disabled={actionBusy === task.id}
                          >
                            <Trash size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {showCreate && (
        <div
          className="skills-detail-overlay"
          onClick={() => setShowCreate(false)}
        >
          <div className="schedules-modal" onClick={(e) => e.stopPropagation()}>
            <div className="schedules-modal-header">
              <span>New kanban task</span>
              <button
                className="btn-ghost"
                onClick={() => setShowCreate(false)}
              >
                <X size={14} />
              </button>
            </div>
            <div className="schedules-modal-body">
              <div className="schedules-field">
                <label className="schedules-field-label">Title</label>
                <input
                  className="input"
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="What needs to be done?"
                  autoFocus
                />
              </div>
              <div className="schedules-field">
                <label className="schedules-field-label">Body (optional)</label>
                <textarea
                  className="input schedules-textarea"
                  rows={4}
                  value={newBody}
                  onChange={(e) => setNewBody(e.target.value)}
                  placeholder="Context, acceptance criteria, links…"
                />
              </div>
              <div className="schedules-field">
                <label className="schedules-field-label">
                  Assignee profile
                </label>
                <select
                  className="input"
                  aria-label="Assignee profile"
                  value={newAssignee}
                  onChange={(e) => setNewAssignee(e.target.value)}
                >
                  <option value="">— Triage (no assignee)</option>
                  {profileOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="schedules-field">
                <label className="schedules-field-label">Priority</label>
                <select
                  className="input"
                  aria-label="Priority"
                  value={newPriority}
                  onChange={(e) => setNewPriority(e.target.value)}
                >
                  <option value="0">Normal (0)</option>
                  <option value="1">Low (P2)</option>
                  <option value="5">High (P1)</option>
                  <option value="10">Urgent (P0)</option>
                </select>
              </div>
              <div className="schedules-field">
                <label className="schedules-field-label">Workspace</label>
                <select
                  className="input"
                  aria-label="Workspace"
                  value={newWorkspace}
                  onChange={(e) => setNewWorkspace(e.target.value)}
                >
                  <option value="scratch">Scratch (temp dir)</option>
                  <option value="worktree">Worktree (current repo)</option>
                  <option value="dir">Choose folder…</option>
                </select>
                {newWorkspace === "dir" && (
                  <div className="kanban-folder-picker">
                    <input
                      className="input"
                      type="text"
                      value={newWorkspaceDir}
                      onChange={(e) => setNewWorkspaceDir(e.target.value)}
                      placeholder="No folder selected"
                      readOnly
                    />
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handlePickWorkspaceFolder}
                    >
                      Browse…
                    </button>
                  </div>
                )}
              </div>
              <div className="schedules-field">
                <label className="schedules-field-label kanban-checkbox-label">
                  <input
                    type="checkbox"
                    checked={newTriage}
                    onChange={(e) => setNewTriage(e.target.checked)}
                  />
                  <span>
                    Park in triage (a specifier expands the spec before
                    promoting to to-do)
                  </span>
                </label>
              </div>
            </div>
            <div className="schedules-modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleCreate}
                disabled={!newTitle.trim() || actionBusy === "create"}
              >
                {actionBusy === "create" ? "Creating…" : "Create task"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showNewBoard && (
        <div
          className="skills-detail-overlay"
          onClick={() => setShowNewBoard(false)}
        >
          <div className="schedules-modal" onClick={(e) => e.stopPropagation()}>
            <div className="schedules-modal-header">
              <span>New board</span>
              <button
                className="btn-ghost"
                onClick={() => setShowNewBoard(false)}
              >
                <X size={14} />
              </button>
            </div>
            <div className="schedules-modal-body">
              <div className="schedules-field">
                <label className="schedules-field-label">Slug</label>
                <input
                  className="input"
                  type="text"
                  value={newBoardSlug}
                  onChange={(e) => setNewBoardSlug(e.target.value)}
                  placeholder="kebab-case, e.g. atm10-server"
                  autoFocus
                />
              </div>
              <div className="schedules-field">
                <label className="schedules-field-label">
                  Display name (optional)
                </label>
                <input
                  className="input"
                  type="text"
                  value={newBoardName}
                  onChange={(e) => setNewBoardName(e.target.value)}
                  placeholder="ATM10 Server"
                />
              </div>
            </div>
            <div className="schedules-modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => setShowNewBoard(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleCreateBoard}
                disabled={!newBoardSlug.trim() || actionBusy === "board-create"}
              >
                {actionBusy === "board-create" ? "Creating…" : "Create board"}
              </button>
            </div>
          </div>
        </div>
      )}

      {detailTaskId && (
        <div
          className="skills-detail-overlay"
          onClick={() => setDetailTaskId(null)}
        >
          <div
            className="schedules-modal kanban-detail-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="schedules-modal-header">
              <span>{detail?.task.title || "Task"}</span>
              <button
                className="btn-ghost"
                title="Close task details"
                onClick={() => setDetailTaskId(null)}
              >
                <X size={14} />
              </button>
            </div>
            <div className="schedules-modal-body">
              {detailLoading && <div className="loading-spinner" />}
              {detail && (
                <>
                  <div className="kanban-detail-meta">
                    <span className="kanban-pill">{detail.task.status}</span>
                    {detail.task.assignee && (
                      <span className="kanban-pill">
                        @{detail.task.assignee}
                      </span>
                    )}
                    {detail.task.tenant && (
                      <span className="kanban-pill">{detail.task.tenant}</span>
                    )}
                    <span className="kanban-pill kanban-pill-id">
                      {detail.task.id}
                    </span>
                  </div>
                  {detail.task.body && (
                    <div className="kanban-detail-section">
                      <label>Body</label>
                      <pre className="kanban-detail-pre">
                        {detail.task.body}
                      </pre>
                    </div>
                  )}
                  {detail.latest_summary && (
                    <div className="kanban-detail-section">
                      <label>Latest run summary</label>
                      <pre className="kanban-detail-pre">
                        {detail.latest_summary}
                      </pre>
                    </div>
                  )}
                  {detail.task.result && (
                    <div className="kanban-detail-section">
                      <label>Result</label>
                      <pre className="kanban-detail-pre">
                        {detail.task.result}
                      </pre>
                    </div>
                  )}
                  {detail.comments.length > 0 && (
                    <div className="kanban-detail-section">
                      <label>Comments ({detail.comments.length})</label>
                      {detail.comments.map((c) => (
                        <div key={c.id} className="kanban-comment">
                          <div className="kanban-comment-author">
                            {c.author || "anon"}
                          </div>
                          <div className="kanban-comment-body">{c.body}</div>
                        </div>
                      ))}
                    </div>
                  )}
                  {detail.events.length > 0 && (
                    <div className="kanban-detail-section">
                      <label>Events ({detail.events.length})</label>
                      <div className="kanban-events">
                        {detail.events
                          .slice(-12)
                          .reverse()
                          .map((ev) => (
                            <div key={ev.id} className="kanban-event">
                              <span className="kanban-pill">{ev.kind}</span>
                              <span className="kanban-event-time">
                                {ageLabel(ev.created_at)}
                              </span>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Kanban;
