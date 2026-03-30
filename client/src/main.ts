import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";

type Mode = "user" | "contributor";
type BuildStatus = "idle" | "ready" | "working" | "done" | "error";
type ProcessLogTone = "info" | "working" | "success" | "error";

interface DockerImageResult {
  projectName: string;
  projectRoot: string;
  dockerfilePath: string;
  imageArchivePath: string;
  imageTag: string;
  imageSizeBytes: number;
  detectedStack: string;
  dockerSetupSource: string;
  generatedFiles: string[];
  summary: string;
  notes: string[];
}

interface RunRequestResult {
  image: DockerImageResult;
  gzipArchivePath: string;
  gzipSizeBytes: number;
  artifactSha256: string;
  artifactObjectKey: string;
  artifactUri: string;
  artifactApiUrl: string;
  artifactPublicUrl: string;
  artifactRecordKey: string;
  artifactEtag?: string | null;
  redisJobId: string;
  redisJobKey: string;
  redisStatusKey: string;
  redisQueueKey: string;
  summary: string;
  notes: string[];
}

interface IncomingRunRequest {
  jobId: string;
  projectName: string;
  detectedStack: string;
  status: string;
  containerImage: string;
  artifactSha256: string;
  artifactObjectKey: string;
  artifactUri: string;
  artifactApiUrl: string;
  artifactPublicUrl: string;
  gzipArchivePath: string;
  gzipSizeBytes: number;
  createdAtUnix: number;
  projectRoot: string;
}

interface ContributorWorkerProfile {
  workerId: string;
  name: string;
  email: string;
  location: string;
  workerVersion: string;
  availableCpuCores: number;
  availableGpuCount: number;
  availableMemoryMb: number;
  availableStorageGb: number;
}

interface ProcessLogEntry {
  id: number;
  tone: ProcessLogTone;
  message: string;
  timestamp: string;
}

interface InterfaceCopy {
  eyebrow: string;
  heading: string;
  copy: string;
}

const interfaceCopy: Record<Mode, InterfaceCopy> = {
  user: {
    eyebrow: "Project flow",
    heading: "Compile Hive",
    copy:
      "Choose a project directory. ComputeHive prepares Docker when needed, builds the image, compresses the artifact, uploads it, and writes the queue record.",
  },
  contributor: {
    eyebrow: "Contributor flow",
    heading: "Compile Hive",
    copy:
      "Inspect queued run requests from Redis. Each request carries the artifact location and SHA-256 hash that contributors can verify before later contributor actions run it.",
  },
};

const modeBurstTimers = new WeakMap<HTMLButtonElement, number>();
const processLogTimers = new Set<number>();
let nextProcessLogId = 1;
let renderedProcessLogCount = 0;

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
const requestRunButton = getElement<HTMLButtonElement>("#request-run");
const revealFolderButton =
  getElement<HTMLButtonElement>("#reveal-folder");
const clearSelectionButton =
  getElement<HTMLButtonElement>("#clear-selection");
const processLog = getElement<HTMLElement>("#process-log");
const processLogStatus =
  getElement<HTMLElement>("#process-log-status");
const bundleStatus = getElement<HTMLElement>("#bundle-status");
const bundleSummaryTitle =
  getElement<HTMLElement>("#bundle-summary-title");
const bundleSummary = getElement<HTMLElement>("#bundle-summary");
const imageOutputPath = getElement<HTMLElement>("#image-output-path");
const gzipOutputPath = getElement<HTMLElement>("#gzip-output-path");
const artifactHash = getElement<HTMLElement>("#artifact-hash");
const runRequestDetails =
  getElement<HTMLElement>("#run-request-details");
const artifactPublicLink =
  getElement<HTMLAnchorElement>("#artifact-public-link");
const detectedStack = getElement<HTMLElement>("#detected-stack");
const imageTag = getElement<HTMLElement>("#image-tag");
const imageSize = getElement<HTMLElement>("#image-size");
const dockerSetupSource =
  getElement<HTMLElement>("#docker-setup-source");
