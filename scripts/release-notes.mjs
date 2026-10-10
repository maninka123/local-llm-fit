// Builds release notes for a version from CHANGELOG.md.
//   node scripts/release-notes.mjs 1.0.12 body   → markdown for the GitHub release page
//   node scripts/release-notes.mjs 1.0.12 notes  → short plain text for the in-app update window
import { readFileSync } from "node:fs";

const [version, kind = "body"] = process.argv.slice(2);
const log = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const m = new RegExp(`^## ${version.replace(/\./g, "\\.")}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(log);
const bullets = (m?.[1] ?? "")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.startsWith("- "))
  .map((l) => l.slice(2));
const list = bullets.length ? bullets : ["Improvements and fixes"];

if (kind === "notes") {
  process.stdout.write(list.map((b) => `• ${b}`).join("\n"));
} else {
  const guide = readFileSync(new URL("../docs/RELEASE_ASSETS.md", import.meta.url), "utf8").replace(/<version>/g, version);
  process.stdout.write(`## What's new\n\n${list.map((b) => `- ${b}`).join("\n")}\n\n${guide}`);
}
