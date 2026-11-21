// Live probe for the Shift+Enter / TERM_PROGRAM fix (see CLAUDE.md).
// Run via: scripts/live-test.sh scripts/tests/shift-enter.js
//
// Talks directly to the terminal view's internals through obsidian-cli's
// eval (no mouse/keyboard OS automation, no screen coordinates) — patches
// GhosttyTerminal#pty.write to capture bytes, and dispatches a real
// KeyboardEvent through the same handleKeyDown path the browser would use.
(async () => {
  let probeLeaf;
  try {
  const VIEW_TYPE = "ghostty-terminal-view";
  // Own shell-only tab, so the probe never writes into a terminal running an agent.
  const probePlugin = app.plugins.getPlugin("obsidian-claude-ghostty");
  const probeBefore = new Set(app.workspace.getLeavesOfType(VIEW_TYPE));
  await probePlugin.openNewTerminal(undefined, { shellOnly: true });
  const leaf = app.workspace.getLeavesOfType(VIEW_TYPE).find((l) => !probeBefore.has(l));
  if (!leaf) return { error: "probe terminal did not open" };
  probeLeaf = leaf;
  for (let i = 0; i < 50 && !(leaf.view.pty && leaf.view.vt); i++) await new Promise((r) => setTimeout(r, 100));
  const view = leaf.view;
  if (!view.pty || !view.inputEl || !view.vt) {
    return {
      error: "view not fully initialized",
      hasPty: !!view.pty,
      hasInput: !!view.inputEl,
      hasVt: !!view.vt,
    };
  }

  const result = {};

  // --- env vars seen by the spawned shell ---
  const marker = "GHOSTTY_ENV_CHECK";
  view.pty.write(`printf '${marker} %s|%s|%s\\n' "$TERM_PROGRAM" "$TERM" "$TERM_PROGRAM_VERSION"\r`);
  await new Promise((r) => setTimeout(r, 600));

  const { rows } = view.viewportSize;
  let envLine = null;
  for (let row = 0; row < rows; row++) {
    const text = view.vt.dumpViewportRow(row);
    if (text.includes(marker)) envLine = text.trim();
  }
  result.envLine = envLine;
  result.envOk = envLine === `${marker} ghostty|xterm-ghostty|1.3.1`;

  // --- Shift+Enter byte sequence actually written to the pty ---
  view.focusInput();
  result.focused = document.activeElement === view.inputEl;

  const capture = (event) => {
    const writes = [];
    const origWrite = view.pty.write.bind(view.pty);
    view.pty.write = (d) => {
      writes.push(d);
      return origWrite(d);
    };
    view.inputEl.dispatchEvent(event);
    view.pty.write = origWrite;
    return writes.map((w) => Buffer.from(w, "binary").toString("hex"));
  };

  result.shiftEnterHex = capture(
    new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true })
  );
  result.plainEnterHex = capture(
    new KeyboardEvent("keydown", { key: "Enter", shiftKey: false, bubbles: true, cancelable: true })
  );

  result.shiftEnterOk = result.shiftEnterHex.length === 1 && result.shiftEnterHex[0] === "1b0d";
  result.plainEnterOk = result.plainEnterHex.length === 1 && result.plainEnterHex[0] === "0d";
  result.pass = result.envOk && result.focused && result.shiftEnterOk && result.plainEnterOk;

  return result;
  } finally {
    probeLeaf?.detach();
  }
})();