const buildNotes = getElement<HTMLUListElement>("#build-notes");
const workerQueue = getElement<HTMLElement>("#worker-queue");
const refreshWorkersButton =
  getElement<HTMLButtonElement>("#refresh-workers");
const contributorSignupForm =
  getElement<HTMLFormElement>("#contributor-signup-form");
const contributorNameInput =
  getElement<HTMLInputElement>("#contributor-name");
const contributorEmailInput =
  getElement<HTMLInputElement>("#contributor-email");
const contributorLocationInput =
  getElement<HTMLInputElement>("#contributor-location");
const contributorSignupSubmit =
  getElement<HTMLButtonElement>("#contributor-signup-submit");
const contributorSetupStatus =
  getElement<HTMLElement>("#contributor-setup-status");
const contributorProfileCard =
  getElement<HTMLElement>("#contributor-profile-card");
const profileWorkerId =
  getElement<HTMLElement>("#profile-worker-id");
const profileContributorName =
  getElement<HTMLElement>("#profile-contributor-name");
const profileContributorEmail =
  getElement<HTMLElement>("#profile-contributor-email");
const profileContributorLocation =
  getElement<HTMLElement>("#profile-contributor-location");
const profileContributorResources =
  getElement<HTMLElement>("#profile-contributor-resources");

const state: {
  mode: Mode;
  selectedPath: string;
  buildStatus: BuildStatus;
  buildResult: DockerImageResult | null;
  runResult: RunRequestResult | null;
  error: string;
  contributorRequests: IncomingRunRequest[];
  contributorLoading: boolean;
  contributorError: string;
  contributorProfile: ContributorWorkerProfile | null;
  contributorSetupLoading: boolean;
  contributorSetupMessage: string;
  contributorSetupError: string;
  logEntries: ProcessLogEntry[];
  logStage: string;
} = {
  mode: "user",
  selectedPath: "",
  buildStatus: "idle",
  buildResult: null,
  runResult: null,
  error: "",
  contributorRequests: [],
  contributorLoading: false,
  contributorError: "",
  contributorProfile: null,
  contributorSetupLoading: false,
  contributorSetupMessage: "",
  contributorSetupError: "",
  logEntries: [],
  logStage: "Idle",
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

function formatUnixTime(unixSeconds: number): string {
  if (!unixSeconds) {
    return "Unknown time";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(unixSeconds * 1000));
}

function shortHash(hash: string): string {
  if (hash.length <= 16) {
    return hash;
  }

  return `${hash.slice(0, 12)}…${hash.slice(-8)}`;
}

function createQueueInfoCard(
  titleText: string,
  bodyText: string,
): HTMLElement {
  const card = document.createElement("article");
  card.className = "queue-card queue-card-empty";

  const title = document.createElement("h3");
  title.textContent = titleText;

  const body = document.createElement("p");
  body.className = "support-copy";
  body.textContent = bodyText;

  card.append(title, body);
  return card;
}

function appendQueueMetric(
  parent: HTMLElement,
  labelText: string,
  valueText: string,
): void {
  const block = document.createElement("div");
  const label = document.createElement("span");
  label.textContent = labelText;
  const value = document.createElement("strong");
  value.textContent = valueText;
  block.append(label, value);
  parent.append(block);
}

function triggerModeChipBurst(button: HTMLButtonElement): void {
  const activeTimer = modeBurstTimers.get(button);
  if (activeTimer) {
    window.clearTimeout(activeTimer);
  }

  button.classList.remove("is-bursting");
  void button.offsetWidth;
  button.classList.add("is-bursting");

  const timer = window.setTimeout(() => {
    button.classList.remove("is-bursting");
    modeBurstTimers.delete(button);
  }, 720);

  modeBurstTimers.set(button, timer);
}

function renderLink(
  element: HTMLAnchorElement,
  url: string,
  placeholder: string,
): void {
  if (url) {
    element.href = url;
    element.textContent = url;
    element.classList.remove("is-placeholder", "muted");
    return;
  }

  element.removeAttribute("href");
  element.textContent = placeholder;
  element.classList.add("is-placeholder", "muted");
}

function statusLabel(status: BuildStatus): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "ready":
      return "Ready";
    case "working":
      return "Processing";
    case "done":
      return "Queued";
    case "error":
      return "Attention";
  }
}

