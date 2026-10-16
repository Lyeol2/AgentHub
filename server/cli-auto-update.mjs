const TOOLS = ["claude", "codex"];
export const CLI_UPDATE_STARTUP_MS = 30_000;
export const CLI_UPDATE_INTERVAL_MS = 12 * 60 * 60_000;
export const CLI_UPDATE_RETRY_MS = 60_000;

// Only start() owns timers. The scheduler never installs a missing CLI and
// leaves update execution, installation-channel checks and locking to Setup.
export class CliAutoUpdater {
  constructor({ setup, enabled = () => true, isBusy = () => false, logger = console,
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    startupMs = CLI_UPDATE_STARTUP_MS, intervalMs = CLI_UPDATE_INTERVAL_MS, retryMs = CLI_UPDATE_RETRY_MS }) {
    Object.assign(this, { setup, enabled, isBusy, logger, now, setTimer, clearTimer, startupMs, intervalMs, retryMs });
    this.nextDue = new Map();
    this.timer = null;
    this.started = false;
    this.disposed = false;
    this.checking = false;
    this.onFinished = (tool, job) => {
      if (TOOLS.includes(tool) && job?.automatic && job.errorCode === "CLI_BUSY") {
        this.nextDue.set(tool, this.now() + this.retryMs);
      }
    };
  }

  start() {
    if (this.started || this.disposed) return;
    this.started = true;
    this.setup.on?.("finished", this.onFinished);
    for (const tool of TOOLS) this.nextDue.set(tool, this.now() + this.startupMs);
    this.schedule(this.startupMs);
  }

  schedule(delay) {
    if (this.disposed || !this.started) return;
    this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      return this.check();
    }, delay);
    this.timer?.unref?.();
  }

  async check() {
    if (this.disposed || !this.started || this.checking) return;
    this.checking = true;
    try {
      if (!this.enabled()) return;
      const due = TOOLS.filter((tool) => this.nextDue.get(tool) <= this.now());
      if (!due.length || due.every((tool) => this.isBusy(tool))) return;
      // Serialize automatic jobs, including retries after a slow package manager.
      if (TOOLS.some((tool) => this.setup.isUpdating?.(tool))) return;
      const status = await this.setup.status();
      if (this.disposed || !this.enabled()) return;
      if (TOOLS.some((tool) => this.setup.isUpdating?.(tool))) return;
      for (const tool of due) {
        if (this.isBusy(tool) || status.jobs?.[tool]?.state === "running") continue;
        const installed = status.tools?.find((entry) => entry.id === tool);
        if (!installed?.path || !installed.version || !installed.updatable) {
          this.nextDue.set(tool, this.now() + this.intervalMs);
          continue;
        }
        try {
          // Setup reserves the job synchronously and checks busy state again
          // immediately before spawning the updater after asynchronous discovery.
          this.setup.update(tool, { automatic: true });
          this.nextDue.set(tool, this.now() + this.intervalMs);
          break;
        } catch (error) {
          if (error.code !== "CLI_BUSY" && !this.isBusy(tool)) {
            this.nextDue.set(tool, this.now() + this.intervalMs);
            this.logger.error?.(`CLI 자동 업데이트 (${tool}): ${error.message}`);
          }
        }
      }
    } catch (error) {
      this.logger.error?.(`CLI 자동 업데이트 확인: ${error.message}`);
    } finally {
      this.checking = false;
      // Poll only the due time/settings; expensive status discovery runs when due.
      this.schedule(this.retryMs);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearTimer(this.timer);
    this.timer = null;
    this.setup.off?.("finished", this.onFinished);
    const jobs = this.setup.jobList?.() ?? {};
    for (const tool of TOOLS) {
      const job = jobs[tool];
      if (job?.kind !== "update" || job.state !== "running" || !job.automatic) continue;
      this.setup.cancel?.(tool);
    }
  }
}
