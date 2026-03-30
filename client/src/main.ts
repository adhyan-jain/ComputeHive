import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

type Mode = "user" | "contributor";
type BundleStatus = "idle" | "ready" | "working" | "done" | "error";

interface BundleResult {
  projectName: string;
  projectRoot: string;
  archivePath: string;
  sourceSizeBytes: number;
  archiveSizeBytes: number;
  includedFiles: number;
  skippedEntries: string[];
  summary: string;
  spaceSavedPercent: number;
}

interface ContributorWorker {
  id: string;
  project: string;
  owner: string;
  stack: string;
  size: string;
  status: string;
  folder: string;
}

interface InterfaceCopy {
  eyebrow: string;
  heading: string;
  copy: string;
}

const interfaceCopy: Record<Mode, InterfaceCopy> = {
  user: {
    eyebrow: "Project Upload Flow",
    heading:
      "Prepare project folders for compute handoff without leaving the desktop app.",
    copy:
      "Choose a project directory, compress it into a lean archive that stays beside the source folder, and keep the contributor Docker work reserved under Contributor Actions.",
  },
  contributor: {
    eyebrow: "Contributor Resource Flow",
    heading:
      "Track incoming workers that will later run on contributor machines.",
    copy:
      "Use the contributor dashboard to inspect queued worker packages now, while the future Docker build and runtime lifecycle remains intentionally deferred under Contributor Actions.",
  },
};

const contributorWorkers: ContributorWorker[] = [
  {
    id: "wrk-1042",
    project: "genome-assembler",
    owner: "Aarav S.",
    stack: "Python + CUDA",
    size: "284 MB bundle",
    status: "Ready for contributor actions",
    folder: "/incoming/workers/genome-assembler",
  },
  {
    id: "wrk-1058",
    project: "mesh-render-lab",
    owner: "Mira D.",
    stack: "Rust",
    size: "96 MB bundle",
    status: "Waiting for local runtime setup",
    folder: "/incoming/workers/mesh-render-lab",
  },
  {
    id: "wrk-1081",
    project: "signal-forecast",
    owner: "Karan P.",
    stack: "Node.js",
    size: "61 MB bundle",
    status: "Queued for validation",
    folder: "/incoming/workers/signal-forecast",
  },
];

function getElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element for selector: ${selector}`);
  }
  return element;
}

const modeEyebrow = getElement<HTMLElement>("#mode-eyebrow");
const modeHeading = getElement<HTMLElement>("#mode-heading");
const modeCopy = getElement<HTMLElement>("#mode-copy");
const modeButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-mode]"),
);
const workflowPanels = Array.from(
  document.querySelectorAll<HTMLElement>("[data-panel]"),
);
const selectedPath = getElement<HTMLElement>("#selected-path");
const pickFolderButton = getElement<HTMLButtonElement>("#pick-folder");
const prepareBundleButton =
  getElement<HTMLButtonElement>("#prepare-bundle");
const clearSelectionButton =
  getElement<HTMLButtonElement>("#clear-selection");
const bundleStatus = getElement<HTMLElement>("#bundle-status");
const bundleSummaryTitle =
  getElement<HTMLElement>("#bundle-summary-title");
const bundleSummary = getElement<HTMLElement>("#bundle-summary");
const archivePath = getElement<HTMLElement>("#archive-path");
const includedFiles = getElement<HTMLElement>("#included-files");
const sourceSize = getElement<HTMLElement>("#source-size");
const archiveSize = getElement<HTMLElement>("#archive-size");
const spaceSaved = getElement<HTMLElement>("#space-saved");
const skippedList = getElement<HTMLUListElement>("#skipped-list");
const workerQueue = getElement<HTMLElement>("#worker-queue");

const state: {
  mode: Mode;
  selectedPath: string;
  bundleStatus: BundleStatus;
  result: BundleResult | null;
  error: string;
} = {
  mode: "user",
  selectedPath: "",
  bundleStatus: "idle",
  result: null,
  error: "",
};

function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function statusLabel(status: BundleStatus): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "ready":
      return "Ready";
    case "working":
      return "Compressing";
    case "done":
      return "Archived";
    case "error":
      return "Attention";
  }
}

function statusHeadline(status: BundleStatus): string {
  switch (status) {
    case "idle":
      return "Waiting for a folder";
    case "ready":
      return "Ready to prepare the bundle";
    case "working":
      return "Compressing the selected folder";
    case "done":
      return "Bundle prepared successfully";
    case "error":
      return "Bundle preparation needs attention";
  }
}

function statusSummary(): string {
  if (state.error) {
    return state.error;
  }

  if (state.result) {
    return state.result.summary;
  }

  if (state.bundleStatus === "ready") {
    return "The folder is selected. Run the bundle preparation to create a compressed archive in that directory.";
  }

  if (state.bundleStatus === "working") {
    return "ComputeHive is compressing the selected project and trimming common generated directories from the upload bundle.";
  }

  return "Pick a project directory to prepare a compressed upload bundle.";
}

function renderSkippedEntries(entries: string[]): void {
  skippedList.replaceChildren();

  if (entries.length === 0) {
    const item = document.createElement("li");
    item.textContent =
      "Generated folders like node_modules and target are skipped automatically.";
    skippedList.append(item);
    return;
  }

  const visibleEntries = entries.slice(0, 6);
  visibleEntries.forEach((entry) => {
    const item = document.createElement("li");
    item.textContent = entry;
    skippedList.append(item);
  });

  if (entries.length > visibleEntries.length) {
    const item = document.createElement("li");
    item.textContent = `+${entries.length - visibleEntries.length} more skipped paths`;
    skippedList.append(item);
  }
}

function renderContributorQueue(): void {
  workerQueue.replaceChildren();

  contributorWorkers.forEach((worker) => {
    const card = document.createElement("article");
    card.className = "queue-card";

    const topRow = document.createElement("div");
    topRow.className = "queue-top";

    const titleWrap = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = worker.project;
    const subhead = document.createElement("p");
    subhead.className = "queue-owner";
    subhead.textContent = `${worker.id} · submitted by ${worker.owner}`;
    titleWrap.append(title, subhead);

    const badge = document.createElement("span");
    badge.className = "queue-badge";
    badge.textContent = worker.status;

    topRow.append(titleWrap, badge);

    const meta = document.createElement("div");
    meta.className = "queue-meta";
    meta.innerHTML = `
      <div><span>Stack</span><strong>${worker.stack}</strong></div>
      <div><span>Bundle size</span><strong>${worker.size}</strong></div>
      <div><span>Folder target</span><strong>${worker.folder}</strong></div>
    `;

    card.append(topRow, meta);
    workerQueue.append(card);
  });
}

function renderMode(): void {
  const copy = interfaceCopy[state.mode];
  modeEyebrow.textContent = copy.eyebrow;
  modeHeading.textContent = copy.heading;
  modeCopy.textContent = copy.copy;

  modeButtons.forEach((button) => {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });

  workflowPanels.forEach((panel) => {
    const active = panel.dataset.panel === state.mode;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  });
}

function renderUserState(): void {
  selectedPath.textContent = state.selectedPath || "No folder selected yet";
  selectedPath.classList.toggle("is-empty", state.selectedPath.length === 0);

  const canPrepare =
    state.selectedPath.length > 0 && state.bundleStatus !== "working";
  prepareBundleButton.disabled = !canPrepare;
  pickFolderButton.disabled = state.bundleStatus === "working";
  clearSelectionButton.disabled = state.bundleStatus === "working";
  prepareBundleButton.textContent =
    state.bundleStatus === "working"
      ? "Preparing upload bundle..."
      : "Prepare upload bundle";

  bundleStatus.className = `status-pill status-${state.bundleStatus}`;
  bundleStatus.textContent = statusLabel(state.bundleStatus);
  bundleSummaryTitle.textContent = statusHeadline(state.bundleStatus);
  bundleSummary.textContent = statusSummary();

  if (state.result) {
    archivePath.textContent = state.result.archivePath;
    includedFiles.textContent = state.result.includedFiles.toString();
    sourceSize.textContent = formatBytes(state.result.sourceSizeBytes);
    archiveSize.textContent = formatBytes(state.result.archiveSizeBytes);
    spaceSaved.textContent = `${state.result.spaceSavedPercent.toFixed(1)}%`;
    renderSkippedEntries(state.result.skippedEntries);
    return;
  }

  archivePath.textContent =
    "The archive path will appear here after compression.";
  includedFiles.textContent = "0";
  sourceSize.textContent = "0 B";
  archiveSize.textContent = "0 B";
  spaceSaved.textContent = "0%";
  renderSkippedEntries([]);
}

async function pickProjectFolder(): Promise<void> {
  const folder = await open({
    directory: true,
    multiple: false,
    title: "Select the project folder to compress",
  });

  if (typeof folder !== "string") {
    return;
  }

  state.selectedPath = folder;
  state.bundleStatus = "ready";
  state.result = null;
  state.error = "";
  renderUserState();
}

async function prepareProjectBundle(): Promise<void> {
  if (!state.selectedPath) {
    return;
  }

  state.bundleStatus = "working";
  state.result = null;
  state.error = "";
  renderUserState();

  try {
    const result = await invoke<BundleResult>("prepare_project_bundle", {
      projectPath: state.selectedPath,
    });

    state.result = result;
    state.bundleStatus = "done";
  } catch (error) {
    state.error =
      error instanceof Error ? error.message : String(error);
    state.bundleStatus = "error";
  }

  renderUserState();
}

function clearSelection(): void {
  state.selectedPath = "";
  state.bundleStatus = "idle";
  state.result = null;
  state.error = "";
  renderUserState();
}

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const nextMode = button.dataset.mode;
    if (nextMode === "user" || nextMode === "contributor") {
      state.mode = nextMode;
      renderMode();
    }
  });
});

pickFolderButton.addEventListener("click", () => {
  void pickProjectFolder();
});

prepareBundleButton.addEventListener("click", () => {
  void prepareProjectBundle();
});

clearSelectionButton.addEventListener("click", clearSelection);

renderMode();
renderUserState();
renderContributorQueue();
