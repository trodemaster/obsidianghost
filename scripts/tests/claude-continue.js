// Live probe for: auto-launch `claude --continue`, the shell-only escape hatch,
// configurable start directory, and auto-close-tab-on-shell-exit. See HANDOFF.md.
// Run via: scripts/live-test.sh scripts/tests/claude-continue.js
(async () => {
  const VIEW_TYPE = "ghostty-terminal-view";
  const plugin = app.plugins.getPlugin("obsidian-claude-ghostty");
  if (!plugin) return { error: "plugin not found" };

  const dumpLeaf = async (leaf, ms) => {
    await new Promise((r) => setTimeout(r, ms));
    const view = leaf.view;
    const { rows, cols } = view.viewportSize;
    const lines = [];
    for (let row = 0; row < rows; row++) {
      lines.push(view.rowTextToCells(view.vt.dumpViewportRow(row), cols).join(""));
    }
    return lines.join("\n").replace(/\s+$/gm, "");
  };

  const before = new Set(app.workspace.getLeavesOfType(VIEW_TYPE));
  const newLeaf = () => {
    const leaves = app.workspace.getLeavesOfType(VIEW_TYPE);
    return leaves.find((l) => !before.has(l));
  };

  const result = {};

  // --- 1. Default open auto-launches `claude --continue` ---
  await plugin.openNewTerminal();
  let leaf = newLeaf();
  if (!leaf) return { error: "no new leaf after openNewTerminal (default)" };
  const claudeDump = await dumpLeaf(leaf, 3500);
  // A resumed (--continue) session won't show the fresh version banner — it jumps
  // straight into prior transcript/UI chrome instead. Check for either.
  result.claudeLaunched = /Claude Code v\d|Sonnet|manual mode|shell command/.test(claudeDump);
  result.claudeDumpSnippet = claudeDump.slice(0, 200);

  // Exit claude, then exit the shell — should auto-close the tab.
  leaf.view.pty.write("\x1b");
  await new Promise((r) => setTimeout(r, 300));
  leaf.view.pty.write("\x03\x03");
  await new Promise((r) => setTimeout(r, 1200));
  leaf.view.pty.write("exit\r");
  await new Promise((r) => setTimeout(r, 1500));
  result.tabAutoClosedAfterExit = !app.workspace.getLeavesOfType(VIEW_TYPE).includes(leaf);

  // --- 2. Shell-only escape hatch: no Claude banner ---
  const before2 = new Set(app.workspace.getLeavesOfType(VIEW_TYPE));
  await plugin.openNewTerminal(undefined, { shellOnly: true });
  const leaf2 = app.workspace.getLeavesOfType(VIEW_TYPE).find((l) => !before2.has(l));
  if (!leaf2) return { error: "no new leaf after openNewTerminal (shellOnly)", ...result };
  const shellDump = await dumpLeaf(leaf2, 1200);
  result.shellOnlyHasNoClaudeBanner = !/Claude Code v\d|Sonnet|manual mode/.test(shellDump);
  result.shellOnlyPromptVisible = shellDump.includes("$") && shellDump.includes("daneel");
  result.shellDumpSnippet = shellDump.trim();

  // --- 3. Configurable start directory ---
  const origStartDir = plugin.settings.startDirectory;
  plugin.settings.startDirectory = "/tmp";
  await plugin.saveSettings();
  const before3 = new Set(app.workspace.getLeavesOfType(VIEW_TYPE));
  await plugin.openNewTerminal(undefined, { shellOnly: true });
  const leaf3 = app.workspace.getLeavesOfType(VIEW_TYPE).find((l) => !before3.has(l));
  leaf3.view.pty.write("pwd\r");
  const pwdDump = await dumpLeaf(leaf3, 800);
  result.startDirectoryHonored = pwdDump.includes("/tmp") || pwdDump.includes("/private/tmp");
  plugin.settings.startDirectory = origStartDir;
  await plugin.saveSettings();

  // --- cleanup: close the two still-open shell-only tabs ---
  leaf2.detach();
  leaf3.detach();

  result.pass =
    result.claudeLaunched &&
    result.tabAutoClosedAfterExit &&
    result.shellOnlyHasNoClaudeBanner &&
    result.shellOnlyPromptVisible &&
    result.startDirectoryHonored;

  return result;
})();
