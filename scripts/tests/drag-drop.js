// Live probe for drag-and-drop file/image path insertion (see CLAUDE.md).
//
// A synthetic File object has no real OS-drag path association, so
// webUtils.getPathForFile would throw/return empty for it. We instead monkey-patch
// require("electron").webUtils.getPathForFile itself (Node's require cache means this is
// the same singleton object handleDrop() calls into) to map our fake Files to test paths —
// this exercises the real code path (shell-quoting, multi-file join, pty.write) without
// needing an actual Finder drag.
//
// Run via: scripts/live-test.sh scripts/tests/drag-drop.js
(async () => {
  const VIEW_TYPE = "ghostty-terminal-view";
  const leaves = app.workspace.getLeavesOfType(VIEW_TYPE);
  if (!leaves.length) return { error: "no terminal leaf found" };
  const leaf = leaves[leaves.length - 1];
  const view = leaf.view;
  if (!view.pty || !view.screenEl) return { error: "view not fully initialized" };

  const result = {};

  const fileA = new File([], "plain.png");
  const fileB = new File([], "has space and quote.png");
  const pathA = "/Users/blake/Desktop/plain.png";
  const pathB = "/Users/blake/Desktop/has space and it's a quote.png";

  const electron = require("electron");
  const origGetPathForFile = electron.webUtils.getPathForFile;
  electron.webUtils.getPathForFile = (file) => {
    if (file === fileA) return pathA;
    if (file === fileB) return pathB;
    return "";
  };

  const writes = [];
  const origWrite = view.pty.write.bind(view.pty);
  view.pty.write = (d) => {
    writes.push(d);
    return origWrite(d);
  };

  const dt = new DataTransfer();
  dt.items.add(fileA);
  dt.items.add(fileB);

  const dragOverEvent = new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true });
  view.screenEl.dispatchEvent(dragOverEvent);
  result.hasDragOverClass = view.screenEl.hasClass("is-drag-over");

  const dragLeaveEvent = new DragEvent("dragleave", { bubbles: true });
  view.screenEl.dispatchEvent(dragLeaveEvent);
  result.hasDragOverClassAfterLeave = view.screenEl.hasClass("is-drag-over");

  // Re-arm the drag-over state before drop, same as a real drag sequence would.
  view.screenEl.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
  const dropEvent = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
  view.screenEl.dispatchEvent(dropEvent);
  result.hasDragOverClassAfterDrop = view.screenEl.hasClass("is-drag-over");

  view.pty.write = origWrite;
  electron.webUtils.getPathForFile = origGetPathForFile;

  result.writes = writes;
  const expected = `'${pathA}' '${pathB.replace(/'/g, "'\\''")}'`;
  result.expected = expected;
  result.pass =
    writes.length === 1 &&
    writes[0] === expected &&
    result.hasDragOverClass === true &&
    result.hasDragOverClassAfterLeave === false &&
    result.hasDragOverClassAfterDrop === false;

  return result;
})();
