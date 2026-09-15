import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { uptime } from "node:os";

export interface RecoveryClockSource {
  wall(): number;
  uptime(): number;
  boot: string | null;
}
export interface ClockCheckpoint {
  time: number;
  wall?: number;
  uptime?: number;
  boot?: string | null;
}
export function recoveryClockSource(): RecoveryClockSource {
  let boot: string | null = null;
  try {
    if (process.platform === "linux")
      boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    else if (process.platform === "darwin")
      boot = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
        encoding: "utf8",
        timeout: 1000,
      }).trim();
  } catch {
    /* Unknown boot identity retains all recent events conservatively. */
  }
  return { wall: Date.now, uptime: () => uptime() * 1000, boot };
}
export function recoveryElapsed(
  previous: ClockCheckpoint,
  current: ClockCheckpoint,
) {
  const sameBoot =
    !!previous.boot &&
    previous.boot === current.boot &&
    previous.uptime !== undefined &&
    current.uptime !== undefined &&
    current.uptime >= previous.uptime;
  // os.uptime() has whole-second resolution on some supported systems. Subtract
  // one second to obtain a lower bound, never expiring an event prematurely.
  const elapsed = sameBoot
    ? Math.max(0, current.uptime! - previous.uptime! - 1000)
    : 0;
  const wallChanged =
    previous.wall === undefined ||
    current.wall === undefined ||
    Math.abs(current.wall - previous.wall - elapsed) > 2000;
  return { elapsed, uncertain: !sameBoot || wallChanged };
}
