import { build } from "esbuild";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const test = process.argv[2] || "kitty-images";
if (!["kitty-images", "rendering"].includes(test)) throw new Error(`Unknown terminal probe: ${test}`);
const dir = mkdtempSync(join(tmpdir(), "ghostty-terminal-"));
const bundle = join(dir, "terminal-test.cjs");
const native = join(dir, "ghostty_vt.node");
try {
  copyFileSync(join(root, "native", "ghostty_vt.node"), native);
  await build({
    stdin: {
      contents: readFileSync(join(root, "main.ts"), "utf8") +
        '\nexport { GhosttyTerminalView, parseGhosttyConfig };\n' +
        'export { KittyGraphics, terminalRowCells, decodeImageCell } from "./kitty-graphics";\n' +
        'export { readFontMetrics, readFontNames, terminalMetrics } from "./font-metrics";\n' +
        'export { textRangeToCells, parseStyleRuns } from "./native/ghostty";\n' +
        'const fixture = require("./scripts/rendering-fixture.cjs"); export { fixture };',
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    external: ["obsidian", "node-pty"],
    format: "cjs",
    platform: "node",
    target: "es2018",
    outfile: bundle,
  });
  const code = `(async () => {
    const plugin = app.plugins.getPlugin("obsidian-claude-ghostty");
    const existing = app.workspace.getLeavesOfType("ghostty-terminal-view")[0]?.view;
    if (!plugin || !existing) throw new Error("Open a Ghostty terminal in the test vault first");
    const obsidian = {
      ItemView: Object.getPrototypeOf(Object.getPrototypeOf(existing)).constructor,
      Plugin: Object.getPrototypeOf(plugin.constructor),
      PluginSettingTab: class {},
    };
    const module = { exports: {} };
    new Function("require", "module", "exports", require("fs").readFileSync(${JSON.stringify(bundle)}, "utf8"))(
      (id) => id === "obsidian" ? obsidian : require(id), module, module.exports
    );
    globalThis.ghosttyImageTestModule = module.exports;
    module.exports.native = require(${JSON.stringify(native)});
    module.exports.fixtureMetrics = ${process.env.GHOSTTY_METRICS_FILE
      ? JSON.stringify(JSON.parse(readFileSync(process.env.GHOSTTY_METRICS_FILE, "utf8"))) : "null"};
    try {
      return await eval(require("fs").readFileSync(${JSON.stringify(resolve(root, `scripts/tests/${test}.js`))}, "utf8"));
    } finally {
      delete globalThis.ghosttyImageTestModule;
    }
  })()`;
  const { stdout, stderr } = await promisify(execFile)(
    "/Applications/Obsidian.app/Contents/MacOS/obsidian-cli",
    ["eval", `vault=${process.argv[3] || "daneel"}`, `code=${code}`],
    { timeout: 60000, maxBuffer: 1024 * 1024 },
  );
  const marker = stdout.lastIndexOf("=> ");
  if (marker < 0) throw new Error(stdout + stderr);
  const result = JSON.parse(stdout.slice(marker + 3));
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
} finally {
  if (existsSync(bundle)) unlinkSync(bundle);
  if (existsSync(native)) unlinkSync(native);
  rmdirSync(dir);
}
