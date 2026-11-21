// Regression probe: OSC 8 hyperlinks (already supported) now also require Cmd/Ctrl to
// open, matching the plain-URL behavior added alongside this. See CLAUDE.md.
//
// Builds the OSC 8 sequence via printf's own \033 octal-escape parsing (interpreted when
// the command *runs*, i.e. after Enter) rather than embedding raw ESC bytes in the typed
// command line — the shell's line editor (zsh's ZLE) treats a literal ESC byte in typed
// input as a meta-key prefix and eats it, corrupting the command before it ever executes.
//
// Run via: scripts/live-test.sh scripts/tests/osc8-links.js
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
  if (!view.pty || !view.vt || !view.canvasEl) {
    return { error: "view not fully initialized" };
  }

  const result = {};
  const expectedUrl = "https://example.com/osc8test";
  const label = "OSC8LABEL";
  // Literal text typed to the shell: printf '\033]8;;URL\033\\LABEL\033]8;;\033\\\n'
  const cmd = `printf '\\033]8;;${expectedUrl}\\033\\\\${label}\\033]8;;\\033\\\\\\n'`;

  view.pty.write(cmd + "\r");
  await new Promise((r) => setTimeout(r, 600));

  const { cols, rows } = view.viewportSize;
  let row = -1;
  for (let r = 0; r < rows; r++) {
    const text = view.rowTextToCells(view.vt.dumpViewportRow(r), cols).join("");
    if (text.includes(label)) row = r + 1;
  }
  if (row === -1) return { error: "label line not found" };

  const link = view.findLinkAt(1, row);
  result.findLinkAt = link;
  result.findLinkAtOk = link?.uri === expectedUrl;

  const rect = view.canvasEl.getBoundingClientRect();
  const { width, height } = view.getCharSize();
  const clientX = rect.left + 0.5 * width;
  const clientY = rect.top + (row - 0.5) * height;

  const opens = [];
  const origOpen = window.open;
  window.open = (...args) => {
    opens.push(args);
    return null;
  };

  const move = (metaKey) =>
    view.screenEl.dispatchEvent(
      new MouseEvent("mousemove", { clientX, clientY, metaKey, bubbles: true })
    );
  const click = (metaKey) =>
    view.screenEl.dispatchEvent(
      new MouseEvent("click", { clientX, clientY, metaKey, bubbles: true, cancelable: true })
    );

  move(false);
  click(false);
  result.opensWithoutModifier = opens.length;

  move(true);
  click(true);
  result.opensWithModifier = opens.slice();

  window.open = origOpen;

  result.pass =
    result.findLinkAtOk &&
    result.opensWithoutModifier === 0 &&
    result.opensWithModifier.length === 1 &&
    result.opensWithModifier[0][0] === expectedUrl;

  return result;
  } finally {
    probeLeaf?.detach();
  }
})();
