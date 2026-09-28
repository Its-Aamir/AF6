/**
 * Desktop app: the API and worker are children of the Electron process. If that
 * process dies without shutting them down (crash, task-manager kill), exit too
 * instead of lingering in the background. No-op outside the desktop app.
 */
export function exitWithParent(shutdown: () => void): void {
  const ppid = Number(process.env.AF6_PARENT_PID);
  if (!ppid) return;
  const timer = setInterval(() => {
    try { process.kill(ppid, 0); } catch {
      clearInterval(timer);
      shutdown();
      setTimeout(() => process.exit(0), 5000).unref();
    }
  }, 2000);
  timer.unref();
}
