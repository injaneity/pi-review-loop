import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/go/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/java/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/kotlin/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/languages/definitions/python/register.js";
import "monaco-editor/languages/definitions/rust/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";
import type { ChangedFile, FileContents, HostMessage, ReviewComment, ReviewMode, WorkspaceState } from "../../src/types.js";

declare global {
  interface Window {
    glimpse?: { send(message: unknown): void };
    __reviewReceive(message: HostMessage): void;
    MonacoEnvironment: { getWorker(): Worker };
  }
}

window.MonacoEnvironment = {
  getWorker: () => new Worker(new URL("./editor.worker.js", import.meta.url)),
};

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (element == null) throw new Error(`Missing #${id}`);
  return element as T;
};

const repoNameEl = byId("repo-name");
const repoMetaEl = byId("repo-meta");
const checkpointButton = byId<HTMLButtonElement>("mode-checkpoint");
const headButton = byId<HTMLButtonElement>("mode-head");
const submitButton = byId<HTMLButtonElement>("submit-review");
const searchInput = byId<HTMLInputElement>("search");
const recentCountEl = byId("recent-count");
const fileCountEl = byId("file-count");
const recentListEl = byId("recent-list");
const fileTreeEl = byId("file-tree");
const filePathEl = byId("file-path");
const fileStatusEl = byId("file-status");
const fileCommentButton = byId<HTMLButtonElement>("file-comment");
const emptyStateEl = byId("empty-state");
const editorEl = byId("editor");
const feedbackPanelEl = byId("feedback-panel");
const feedbackTitleEl = byId("feedback-title");
const commentListEl = byId("comment-list");
const draftRowEl = byId("draft-row");
const draftLocationEl = byId("draft-location");
const draftInput = byId<HTMLTextAreaElement>("draft-input");
const addCommentButton = byId<HTMLButtonElement>("add-comment");
const cancelDraftButton = byId<HTMLButtonElement>("cancel-draft");
const toastEl = byId("toast");

let workspace: WorkspaceState | null = null;
let activePath: string | null = null;
let mountedFingerprint = "";
let activeRequestId = "";
let requestCounter = 0;
let comments: ReviewComment[] = [];
let draft: Omit<ReviewComment, "body"> | null = null;
let pendingOpenPath: string | null = null;
let toastTimer = 0;
const collapsedDirs = new Set<string>();

monaco.editor.defineTheme("review-loop", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "667085" },
    { token: "keyword", foreground: "BB9AF7" },
    { token: "string", foreground: "9ECE6A" },
    { token: "number", foreground: "FF9E64" },
    { token: "type", foreground: "7DCFFF" },
  ],
  colors: {
    "editor.background": "#0d1016",
    "editorGutter.background": "#0d1016",
    "editorLineNumber.foreground": "#465064",
    "editorLineNumber.activeForeground": "#9aa5b5",
    "editor.selectionBackground": "#33415c88",
    "editor.lineHighlightBackground": "#151a23",
    "diffEditor.insertedTextBackground": "#2d6a4f38",
    "diffEditor.removedTextBackground": "#8f3a4b38",
    "diffEditor.insertedLineBackground": "#19382c55",
    "diffEditor.removedLineBackground": "#41212a55",
    "diffEditor.diagonalFill": "#202734",
    "scrollbarSlider.background": "#30394988",
    "scrollbarSlider.hoverBackground": "#3d485bAA",
    "editorOverviewRuler.border": "#00000000",
  },
});
monaco.editor.setTheme("review-loop");

const diffEditor = monaco.editor.createDiffEditor(editorEl, {
  readOnly: true,
  originalEditable: false,
  automaticLayout: true,
  renderSideBySide: true,
  enableSplitViewResizing: true,
  minimap: { enabled: false },
  glyphMargin: true,
  folding: true,
  lineNumbersMinChars: 3,
  lineDecorationsWidth: 8,
  scrollBeyondLastLine: false,
  renderOverviewRuler: false,
  overviewRulerBorder: false,
  wordWrap: "off",
  diffWordWrap: "off",
  hideUnchangedRegions: { enabled: false },
  padding: { top: 8, bottom: 8 },
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  fontSize: 12,
  lineHeight: 19,
});

let originalModel: monaco.editor.ITextModel | null = null;
let modifiedModel: monaco.editor.ITextModel | null = null;
let originalDecorations: string[] = [];
let modifiedDecorations: string[] = [];

function send(message: unknown): void {
  window.glimpse?.send(message);
}

