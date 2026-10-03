// Provider-independent startup, shell-only, directory, and title regression probe.
// Run via: obsidian-cli eval code="eval(require('fs').readFileSync('/absolute/path/to/scripts/tests/startup-command.js','utf8'))" vault=daneel
(async () => {
  const VIEW_TYPE = "ghostty-terminal-view";
  const plugin = app.plugins.getPlugin("obsidian-claude-ghostty");
  if (!plugin) throw new Error("plugin not found");

  const originalSettings = { ...plugin.settings };
  const leaves = [];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const dump = (leaf) => {
    const view = leaf.view;
    return Array.from({ length: view.viewportSize.rows }, (_, row) =>
      view.rowTextToCells(view.vt.dumpViewportRow(row), view.viewportSize.cols).join("")
    ).join("\n");
  };
  const waitForOutput = async (leaf, text) => {
    for (let i = 0; i < 20; i++) {
      if (dump(leaf).includes(text)) return dump(leaf);
      await wait(100);
    }
    throw new Error(`Terminal output did not contain ${JSON.stringify(text)}: ${dump(leaf)}`);
  };
  const open = async (shellOnly = false) => {
    const before = new Set(app.workspace.getLeavesOfType(VIEW_TYPE));
    await plugin.openNewTerminal(undefined, { shellOnly });
    const leaf = app.workspace.getLeavesOfType(VIEW_TYPE).find((item) => !before.has(item));
    if (!leaf?.view.pty) throw new Error("new terminal did not start");
    leaves.push(leaf);
    return leaf;
  };
  const checks = {};

  try {
    // Old saved settings without startupCommand must load a blank default.
    const loadData = plugin.loadData;
    try {
      plugin.loadData = async () => ({ startDirectory: "" });
      await plugin.loadSettings();
      checks.oldSettingsDefaultToShell = plugin.settings.startupCommand === "";
    } finally {
      plugin.loadData = loadData;
      plugin.settings = { ...originalSettings };
    }

    plugin.settings.startDirectory = "";
    plugin.settings.startupCommand = "";
    const blank = await open();
    checks.defaultTitle = blank.view.getDisplayText() === "Agent";
    blank.view.pty.write("printf 'SHELL_%s:%s\\n' \"$BASH_VERSION\" \"$PWD\"; printf 'BASH_%s\\n' READY\r");
    const shellOutput = await waitForOutput(blank, "BASH_READY");
    const shellInfo = shellOutput.match(/SHELL_(\d[^:\n]*):([^\n]*)/);
    checks.blankStartsBashAtVaultRoot =
      !!shellInfo && shellInfo[2].trim() === app.vault.adapter.getBasePath();
    checks.blankDoesNotRunAgent = !shellOutput.includes("claude --continue");

    blank.view.parseOscTitleFromStream("\x1b]2;Agent regression title\x07");
    checks.liveTitleSync =
      blank.view.getDisplayText() === "Agent regression title" &&
      blank.tabHeaderInnerTitleEl?.textContent === "Agent regression title" &&
      blank.view.titleEl?.textContent === "Agent regression title";
    blank.detach();

    plugin.settings.startupCommand = "  printf 'AGENT_%s\\n' STARTED  ";
    const configured = await open();
    await waitForOutput(configured, "AGENT_STARTED");
    configured.view.pty.write("printf 'AFTER_%s\\n' STARTUP\r");
    const configuredOutput = await waitForOutput(configured, "AFTER_STARTUP");
    checks.configuredCommandRunsOnce =
      (configuredOutput.match(/AGENT_STARTED/g) || []).length === 1;
    configured.view.pty.write("exit\r");
    for (let i = 0; i < 20 && app.workspace.getLeavesOfType(VIEW_TYPE).includes(configured); i++) {
      await wait(100);
    }
    checks.shellExitClosesTab = !app.workspace.getLeavesOfType(VIEW_TYPE).includes(configured);

    const shellOnly = await open(true);
    shellOnly.view.pty.write("printf 'BYPASS_%s\\n' READY\r");
    const bypassOutput = await waitForOutput(shellOnly, "BYPASS_READY");
    checks.shellOnlyBypassesCommand = !bypassOutput.includes("AGENT_STARTED");
    shellOnly.detach();

    // A saved-layout leaf does not pass through openNewTerminal's one-shot flag.
    const restored = app.workspace.getLeaf("split", "horizontal");
    leaves.push(restored);
    await restored.setViewState({ type: VIEW_TYPE, active: true });
    await waitForOutput(restored, "AGENT_STARTED");
    checks.restoredTerminalRunsCommand = true;
    restored.detach();

    plugin.settings.startDirectory = "/tmp";
    plugin.settings.startupCommand = "printf 'DIRECTORY_%s\\n' \"$PWD\"";
    const directory = await open();
    const directoryOutput = await waitForOutput(directory, "DIRECTORY_/");
    checks.startDirectoryHonored = /DIRECTORY_(\/private)?\/tmp/.test(directoryOutput);
    directory.detach();

    plugin.settings.startDirectory = "";
    plugin.settings.startupCommand = "   ";
    const whitespace = await open();
    whitespace.view.pty.write("printf 'WHITESPACE_%s\\n' READY\r");
    await waitForOutput(whitespace, "WHITESPACE_READY");
    checks.whitespaceStartsShell = !dump(whitespace).includes("claude --continue");
    whitespace.detach();

    plugin.settings.startupCommand = "DANEEL_DRY_RUN=1 daneel";
    const daneel = await open();
    const daneelOutput = await waitForOutput(daneel, "--experimental");
    checks.daneelScriptAvailable = daneelOutput.includes("copilot") && daneelOutput.includes("--no-sandbox");
    daneel.detach();

    plugin.settings.startupCommand = "obsidianghost_nonexistent_startup_command";
    const failed = await open();
    await waitForOutput(failed, "command not found");
    checks.failedCommandVisible = true;
    failed.detach();

    return { ...checks, pass: Object.values(checks).every(Boolean) };
  } finally {
    plugin.settings = originalSettings;
    for (const leaf of leaves) {
      if (app.workspace.getLeavesOfType(VIEW_TYPE).includes(leaf)) leaf.detach();
    }
  }
})();
