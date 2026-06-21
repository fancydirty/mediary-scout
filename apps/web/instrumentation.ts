/**
 * Next.js instrumentation: runs once when the server process starts. We use it
 * to start the in-process queue worker so that a browser "获取" click actually
 * runs the workflow end-to-end (claim → run → persist → UI updates) without any
 * external poke. Node runtime only — the Edge runtime can't run the workflow.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  // Fail fast + loud on a runtime misconfig (e.g. MEDIA_TRACK_AGENT_ADAPTER=real)
  // instead of booting a worker that can never drain the queue. Throwing here
  // aborts startup with a clear reason.
  const { validateRuntimeConfig } = await import("@media-track/workflow");
  validateRuntimeConfig(process.env);

  console.log("[instrumentation] register() — running startup migrations + worker");
  const { runStartupMigrations } = await import("./lib/workflow-runtime");
  await runStartupMigrations();
  const { startBackgroundWorker } = await import("./lib/background-worker");
  startBackgroundWorker();
}