function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.add("visible");
  toastTimer = window.setTimeout(() => toastEl.classList.remove("visible"), 2200);
}

function statusLetter(status: ChangedFile["status"]): string {
  return status === "modified" ? "M" : status === "added" ? "A" : "D";
}

function statusSpan(file: ChangedFile): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = `status ${file.status}`;
  span.textContent = statusLetter(file.status);
  return span;
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

function parent(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function relativeTime(value?: number): string {
  if (!value) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function matches(file: ChangedFile): boolean {
  const query = searchInput.value.trim().toLowerCase();
  return !query || file.path.toLowerCase().includes(query);
}

function selectPath(path: string, preferCheckpoint = false): void {
  if (workspace == null) return;
  const inCurrentMode = workspace.files.some((file) => file.path === path);
  if (!inCurrentMode && preferCheckpoint && workspace.mode !== "checkpoint") {
    pendingOpenPath = path;
    send({ type: "set-mode", mode: "checkpoint" });
    return;
  }
  if (!inCurrentMode) return;
  activePath = path;
  mountedFingerprint = "";
  render();
  requestActiveFile();
}

function makeRecentRow(file: ChangedFile): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = `file-row${file.path === activePath ? " active" : ""}`;
  button.append(statusSpan(file));
  const copy = document.createElement("span");
  copy.className = "copy";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = basename(file.path);
  const pathParent = document.createElement("span");
  pathParent.className = "parent";
  pathParent.textContent = parent(file.path);
  copy.append(name, pathParent);
  const time = document.createElement("time");
  time.textContent = relativeTime(file.recentAt);
  button.append(copy, time);
  button.addEventListener("click", () => selectPath(file.path, true));
  return button;
}

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file?: ChangedFile;
}

function buildTree(files: ChangedFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const file of files) {
    let node = root;
    let path = "";
    const parts = file.path.split("/");
    parts.forEach((name, index) => {
      path = path ? `${path}/${name}` : name;
      let child = node.children.get(name);
      if (child == null) {
        child = { name, path, children: new Map() };
        node.children.set(name, child);
      }
      if (index === parts.length - 1) child.file = file;
      node = child;
    });
  }
  return root;
}

