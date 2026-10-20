export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { initSourcePolicyRegistry } = await import("./lib/sourcePolicy");
      await initSourcePolicyRegistry();
    } catch (err) {
      console.error("[Instrumentation] Failed to initialize SourcePolicyRegistry:", err);
    }
  }

  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.RUN_SCHEDULER !== "true") {
    return;
  }
  const { startScheduler } = await import("./jobs/scheduler");
  startScheduler();
}
