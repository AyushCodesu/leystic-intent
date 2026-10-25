export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { initSourcePolicyRegistry } = await import("./lib/sourcePolicy");
      await initSourcePolicyRegistry();
      const { initOperatorCredentialRegistry } = await import("./lib/operatorAuth");
      await initOperatorCredentialRegistry();
    } catch (err) {
      console.error("[Instrumentation] Failed to initialize registries:", err);
    }
  }

  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.RUN_SCHEDULER !== "true") {
    return;
  }
  const { startScheduler } = await import("./jobs/scheduler");
  startScheduler();
}
