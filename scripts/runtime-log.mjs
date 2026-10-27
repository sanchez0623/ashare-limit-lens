import { format } from "node:util";

const installed = Symbol.for("limit-lens.runtime-log.timestamps");

// Install only in service entry points. Maintenance commands that emit JSON
// keep their machine-readable output, and inherited child output is not wrapped
// a second time by the parent process.
export function installRuntimeLogTimestamps(output = console) {
  if (output[installed]) return;
  Object.defineProperty(output, installed, { value: true });
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const original = output[method].bind(output);
    output[method] = (...args) => {
      const stamp = new Date(Date.now() + 8 * 3600000)
        .toISOString()
        .replace("T", " ")
        .replace("Z", " +08:00");
      original(
        format(...args)
          .split(/\r?\n/)
          .map((line) => `[${stamp}] ${line}`)
          .join("\n"),
      );
    };
  }
}