function statusHeadline(status: BuildStatus): string {
  switch (status) {
    case "idle":
      return "Waiting for a folder";
    case "ready":
      return "Ready to request a run";
    case "working":
      return "Building the Docker image and queueing the run";
    case "done":
      return "Run request queued successfully";
    case "error":
      return "Run request needs attention";
  }
}

function statusSummary(): string {
  if (state.error) {
    return "There is an error. Check the terminal for more details.";
  }

  if (state.runResult) {
    return state.runResult.summary;
  }

  if (state.buildResult) {
    return state.buildResult.summary;
  }

  if (state.buildStatus === "ready") {
    return "The folder is selected. Request for run will build the image, compress it, upload it, and queue the run.";
  }

  if (state.buildStatus === "working") {
    return "ComputeHive is preparing the Docker image, packaging the artifact, and queueing the run.";
  }

  return "Pick a project directory to prepare the Docker image and queue the run.";
}

function renderBuildNotes(notes: string[]): void {
  buildNotes.replaceChildren();

  if (notes.length === 0) {
    const item = document.createElement("li");
    item.textContent =
      "ComputeHive generates Docker setup automatically when it is missing.";
    buildNotes.append(item);
    return;
  }

  notes.forEach((note) => {
    const item = document.createElement("li");
    item.textContent = note;
    buildNotes.append(item);
  });
}

