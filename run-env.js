/** Run existing Linux-style env assignments portably on Windows, macOS, and Linux. */
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
if (separator < 0 || separator === args.length - 1) {
  console.error("Usage: node run-env.js KEY=value ... -- script.js [args]");
  process.exit(2);
}

const environment = { ...process.env };
for (const assignment of args.slice(0, separator)) {
  const match = assignment.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
  if (!match) {
    console.error(`Invalid environment assignment: ${assignment}`);
    process.exit(2);
  }
  environment[match[1]] = match[2];
}

const script = args[separator + 1];
const scriptArgs = args.slice(separator + 2);
const result = spawnSync(process.execPath, [script, ...scriptArgs], {
  env: environment,
  cwd: process.cwd(),
  stdio: "inherit",
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
