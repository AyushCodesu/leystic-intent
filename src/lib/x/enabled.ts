import { config } from "@/lib/config";

/**
 * Whether this user may run X leads. X_LEADS is the instance-level switch.
 */
export function xEnabledFor(userId: string | null | undefined): boolean {
  return config().X_LEADS && Boolean(userId);
}