function processLogToneForStatus(status: BuildStatus): string {
  switch (status) {
    case "working":
      return "working";
    case "done":
      return "done";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

function processLogTimestamp(): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
}

function createProcessLogLine(entry: ProcessLogEntry): HTMLElement {
  const line = document.createElement("div");
  line.className = `terminal-line terminal-line-${entry.tone}`;

  const time = document.createElement("span");
  time.className = "terminal-time";
  time.textContent = entry.timestamp;

  const prompt = document.createElement("span");
  prompt.className = "terminal-prompt";
  prompt.textContent = entry.tone === "error" ? "!" : entry.tone === "success" ? "+" : ">";

  const message = document.createElement("p");
  message.className = "terminal-message";
  message.textContent = entry.message;

  line.append(time, prompt, message);
  return line;
}

function renderProcessLog(forceReset = false): void {
  processLogStatus.textContent = state.logStage;
  processLogStatus.className =
    `terminal-status terminal-status-${processLogToneForStatus(state.buildStatus)}`;

  if (forceReset || state.logEntries.length < renderedProcessLogCount) {
    processLog.replaceChildren();
    renderedProcessLogCount = 0;
  }

  if (state.logEntries.length === 0) {
    const placeholder = document.createElement("p");
    placeholder.className = "terminal-placeholder";
    placeholder.textContent =
      state.selectedPath.length > 0
        ? "Request for run will build the Docker image, compress it, upload it, and queue the job."
        : "Select a project folder to let ComputeHive build the Docker image and request the run.";
    processLog.replaceChildren(placeholder);
    renderedProcessLogCount = 0;
    return;
  }

  if (renderedProcessLogCount === 0) {
    processLog.replaceChildren();
  }

  while (renderedProcessLogCount < state.logEntries.length) {
    processLog.append(
      createProcessLogLine(state.logEntries[renderedProcessLogCount]),
    );
    renderedProcessLogCount += 1;
  }

  processLog.scrollTop = processLog.scrollHeight;
}

function addProcessLog(
  tone: ProcessLogTone,
  message: string,
): void {
  state.logEntries.push({
    id: nextProcessLogId,
    tone,
    message,
    timestamp: processLogTimestamp(),
  });
  nextProcessLogId += 1;
  renderProcessLog();
}

function clearProcessLogTimers(): void {
  processLogTimers.forEach((timer) => window.clearTimeout(timer));
  processLogTimers.clear();
}

function scheduleProcessLog(
  delayMs: number,
  tone: ProcessLogTone,
  message: string,
): void {
  const timer = window.setTimeout(() => {
    processLogTimers.delete(timer);
    addProcessLog(tone, message);
  }, delayMs);

  processLogTimers.add(timer);
}

function resetProcessLog(stage: string): void {
  clearProcessLogTimers();
  state.logStage = stage;
  state.logEntries = [];
  renderProcessLog(true);
}

function stageRequestLog(): void {
  resetProcessLog("Preparing");
  addProcessLog("info", `Target folder: ${state.selectedPath}`);
  addProcessLog("working", "Inspecting the selected project root.");
  scheduleProcessLog(
    180,
    "working",
    "Checking whether a Dockerfile already exists.",
  );
  scheduleProcessLog(
    380,
    "working",
    "Checking whether a .dockerignore file already exists.",
  );
  addProcessLog(
    "working",
    "Resolving the project stack and build strategy.",
  );
  scheduleProcessLog(
    720,
    "working",
    "Generating missing Docker setup files when required.",
  );
  scheduleProcessLog(
    1240,
    "working",
    "Building the Docker image.",
  );
  scheduleProcessLog(
    1820,
    "working",
    "Exporting the Docker image archive into the project root.",
  );
  scheduleProcessLog(
    2420,
    "working",
    "Compressing the archive to tar.gz.",
  );
  scheduleProcessLog(
    3020,
    "working",
    "Calculating the SHA-256 artifact hash.",
  );
  scheduleProcessLog(
    3620,
    "working",
    "Uploading the artifact to object storage.",
  );
  scheduleProcessLog(
    4220,
    "working",
    "Writing the Redis job record and queue entry.",
  );
}

function appendResultLogs(result: RunRequestResult): void {
  clearProcessLogTimers();
  state.logStage = "Queued";
  addProcessLog("success", `Docker image ready: ${result.image.imageTag}`);
  addProcessLog(
    "success",
    `Compressed artifact stored at ${result.gzipArchivePath}.`,
  );
  addProcessLog(
    "success",
    `Artifact SHA-256 recorded as ${result.artifactSha256}.`,
  );
  addProcessLog(
    "success",
    `Redis job ${result.redisJobId} was queued with object key ${result.artifactObjectKey}.`,
  );

  const seen = new Set<string>();
  result.notes.forEach((note) => {
    if (seen.has(note)) {
      return;
    }
    seen.add(note);
    addProcessLog(note.includes("No container") ? "info" : "success", note);
  });
}

function renderContributorQueue(): void {
  workerQueue.replaceChildren();
  refreshWorkersButton.disabled = state.contributorLoading;
  refreshWorkersButton.textContent = state.contributorLoading
    ? "Refreshing queue..."
    : "Refresh queue";

  if (state.contributorLoading) {
    workerQueue.append(
      createQueueInfoCard(
        "Loading queued run requests",
        "ComputeHive is reading the current Redis queue and artifact metadata.",
      ),
    );
    return;
  }

  if (state.contributorError) {
    workerQueue.append(
      createQueueInfoCard("Queue load failed", state.contributorError),
    );
    return;
  }

  if (state.contributorRequests.length === 0) {
    workerQueue.append(
      createQueueInfoCard(
        "No queued run requests yet",
        "Use Request for run in the project user flow to create the Redis job record, artifact metadata record, and queue entry.",
      ),
    );
    return;
  }

  state.contributorRequests.forEach((worker) => {
    const card = document.createElement("article");
    card.className = "queue-card";

    const topRow = document.createElement("div");
    topRow.className = "queue-top";

    const titleWrap = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = worker.projectName;
    const subhead = document.createElement("p");
    subhead.className = "queue-owner";
    subhead.textContent = `${worker.jobId} · queued ${formatUnixTime(worker.createdAtUnix)}`;
    titleWrap.append(title, subhead);

    const badge = document.createElement("span");
    badge.className = "queue-badge";
    badge.textContent = worker.status;

    topRow.append(titleWrap, badge);

    const meta = document.createElement("div");
    meta.className = "queue-meta";
    appendQueueMetric(meta, "Stack", worker.detectedStack);
    appendQueueMetric(meta, "Artifact", formatBytes(worker.gzipSizeBytes));
    appendQueueMetric(meta, "Image tag", worker.containerImage);
    appendQueueMetric(meta, "Hash", shortHash(worker.artifactSha256));
    appendQueueMetric(meta, "Object key", worker.artifactObjectKey || "Pending");
    appendQueueMetric(meta, "Project root", worker.projectRoot || "Unknown");

    if (worker.artifactPublicUrl) {
      const linkRow = document.createElement("p");
      linkRow.className = "queue-link";
      const label = document.createElement("span");
      label.className = "queue-link-label";
      label.textContent = "Public link";
      const link = document.createElement("a");
      link.href = worker.artifactPublicUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = worker.artifactPublicUrl;
      linkRow.append(label, link);
      card.append(topRow, meta, linkRow);
    } else {
      card.append(topRow, meta);
    }
    workerQueue.append(card);
  });
}

function renderContributorSetup(): void {
  contributorSignupSubmit.disabled = state.contributorSetupLoading;
  contributorSignupSubmit.textContent = state.contributorSetupLoading
    ? "Setting up contributor..."
    : "Sign up as contributor";

  if (state.contributorSetupError) {
    contributorSetupStatus.textContent = state.contributorSetupError;
    contributorSetupStatus.classList.add("contributor-status-error");
    contributorSetupStatus.classList.remove("contributor-status-success");
  } else if (state.contributorSetupMessage) {
    contributorSetupStatus.textContent = state.contributorSetupMessage;
    contributorSetupStatus.classList.add("contributor-status-success");
    contributorSetupStatus.classList.remove("contributor-status-error");
  } else {
    contributorSetupStatus.textContent =
      "Fill the form to register this machine as a contributor worker.";
    contributorSetupStatus.classList.remove(
      "contributor-status-success",
      "contributor-status-error",
    );
  }

  const profile = state.contributorProfile;
  contributorProfileCard.hidden = !profile;
  if (!profile) {
    profileWorkerId.textContent = "Pending";
    profileContributorName.textContent = "Pending";
    profileContributorEmail.textContent = "Pending";
    profileContributorLocation.textContent = "Pending";
    profileContributorResources.textContent =
      "CPU: - · GPU: - · Memory: - · Storage: -";
    return;
  }

  profileWorkerId.textContent = profile.workerId;
  profileContributorName.textContent = `${profile.name} · ${profile.workerVersion}`;
  profileContributorEmail.textContent = profile.email;
  profileContributorLocation.textContent = profile.location;
  profileContributorResources.textContent =
    `CPU: ${profile.availableCpuCores} cores · GPU: ${profile.availableGpuCount} · Memory: ${profile.availableMemoryMb} MB · Storage: ${profile.availableStorageGb} GB`;
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

  renderContributorSetup();
}

function renderUserState(): void {
  selectedPath.textContent = state.selectedPath || "No folder selected yet";
  selectedPath.classList.toggle("is-empty", state.selectedPath.length === 0);

  const canAct =
    state.selectedPath.length > 0 && state.buildStatus !== "working";
  requestRunButton.disabled = !canAct;
  revealFolderButton.disabled = state.selectedPath.length === 0;
  pickFolderButton.disabled = state.buildStatus === "working";
  clearSelectionButton.disabled = state.buildStatus === "working";

  requestRunButton.textContent =
    state.buildStatus === "working"
      ? "Requesting run..."
      : "Request for run";

  bundleStatus.className = `status-pill status-${state.buildStatus}`;
  bundleStatus.textContent = statusLabel(state.buildStatus);
  bundleSummaryTitle.textContent = statusHeadline(state.buildStatus);
  bundleSummary.textContent = statusSummary();
  renderProcessLog();

  const imageDetails = state.buildResult ?? state.runResult?.image ?? null;
  if (imageDetails) {
    imageOutputPath.textContent = imageDetails.imageArchivePath;
    detectedStack.textContent = imageDetails.detectedStack;
    imageTag.textContent = imageDetails.imageTag;
    imageSize.textContent = formatBytes(imageDetails.imageSizeBytes);
    dockerSetupSource.textContent = imageDetails.dockerSetupSource;
  } else {
    imageOutputPath.textContent =
      "The Docker image archive path will appear here after the build.";
    detectedStack.textContent = "Not detected yet";
    imageTag.textContent = "Not built yet";
    imageSize.textContent = "0 B";
    dockerSetupSource.textContent = "Auto-generate if needed";
  }

  if (state.runResult) {
    gzipOutputPath.textContent = `${state.runResult.gzipArchivePath} (${formatBytes(state.runResult.gzipSizeBytes)})`;
    artifactHash.textContent = state.runResult.artifactSha256;
    runRequestDetails.textContent =
      `${state.runResult.redisJobId} · ${state.runResult.artifactObjectKey}`;
    renderLink(
      artifactPublicLink,
      state.runResult.artifactPublicUrl,
      "The public artifact link will appear here after upload.",
    );
    renderBuildNotes(state.runResult.notes);
    return;
  }

  gzipOutputPath.textContent =
    "The tar.gz artifact path will appear here after a run request.";
  artifactHash.textContent =
    "The SHA-256 hash will appear here after upload.";
  runRequestDetails.textContent =
    "The Redis job id and object storage key will appear here after you request a run.";
  renderLink(
    artifactPublicLink,
    "",
    "The public artifact link will appear here after upload.",
  );

  if (imageDetails) {
    renderBuildNotes(imageDetails.notes);
    return;
  }

  renderBuildNotes([
    "The app creates Docker setup files automatically when they are missing.",
    "Request for run first builds the Docker image inside the selected project root.",
    "The app uploads only the tar.gz image artifact after compression.",
    "No container is created by this action in the current build.",
  ]);
}

function openSelectedFolder(): void {
  if (!state.selectedPath) {
    return;
  }

  addProcessLog("working", "Opening the selected project folder in the system file browser.");
  openPath(state.selectedPath)
    .then(() => {
      addProcessLog("success", "Selected project folder opened.");
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      addProcessLog("error", `Could not open the selected folder: ${message}`);
    });
}

function pickProjectFolder(): void {
  state.error = "";
  resetProcessLog("Picker");
  addProcessLog("working", "Opening the native folder picker.");
  renderUserState();

  open({
    directory: true,
    multiple: false,
    title: "Select the project folder to Dockerize and queue",
  })
    .then((folder) => {
      if (typeof folder !== "string") {
        state.logStage = "Idle";
        addProcessLog("info", "Folder selection was canceled.");
        renderUserState();
        return;
      }

      state.selectedPath = folder;
      state.buildStatus = "ready";
      state.buildResult = null;
      state.runResult = null;
      state.error = "";
      resetProcessLog("Ready");
      addProcessLog("info", `Project folder selected: ${folder}`);
      addProcessLog(
        "info",
        "Request for run will handle Docker setup, image export, compression, upload, and Redis queueing in one pass.",
      );
      renderUserState();
    })
    .catch((error) => {
      state.buildStatus = state.selectedPath ? "ready" : "idle";
      state.error = error instanceof Error ? error.message : String(error);
      state.logStage = "Picker Error";
      addProcessLog("error", `Folder picker failed: ${state.error}`);
      renderUserState();
    });
}

async function requestProjectRun(): Promise<void> {
  if (!state.selectedPath) {
    return;
  }

  state.buildStatus = "working";
  state.buildResult = null;
  state.runResult = null;
  state.error = "";
  stageRequestLog();
  renderUserState();

  try {
    const result = await invoke<RunRequestResult>("request_project_run", {
      projectPath: state.selectedPath,
    });

    state.buildResult = result.image;
    state.runResult = result;
    state.buildStatus = "done";
    appendResultLogs(result);
    void refreshContributorQueue();
  } catch (error) {
    clearProcessLogTimers();
    state.error = error instanceof Error ? error.message : String(error);
    state.buildStatus = "error";
    state.logStage = "Failed";
    addProcessLog("error", state.error);
  }

  renderUserState();
}

async function refreshContributorQueue(): Promise<void> {
  state.contributorLoading = true;
  state.contributorError = "";
  renderContributorQueue();

  try {
    const requests = await invoke<IncomingRunRequest[]>(
      "list_incoming_run_requests",
    );
    state.contributorRequests = requests;
  } catch (error) {
    state.contributorRequests = [];
    state.contributorError =
      error instanceof Error ? error.message : String(error);
  } finally {
    state.contributorLoading = false;
    renderContributorQueue();
  }
}

async function loadContributorProfile(): Promise<void> {
  try {
    const profile = await invoke<ContributorWorkerProfile | null>(
      "get_registered_contributor_worker",
    );
    state.contributorProfile = profile;
    if (profile && !state.contributorSetupMessage) {
      state.contributorSetupMessage =
        "Contributor setup already exists for this machine.";
    }
  } catch (error) {
    state.contributorProfile = null;
    state.contributorSetupError =
      error instanceof Error ? error.message : String(error);
  }

  renderContributorSetup();
}

async function setupContributorWorker(): Promise<void> {
  const name = contributorNameInput.value.trim();
  const email = contributorEmailInput.value.trim();
  const location = contributorLocationInput.value.trim();

  if (!name || !email || !location) {
    state.contributorSetupError =
      "Name, email, and location are required to register as a contributor.";
    state.contributorSetupMessage = "";
    renderContributorSetup();
    return;
  }

  state.contributorSetupLoading = true;
  state.contributorSetupError = "";
  state.contributorSetupMessage = "";
  renderContributorSetup();

  try {
    const profile = await invoke<ContributorWorkerProfile>(
      "setup_contributor_worker",
      {
        name,
        email,
        location,
      },
    );

    state.contributorProfile = profile;
    state.contributorSetupMessage =
      "Contributor setup completed and worker details were stored in Redis.";
    contributorSignupForm.reset();
  } catch (error) {
    state.contributorSetupError =
      error instanceof Error ? error.message : String(error);
  } finally {
    state.contributorSetupLoading = false;
    renderContributorSetup();
  }
}

function clearSelection(): void {
  clearProcessLogTimers();
  state.selectedPath = "";
  state.buildStatus = "idle";
  state.buildResult = null;
  state.runResult = null;
  state.error = "";
  state.logStage = "Idle";
  state.logEntries = [];
  renderUserState();
}

modeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    triggerModeChipBurst(button);
    const nextMode = button.dataset.mode;
    if (nextMode === "user" || nextMode === "contributor") {
      state.mode = nextMode;
      renderMode();
      if (nextMode === "contributor") {
        void refreshContributorQueue();
      }
    }
  });
});

pickFolderButton.addEventListener("click", () => {
  pickProjectFolder();
});

requestRunButton.addEventListener("click", () => {
  void requestProjectRun();
});

revealFolderButton.addEventListener("click", () => {
  openSelectedFolder();
});

refreshWorkersButton.addEventListener("click", () => {
  void refreshContributorQueue();
});

contributorSignupForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void setupContributorWorker();
});

clearSelectionButton.addEventListener("click", clearSelection);

renderMode();
renderUserState();
renderContributorSetup();
void refreshContributorQueue();
void loadContributorProfile();
