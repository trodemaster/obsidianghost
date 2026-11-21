// Check an assembled plugin payload (default dist/<plugin-id>): the files are all
// there, the packaged libghostty-vt passes the adapter tests, and the packaged
// node-pty prebuild can spawn a shell in a pty of the requested size.
//   node scripts/verify-payload.mjs [payload-dir]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const payload = resolve(process.argv[2] || join(root, "dist", manifest.id));
const failures = [];

for (const file of [
  "main.js", "manifest.json", "styles.css", "ghostty-vt.wasm", "LICENSE", "THIRD_PARTY_NOTICES.md",
  "node_modules/node-pty/lib/index.js", "node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
]) {
  if (!existsSync(join(payload, file))) failures.push(`missing ${file}`);
}
const helper = join(payload, "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
if (!existsSync(helper) || (statSync(helper).mode & 0o111) === 0) failures.push("spawn-helper is not executable");
const shipped = JSON.parse(readFileSync(join(payload, "manifest.json"), "utf8"));
if (shipped.version !== manifest.version) failures.push(`payload is ${shipped.version}, manifest is ${manifest.version}`);

try {
  execFileSync(process.execPath, [join(root, "scripts", "test-vt.mjs"), join(payload, "ghostty-vt.wasm")], { stdio: "pipe" });
} catch (error) {
  failures.push(`libghostty-vt adapter tests failed:\n${error.stdout ?? error}`);
}

if (process.platform === "darwin" && process.arch === "arm64") {
  const pty = createRequire(import.meta.url)(join(payload, "node_modules", "node-pty"));
  const output = await new Promise((done, fail) => {
    const term = pty.spawn("/bin/sh", ["-c", "stty size"], { name: "xterm-256color", cols: 91, rows: 27, env: process.env });
    let text = "";
    const timer = setTimeout(() => fail(new Error("pty did not exit")), 10000);
    term.onData((data) => { text += data; });
    term.onExit(() => { clearTimeout(timer); done(text.trim()); });
  }).catch((error) => `error: ${error.message}`);
  if (output !== "27 91") failures.push(`node-pty spawn: expected "27 91", got ${JSON.stringify(output)}`);
} else {
  console.log(`skipping node-pty spawn check on ${process.platform}-${process.arch}`);
}

if (failures.length) {
  console.error(`payload check failed for ${payload}:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`payload ok: ${manifest.id} ${manifest.version} (${payload})`);