function appendTree(node: TreeNode, depth: number): void {
  const children = [...node.children.values()].sort((a, b) => {
    if (!!a.file !== !!b.file) return a.file ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  for (const child of children) {
    if (child.file) {
      const row = document.createElement("button");
      row.className = `tree-row${child.file.path === activePath ? " active" : ""}`;
      row.style.paddingLeft = `${8 + depth * 12}px`;
      row.append(statusSpan(child.file));
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = child.name;
      row.append(label);
      if (workspace?.recentPaths.includes(child.file.path)) {
        const dot = document.createElement("span");
        dot.className = "recent-dot";
        row.append(dot);
      }
      row.addEventListener("click", () => selectPath(child.file!.path));
      fileTreeEl.append(row);
      continue;
    }

    const collapsed = collapsedDirs.has(child.path);
    const row = document.createElement("button");
    row.className = "tree-row directory";
    row.style.paddingLeft = `${8 + depth * 12}px`;
    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.textContent = collapsed ? "▶" : "▼";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = child.name;
    row.append(chevron, label);
    row.addEventListener("click", () => {
      collapsed ? collapsedDirs.delete(child.path) : collapsedDirs.add(child.path);
      renderTree();
    });
    fileTreeEl.append(row);
    if (!collapsed) appendTree(child, depth + 1);
  }
}

function renderRecent(): void {
  if (workspace == null) return;
  recentListEl.replaceChildren();
  const pending = new Map(workspace.pendingFiles.map((file) => [file.path, file]));
  const files = workspace.recentPaths.map((path) => pending.get(path)).filter((file): file is ChangedFile => file != null).filter(matches);
  recentCountEl.textContent = files.length ? String(files.length) : "";
  if (files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = workspace.pendingFiles.length ? "No recent matches" : "No new changes";
    recentListEl.append(empty);
    return;
  }
  files.forEach((file) => recentListEl.append(makeRecentRow(file)));
}

function renderTree(): void {
  if (workspace == null) return;
  fileTreeEl.replaceChildren();
  const files = workspace.files.filter(matches);
  fileCountEl.textContent = String(files.length);
  if (files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = searchInput.value ? "No matching files" : workspace.mode === "checkpoint" ? "Nothing since the last review" : "Working tree is clean";
    fileTreeEl.append(empty);
    return;
  }
  appendTree(buildTree(files), 0);
}

function updateSubmitButton(): void {
  const count = workspace?.pendingFiles.length ?? 0;
  const commentCount = comments.length;
  submitButton.disabled = count === 0 && commentCount === 0;
  if (commentCount > 0) submitButton.textContent = `Submit ${commentCount} comment${commentCount === 1 ? "" : "s"} · review ${count}`;
  else if (count > 0) submitButton.textContent = `Mark ${count} reviewed`;
  else submitButton.textContent = "Mark reviewed";
}

function updateHeader(): void {
  if (workspace == null) return;
  repoNameEl.textContent = workspace.repoName;
  const baseline = workspace.hasCheckpoint && workspace.checkpointCreatedAt
    ? `reviewed ${relativeTime(workspace.checkpointCreatedAt)} ago`
    : "not reviewed yet";
  repoMetaEl.textContent = [workspace.branch, baseline].filter(Boolean).join(" · ");
  checkpointButton.classList.toggle("active", workspace.mode === "checkpoint");
  headButton.classList.toggle("active", workspace.mode === "head");
}

function activeFile(): ChangedFile | null {
  return workspace?.files.find((file) => file.path === activePath) ?? null;
}

function renderFilebar(): void {
  const file = activeFile();
  fileStatusEl.className = file ? `status ${file.status}` : "status";
  fileStatusEl.textContent = file ? statusLetter(file.status) : "";
  filePathEl.textContent = file?.path ?? "No changes to review";
  fileCommentButton.disabled = file == null;
}

function render(): void {
  if (workspace == null) return;
  updateHeader();
  renderRecent();
  renderTree();
  renderFilebar();
  updateSubmitButton();

  const file = activeFile();
  emptyStateEl.classList.toggle("hidden", file != null);
  editorEl.classList.toggle("hidden", file == null);
  if (file == null) disposeModels();
  renderFeedback();
}

function inferLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return ({
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    json: "json", css: "css", html: "html", htm: "html", md: "markdown", py: "python", rs: "rust",
    go: "go", java: "java", kt: "kotlin", sh: "shell", bash: "shell", yml: "yaml", yaml: "yaml",
  } as Record<string, string>)[ext ?? ""] ?? "plaintext";
}

function disposeModels(): void {
  diffEditor.setModel(null);
  originalModel?.dispose();
  modifiedModel?.dispose();
  originalModel = null;
  modifiedModel = null;
  mountedFingerprint = "";
}

function mountFile(file: FileContents): void {
  if (file.path !== activePath || workspace?.mode !== file.mode) return;
  const scrollTop = diffEditor.getModifiedEditor().getScrollTop();
  disposeModels();
  const language = inferLanguage(file.path);
  originalModel = monaco.editor.createModel(file.originalContent, language);
  modifiedModel = monaco.editor.createModel(file.modifiedContent, language);
  diffEditor.setModel({ original: originalModel, modified: modifiedModel });
  mountedFingerprint = file.fingerprint;
  renderDecorations();
  requestAnimationFrame(() => diffEditor.getModifiedEditor().setScrollTop(scrollTop));
}

function requestActiveFile(): void {
  const file = activeFile();
  if (file == null || file.fingerprint === mountedFingerprint) return;
  activeRequestId = `file:${++requestCounter}`;
  send({ type: "request-file", requestId: activeRequestId, path: file.path, mode: workspace!.mode });
}

function commentLocation(comment: ReviewComment): string {
  if (comment.side === "file" || comment.line == null) return comment.path;
  return `${comment.path}:${comment.line} ${comment.side === "original" ? "reviewed" : "current"}`;
}

function renderFeedback(): void {
  const visible = comments.length > 0 || draft != null;
  feedbackPanelEl.classList.toggle("hidden", !visible);
  feedbackTitleEl.textContent = comments.length ? `Feedback · ${comments.length}` : "Feedback";
  commentListEl.replaceChildren();
  comments.forEach((comment, index) => {
    const row = document.createElement("div");
    row.className = "comment";
    const location = document.createElement("div");
    location.className = "comment-location";
    location.textContent = commentLocation(comment);
    location.title = commentLocation(comment);
    const body = document.createElement("div");
    body.className = "comment-body";
    body.textContent = comment.body;
    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.title = "Delete comment";
    remove.addEventListener("click", () => {
      comments.splice(index, 1);
      renderFeedback();
      updateSubmitButton();
      renderDecorations();
    });
    row.append(location, body, remove);
    commentListEl.append(row);
  });

  draftRowEl.classList.toggle("hidden", draft == null);
  cancelDraftButton.classList.toggle("hidden", draft == null);
  if (draft != null) draftLocationEl.textContent = commentLocation({ ...draft, body: "" });
}

function openDraft(side: ReviewComment["side"], line: number | null): void {
  if (activePath == null) return;
  draft = { path: activePath, side, line };
  draftInput.value = "";
  renderFeedback();
  requestAnimationFrame(() => draftInput.focus());
}

function addDraft(): void {
  const body = draftInput.value.trim();
  if (draft == null || !body) return;
  comments.push({ ...draft, body });
  draft = null;
  draftInput.value = "";
  renderFeedback();
  updateSubmitButton();
  renderDecorations();
}

function renderDecorations(): void {
  const pathComments = comments.filter((comment) => comment.path === activePath && comment.line != null && comment.side !== "file");
  const original = pathComments.filter((comment) => comment.side === "original").map((comment) => ({
    range: new monaco.Range(comment.line!, 1, comment.line!, 1),
    options: { isWholeLine: true, glyphMarginClassName: "review-comment-glyph" },
  }));
  const modified = pathComments.filter((comment) => comment.side === "modified").map((comment) => ({
    range: new monaco.Range(comment.line!, 1, comment.line!, 1),
    options: { isWholeLine: true, glyphMarginClassName: "review-comment-glyph" },
  }));
  if (originalModel) originalDecorations = diffEditor.getOriginalEditor().deltaDecorations(originalDecorations, original);
  if (modifiedModel) modifiedDecorations = diffEditor.getModifiedEditor().deltaDecorations(modifiedDecorations, modified);
}

function installGutterComments(editor: monaco.editor.ICodeEditor, side: "original" | "modified"): void {
  editor.onMouseDown((event) => {
    const target = event.target;
    const gutter = target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS || target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN;
    if (gutter && target.position?.lineNumber) openDraft(side, target.position.lineNumber);
  });
}
installGutterComments(diffEditor.getOriginalEditor(), "original");
installGutterComments(diffEditor.getModifiedEditor(), "modified");

window.__reviewReceive = (message: HostMessage): void => {
  if (message.type === "workspace") {
    const previousPath = activePath;
    workspace = message.state;
    if (pendingOpenPath && workspace.files.some((file) => file.path === pendingOpenPath)) {
      activePath = pendingOpenPath;
      pendingOpenPath = null;
    } else if (!activePath || !workspace.files.some((file) => file.path === activePath)) {
      activePath = workspace.recentPaths.find((path) => workspace!.files.some((file) => file.path === path)) ?? workspace.files[0]?.path ?? null;
    }
    const file = activeFile();
    if (previousPath !== activePath || file?.fingerprint !== mountedFingerprint) mountedFingerprint = "";
    render();
    requestActiveFile();
    return;
  }
  if (message.type === "file") {
    if (message.requestId === activeRequestId) mountFile(message.file);
    return;
  }
  if (message.type === "file-error") {
    if (message.requestId === activeRequestId) showToast(message.message);
    return;
  }
  if (message.type === "review-submitted") {
    comments = [];
    draft = null;
    submitButton.disabled = false;
    renderFeedback();
    updateSubmitButton();
    showToast(message.insertedFeedback ? "Checkpoint saved · feedback inserted into pi" : "Checkpoint saved");
  }
};

checkpointButton.addEventListener("click", () => send({ type: "set-mode", mode: "checkpoint" as ReviewMode }));
headButton.addEventListener("click", () => send({ type: "set-mode", mode: "head" as ReviewMode }));
searchInput.addEventListener("input", () => { renderRecent(); renderTree(); });
fileCommentButton.addEventListener("click", () => openDraft("file", null));
addCommentButton.addEventListener("click", addDraft);
cancelDraftButton.addEventListener("click", () => {
  draft = null;
  draftInput.value = "";
  renderFeedback();
});
draftInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    addDraft();
  }
  if (event.key === "Escape") {
    draft = null;
    renderFeedback();
  }
});
submitButton.addEventListener("click", () => {
  if (submitButton.disabled) return;
  submitButton.disabled = true;
  submitButton.textContent = "Saving…";
  send({ type: "submit-review", comments });
  window.setTimeout(() => updateSubmitButton(), 5000);
});
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});
window.setInterval(renderRecent, 10_000);

send({ type: "ready" });
