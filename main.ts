import { existsSync, readFileSync, readdirSync } from "fs";
import { homedir, hostname } from "os";
import { dirname, isAbsolute, join, normalize as normalizeFsPath, relative } from "path";
import {
  App,
  ItemView,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";
import type { IPty } from "node-pty";
import { readFontMetrics, readFontNames, terminalMetrics, type FontMetrics } from "./font-metrics";
import { KittyGraphics, IMAGE_PLACEHOLDER, decodeImageCell, terminalRowCells, type ImageCell } from "./kitty-graphics";
import {
  StyleRunFlags,
  loadGhosttyNative,
  textRangeToCells,
  type GhosttyNative,
  type GhosttyNativeState,
  type GhosttyTerminal,
  type StyleRun,
} from "./native/ghostty";

const VIEW_TYPE_GHOSTTY = "ghostty-terminal-view";
const DEFAULT_FG = 0xffffff;
const DEFAULT_BG = 0x000000;

type TerminalSize = {
  cols: number;
  rows: number;
};

type CharSize = {
  width: number;
  height: number;
  baseline: number;
};

type TerminalTheme = {
  fg: number;
  bg: number;
  fgCss: string;
  bgCss: string;
};

type HoveredLink = {
  uri: string;
  row: number;
  startCol: number;
  endCol: number;
};

const PLAIN_URL_REGEX = /\bhttps?:\/\/[^\s<>"'`]+/g;

// Strip trailing punctuation a sentence would leave stuck to a URL (a period ending a
// sentence, a closing paren that opened before the URL, etc.) — same heuristic most
// autolinkers use.
function trimTrailingUrlPunctuation(url: string): string {
  let trimmed = url;
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    if (".,;:!?'\"".includes(last)) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }
    if (last === ")" && (trimmed.match(/\(/g)?.length ?? 0) < (trimmed.match(/\)/g)?.length ?? 0)) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }
    if (last === "]" && (trimmed.match(/\[/g)?.length ?? 0) < (trimmed.match(/\]/g)?.length ?? 0)) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }
    break;
  }
  return trimmed;
}

type Cell = { col: number; row: number };

class GhosttyTerminalView extends ItemView {
  private pty: IPty | null = null;
  private intentionallyKilled = false;
  private vt: GhosttyTerminal | null = null;
  private graphics: KittyGraphics | null = null;
  private bodyEl: HTMLElement | null = null;
  private screenEl: HTMLElement | null = null;
  private canvasEl: HTMLCanvasElement | null = null;
  private canvasContext: CanvasRenderingContext2D | null = null;
  private linkTooltipEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private pendingRender = false;
  private forceFullRender = true;
  private charSize: CharSize | null = null;
  private viewportSize: TerminalSize = { cols: 80, rows: 24 };
  private themeColors: TerminalTheme = {
    fg: DEFAULT_FG,
    bg: DEFAULT_BG,
    fgCss: "#ffffff",
    bgCss: "#000000",
  };
  private devicePixelRatio = 1;
  private autoScroll = true;
  private composing = false;
  private compositionBuffer = "";
  private scrollLines = 0;
  private hoveredLink: HoveredLink | null = null;
  private lastHoverCell: { col: number; row: number } | null = null;
  private lastHoverModifier = false;
  private fontLoadPromise: Promise<void> | null = null;
  private fontMetrics: FontMetrics | null = null;
  private selectionAnchor: Cell | null = null;
  private selectionFocus: Cell | null = null;
  private isSelecting = false;
  private didDragSelect = false;
  private lastSelectCell: Cell | null = null;
  private sessionTitle = "Agent";
  private oscTitleBuf = "";
  private oscTitleCapturing = false;

  constructor(leaf: WorkspaceLeaf, private plugin: GhosttyPlugin) {
    super(leaf);
  }
  getViewType(): string {
    return VIEW_TYPE_GHOSTTY;
  }

  getDisplayText(): string {
    return this.sessionTitle;
  }

  getIcon(): string {
    return "ghost";
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ghostty-terminal-view");

    const newTerminalAction = this.addAction("plus", "New terminal", () => {
      this.plugin.openNewTerminal(this.leaf).catch(console.error);
    });
    newTerminalAction.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const menu = new Menu();
      menu.addItem((item) =>
        item.setTitle("New Agent session").setIcon("ghost").onClick(() => {
          this.plugin.openNewTerminal(this.leaf).catch(console.error);
        })
      );
      menu.addItem((item) =>
        item.setTitle("New shell (no Agent)").setIcon("terminal").onClick(() => {
          this.plugin.openNewTerminal(this.leaf, { shellOnly: true }).catch(console.error);
        })
      );
      menu.showAtMouseEvent(event);
    });

    this.bodyEl = contentEl;
    this.registerEvent(this.app.workspace.on("css-change", this.handleCssChange));

    // Font must be loaded before startSession() calls measureSize() → getCharSize(),
    // otherwise Canvas falls back to a generic monospace and caches wrong metrics.
    await this.ensureFontLoaded();

    const nativeState = await this.plugin.getNativeState(true);

    if (nativeState.native) {
      this.startSession(nativeState.native);
    } else {
      contentEl.createEl("div", {
        cls: "ghostty-terminal-placeholder",
        text: nativeState.message,
      });
    }
  }

  async onClose(): Promise<void> {
    await Promise.resolve();
    this.stopSession();
    this.contentEl.empty();
  }

  private startSession(native: GhosttyNative): void {
    if (!this.bodyEl) return;
    this.stopSession();

    const screen = this.bodyEl.createEl("div", {
      cls: "ghostty-terminal-screen",
    });
    this.screenEl = screen;

    const canvas = screen.createEl("canvas", {
      cls: "ghostty-terminal-canvas",
    });
    this.canvasEl = canvas;
    this.canvasContext = canvas.getContext("2d");
    if (!this.canvasContext) {
      this.bodyEl.createEl("div", {
        cls: "ghostty-terminal-placeholder",
        text: "Failed to initialize terminal canvas.",
      });
      return;
    }

    this.linkTooltipEl = screen.createEl("div", {
      cls: "ghostty-terminal-link-tooltip",
    });

    const input = this.bodyEl.createEl("textarea", {
      cls: "ghostty-terminal-input",
    });
    input.spellcheck = false;
    input.autocapitalize = "off";
    input.autocomplete = "off";
    input.setAttribute("autocorrect", "off");
    this.inputEl = input;

    const { cols, rows } = this.measureSize();
    this.viewportSize = { cols, rows };
    this.vt = native.createTerminal(cols, rows);
    this.applyThemeColors();
    this.applyGhosttyPalette();

    let spawnPty: typeof import("node-pty").spawn;
    try {
      const pluginDir = this.plugin.getPluginDirPath();
      const nodePtyPath = pluginDir
        ? join(pluginDir, "node_modules", "node-pty")
        : "node-pty";
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Native node-pty module needs runtime require() for dynamic path resolution in Electron
      ({ spawn: spawnPty } = require(nodePtyPath) as typeof import("node-pty"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.bodyEl?.createEl("div", {
        cls: "ghostty-terminal-placeholder",
        text: `Failed to load node-pty: ${message}`,
      });
      return;
    }

    const shell = resolveShell(this.plugin.settings.shell);

    const shellOnly = this.plugin.consumeShellOnlyFlag();
    const cwd = this.plugin.getStartDirectory();

    this.pty = spawnPty(shell, [], {
      // node-pty sets env.TERM from `name` unconditionally (unixTerminal.js), clobbering
      // any TERM passed via `env` below — so TERM has to be driven from here, not there.
      // "xterm-ghostty" matches real Ghostty's own TERM value and has a terminfo entry
      // installed system-wide by the Ghostty app already.
      name: "xterm-ghostty",
      cols,
      rows,
      cwd,
      // Identify as real Ghostty so terminal-aware CLIs (e.g. Claude Code's Shift+Enter /
      // image-paste detection) treat this session the same way they'd treat a native
      // Ghostty window, rather than the generic xterm-256color they'd otherwise see.
      env: {
        ...process.env,
        TERM_PROGRAM: "ghostty",
        TERM_PROGRAM_VERSION: "1.3.1",
        COLORTERM: "truecolor",
      } as Record<string, string>,
    });

    this.intentionallyKilled = false;
    this.graphics = new KittyGraphics(
      () => this.scheduleRender(true),
      (reply) => this.pty?.write(reply),
    );

    this.pty.onData((data) => {
      if (!this.vt) return;
      this.vt.feed(data);
      const responses = this.vt.takeResponses();
      if (responses) this.pty?.write(responses);
      this.graphics?.feed(data);
      this.parseOscTitleFromStream(data);
      this.scheduleRender();
    });

    // Only a natural shell exit (user ran `exit`, or exited the agent and then the shell)
    // closes the tab — stopSession() sets intentionallyKilled before pty.kill(), which
    // also fires onExit, so that case is excluded here to avoid detaching an already-
    // closing (or already-replaced) leaf.
    this.pty.onExit(() => {
      if (this.intentionallyKilled) return;
      this.leaf.detach();
    });

    const agentCommand = this.plugin.agentCommand();
    if (!shellOnly && agentCommand) {
      this.pty.write(`${agentCommand}\r`);
    }

    this.bodyEl.tabIndex = 0;
    this.bodyEl.addEventListener("mousedown", this.focusTerminal);
    this.bodyEl.addEventListener("click", this.focusTerminal);
    this.screenEl.addEventListener("scroll", this.handleScroll, { passive: true });
    this.screenEl.addEventListener("wheel", this.handleWheel, { passive: false });
    this.screenEl.addEventListener("mousemove", this.handleMouseMove, {
      passive: true,
    });
    this.screenEl.addEventListener("mouseleave", this.handleMouseLeave);
    this.screenEl.addEventListener("mousedown", this.handleSelectionMouseDown);
    document.addEventListener("mouseup", this.handleSelectionMouseUp);
    this.screenEl.addEventListener("click", this.handleScreenClick, true);
    this.screenEl.addEventListener("dragover", this.handleDragOver);
    this.screenEl.addEventListener("dragleave", this.handleDragLeave);
    this.screenEl.addEventListener("drop", this.handleDrop);
    // Global (not scoped to inputEl) so the link-hover cursor/underline updates the instant
    // Cmd/Ctrl is pressed or released, even if the mouse hasn't moved since.
    window.addEventListener("keydown", this.handleLinkModifierChange, true);
    window.addEventListener("keyup", this.handleLinkModifierChange, true);
    this.inputEl.addEventListener("keydown", this.handleKeyDown, true);
    this.inputEl.addEventListener("paste", this.handlePaste, true);
    this.inputEl.addEventListener("input", this.handleInput, true);
    this.inputEl.addEventListener(
      "compositionstart",
      this.handleCompositionStart,
      true
    );
    this.inputEl.addEventListener(
      "compositionupdate",
      this.handleCompositionUpdate,
      true
    );
    this.inputEl.addEventListener(
      "compositionend",
      this.handleCompositionEnd,
      true
    );
    this.inputEl.addEventListener("focus", this.handleFocus);
    this.inputEl.addEventListener("blur", this.handleBlur);
    this.inputEl.focus();

    this.resizeObserver = new ResizeObserver(() => {
      // Invalidate char size cache on resize
      this.charSize = null;
      this.updateSize(true);
    });
    this.resizeObserver.observe(screen);

    // Delay initial render to ensure styles are applied
    requestAnimationFrame(() => {
      this.charSize = null; // Re-measure after styles are applied
      this.updateSize(true);
      this.scheduleRender(true);
    });
  }

  private stopSession(): void {
    this.graphics?.dispose();
    this.graphics = null;
    if (this.bodyEl) {
      this.bodyEl.removeEventListener("mousedown", this.focusTerminal);
      this.bodyEl.removeEventListener("click", this.focusTerminal);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.pty) {
      this.intentionallyKilled = true;
      try {
        this.pty.kill();
      } catch {
        // ignore
      }
      this.pty = null;
    }
    if (this.vt) {
      this.vt.free();
      this.vt = null;
    }
    if (this.screenEl) {
      this.screenEl.removeEventListener("scroll", this.handleScroll);
      this.screenEl.removeEventListener("wheel", this.handleWheel);
      this.screenEl.removeEventListener("mousemove", this.handleMouseMove);
      this.screenEl.removeEventListener("mouseleave", this.handleMouseLeave);
      this.screenEl.removeEventListener("mousedown", this.handleSelectionMouseDown);
      this.screenEl.removeEventListener("click", this.handleScreenClick, true);
      this.screenEl.removeEventListener("dragover", this.handleDragOver);
      this.screenEl.removeEventListener("dragleave", this.handleDragLeave);
      this.screenEl.removeEventListener("drop", this.handleDrop);
    }
    document.removeEventListener("mouseup", this.handleSelectionMouseUp);
    window.removeEventListener("keydown", this.handleLinkModifierChange, true);
    window.removeEventListener("keyup", this.handleLinkModifierChange, true);
    if (this.inputEl) {
      this.inputEl.removeEventListener("keydown", this.handleKeyDown, true);
      this.inputEl.removeEventListener("paste", this.handlePaste, true);
      this.inputEl.removeEventListener("input", this.handleInput, true);
      this.inputEl.removeEventListener(
        "compositionstart",
        this.handleCompositionStart,
        true
      );
      this.inputEl.removeEventListener(
        "compositionupdate",
        this.handleCompositionUpdate,
        true
      );
      this.inputEl.removeEventListener(
        "compositionend",
        this.handleCompositionEnd,
        true
      );
      this.inputEl.removeEventListener("focus", this.handleFocus);
      this.inputEl.removeEventListener("blur", this.handleBlur);
    }
    this.screenEl = null;
    this.canvasEl = null;
    this.canvasContext = null;
    this.linkTooltipEl = null;
    this.inputEl = null;
    this.pendingRender = false;
    this.forceFullRender = true;
    this.charSize = null;
    this.viewportSize = { cols: 80, rows: 24 };
    this.autoScroll = true;
    this.composing = false;
    this.compositionBuffer = "";
    this.scrollLines = 0;
    this.hoveredLink = null;
    this.lastHoverCell = null;
    this.selectionAnchor = null;
    this.selectionFocus = null;
    this.isSelecting = false;
    this.didDragSelect = false;
    this.lastSelectCell = null;
  }

  private scheduleRender(forceFull = false): void {
    if (forceFull) {
      this.forceFullRender = true;
    }
    if (this.pendingRender || !this.canvasEl || !this.canvasContext || !this.vt) {
      return;
    }
    this.pendingRender = true;
    requestAnimationFrame(() => {
      this.pendingRender = false;
      this.renderFrame();
    });
  }

  private renderFrame(): void {
    if (!this.canvasEl || !this.canvasContext || !this.vt) return;

    const canvasChanged = this.syncCanvasSize();
    const scrollDelta = this.vt.takeViewportScrollDelta();
    const forceFull = this.forceFullRender || canvasChanged || scrollDelta !== 0;
    this.forceFullRender = false;

    const { rows } = this.viewportSize;
    const dirtyRows = forceFull
      ? this.allViewportRows()
      : this.vt.takeDirtyViewportRows(rows);

    if (forceFull) {
      this.clearCanvas();
    }

    for (const row of dirtyRows) {
      if (row >= 0 && row < rows) {
        this.renderRow(row);
      }
    }

    this.drawSelection();
    this.drawHoveredLink();
    this.updateCaret();
  }

  private updateSize(forceFull = false): void {
    if (!this.vt || !this.pty) return;
    const { cols, rows } = this.measureSize();
    const changed = cols !== this.viewportSize.cols || rows !== this.viewportSize.rows;
    this.viewportSize = { cols, rows };
    const { width, height } = this.getCharSize();
    const dpr = window.devicePixelRatio || 1;
    this.vt.resize(cols, rows, width * dpr, height * dpr);
    this.pty.resize(cols, rows);
    this.scheduleRender(forceFull || changed);
  }

  private measureSize(): TerminalSize {
    const target = this.screenEl ?? this.bodyEl;
    if (!target) {
      return { cols: 80, rows: 24 };
    }
    const rect = this.getTerminalContentRect(target);
    const { width, height } = this.getCharSize();
    const cols = Math.max(2, Math.floor(rect.width / width));
    const rows = Math.max(2, Math.floor(rect.height / height));
    return { cols, rows };
  }

  // Load the terminal font via FontFace so Canvas measureText() uses the correct
  // glyphs and metrics before we compute charSize.  Must be awaited before
  // startSession() calls measureSize() → getCharSize().
  private ensureFontLoaded(): Promise<void> {
    if (this.fontLoadPromise) return this.fontLoadPromise;
    const { family, filePath, faces } = this.plugin.terminalFont;
    if (!filePath) {
      console.warn("[ghostty] No font file found — Canvas will use system monospace fallback");
      this.fontLoadPromise = Promise.resolve();
      return this.fontLoadPromise;
    }
    this.fontLoadPromise = (async () => {
      try {
        // Read font bytes and encode as base64 data URI.
        // This avoids Electron CSP restrictions on file:// URLs in FontFace,
        // and works regardless of whether the font is in Electron's font cache.
        try {
          this.fontMetrics = readFontMetrics(readFileSync(filePath));
        } catch (error) {
          console.warn("[ghostty] Font metrics unavailable; using Canvas metrics:", error);
        }
        await Promise.all(faces.map(async ({ filePath: path, style, weight }) => {
          if (!path) {
            console.warn(`[ghostty] Missing ${style}/${weight} font face; using font synthesis`);
            return;
          }
          const bytes = readFileSync(path);
          const mime = path.toLowerCase().endsWith(".otf") ? "font/otf" : "font/ttf";
          const face = new FontFace(family, `url(data:${mime};base64,${bytes.toString("base64")})`, { style, weight });
          await face.load();
          (document.fonts as FontFaceSet & { add(face: FontFace): FontFaceSet }).add(face);
        }));
      } catch (e) {
        console.error("[ghostty] FontFace.load() failed:", e);
      }
    })();
    return this.fontLoadPromise;
  }

  private getCharSize(): CharSize {
    if (this.charSize) return this.charSize;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      this.charSize = { width: 8, height: 16, baseline: 13 };
      return this.charSize;
    }

    ctx.font = this.getCanvasFont(0);
    const width = ctx.measureText("MMMMMMMMMM").width / 10;
    const dpr = window.devicePixelRatio || 1;
    if (this.fontMetrics) {
      this.charSize = terminalMetrics(width, this.plugin.terminalFont.size, dpr, this.fontMetrics);
      return this.charSize;
    }

    // Approximate the line box only when SFNT metrics are unavailable.
    const m = ctx.measureText("Mg|");
    const fbAscent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent * 1.2;
    const fbDescent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent * 1.5;
    const height = Math.round((fbAscent + fbDescent) * dpr) / dpr;
    const baseline = Math.round(fbAscent * dpr) / dpr;
    this.charSize = { width: Math.round(width * dpr) / dpr, height, baseline };
    return this.charSize;
  }

  private getTerminalContentRect(target: HTMLElement): { width: number; height: number } {
    const rect = target.getBoundingClientRect();
    const style = getComputedStyle(target);
    const horizontalPadding =
      Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
    const verticalPadding =
      Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    return {
      width: Math.max(1, rect.width - horizontalPadding),
      height: Math.max(1, rect.height - verticalPadding),
    };
  }

  private syncCanvasSize(): boolean {
    if (!this.canvasEl || !this.canvasContext) return false;

    const rect = this.canvasEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));
    const changed =
      this.canvasEl.width !== width ||
      this.canvasEl.height !== height ||
      this.devicePixelRatio !== dpr;

    if (changed) {
      this.canvasEl.width = width;
      this.canvasEl.height = height;
      const dprChanged = this.devicePixelRatio !== dpr;
      this.devicePixelRatio = dpr;
      if (dprChanged) {
        this.charSize = null;
        this.updateSize(true);
      }
    }

    this.canvasContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.canvasContext.imageSmoothingEnabled = false;
    return changed;
  }

  private clearCanvas(): void {
    if (!this.canvasEl || !this.canvasContext) return;
    const rect = this.canvasEl.getBoundingClientRect();
    this.canvasContext.fillStyle = this.themeColors.bgCss;
    this.canvasContext.fillRect(0, 0, rect.width, rect.height);
  }

  private renderRow(row: number): void {
    if (!this.canvasEl || !this.canvasContext || !this.vt) return;

    const { cols } = this.viewportSize;
    const { width, height, baseline } = this.getCharSize();
    const rect = this.canvasEl.getBoundingClientRect();
    const y = row * height;
    const cells = this.vt.dumpViewportRowCells(row);
    const runs = this.vt.dumpViewportRowStyleRuns(row);
    const ctx = this.canvasContext;

    ctx.fillStyle = this.themeColors.bgCss;
    ctx.fillRect(0, y, rect.width, height);

    if (runs.length === 0) {
      this.drawTextRun(cells, 0, cols, y, baseline, 0, this.themeColors);
      this.drawImageCells(cells, row, []);
      return;
    }

    for (const run of runs) {
      ctx.fillStyle = this.colorToCss(run.bg);
      ctx.fillRect((run.startCol - 1) * width, y, (run.endCol - run.startCol + 1) * width, height);
    }
    for (const run of runs) {
      const start = Math.max(0, Math.min(cols, run.startCol === 0 ? run.startCol : run.startCol - 1));
      const end = Math.max(start, Math.min(cols, run.endCol));
      if (end <= start) continue;

      const runTheme: TerminalTheme = {
        fg: run.fg,
        bg: run.bg,
        fgCss: this.colorToCss(run.fg),
        bgCss: this.colorToCss(run.bg),
      };
      this.drawTextRun(
        cells.slice(start, end),
        start,
        end,
        y,
        baseline,
        run.flags,
        runTheme
      );
    }
    this.drawImageCells(cells, row, runs);
  }

  private drawImageCells(cells: string[], row: number, runs: StyleRun[]): void {
    if (!this.canvasContext || !this.graphics) return;
    const { width, height } = this.getCharSize();
    let previous: ImageCell | undefined;
    for (let col = 0; col < cells.length; col++) {
      const run = runs.find((item) => col >= item.startCol - 1 && col < item.endCol);
      const cell = decodeImageCell(cells[col], run?.fg ?? this.themeColors.fg, previous);
      previous = cell ?? undefined;
      if (cell && !(run && run.flags & StyleRunFlags.invisible)) {
        this.graphics.drawCell(this.canvasContext, cell, col * width, row * height, width, height);
      }
    }
  }

  private drawTextRun(
    cells: string[],
    startCol: number,
    endCol: number,
    y: number,
    baseline: number,
    flags: number,
    theme: TerminalTheme
  ): void {
    if (!this.canvasContext) return;
    const ctx = this.canvasContext;
    const { width, height } = this.getCharSize();
    const x = startCol * width;
    const runWidth = (endCol - startCol) * width;

    if (flags & StyleRunFlags.invisible) return;

    ctx.font = this.getCanvasFont(flags);
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = theme.fgCss;
    ctx.globalAlpha = flags & StyleRunFlags.faint ? 0.55 : 1;
    // Render each cell at its exact grid position so Canvas advance widths
    // cannot cause drift (space chars especially vary across fonts/renderers).
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] && !cells[i].startsWith(IMAGE_PLACEHOLDER)) {
        const wide = cells[i + 1] === "" ? 2 : 1;
        const glyphX = x + i * width;
        if (!this.drawBlockGlyph(cells[i], glyphX, y, width, height) &&
            !this.drawBoxGlyph(cells[i], glyphX, y, width, height)) {
          if (wide === 2) {
            const advance = ctx.measureText(cells[i]).width;
            ctx.fillText(cells[i], glyphX + Math.max(0, (2 * width - advance) / 2), y + baseline, 2 * width);
          } else {
            ctx.fillText(cells[i], glyphX, y + baseline);
          }
        }
      }
    }
    ctx.globalAlpha = 1;

    if (flags & StyleRunFlags.underline) {
      this.drawTextDecoration(x, y + height - 2, runWidth, theme.fgCss);
    }
    if (flags & StyleRunFlags.strikethrough) {
      this.drawTextDecoration(x, y + height * 0.55, runWidth, theme.fgCss);
    }
  }

  private drawBlockGlyph(glyph: string, x: number, y: number, width: number, height: number): boolean {
    const cp = glyph.codePointAt(0);
    if (glyph.length !== 1 || cp === undefined || cp < 0x2580 || cp > 0x259f || !this.canvasContext) {
      return false;
    }
    const ctx = this.canvasContext;
    const dpr = this.devicePixelRatio;
    const cellWidth = Math.round(width * dpr);
    const cellHeight = Math.round(height * dpr);
    if (cp >= 0x2596) {
      const mask = [4, 8, 1, 13, 9, 7, 11, 2, 6, 14][cp - 0x2596];
      const midX = Math.round(cellWidth / 2);
      const midY = Math.round(cellHeight / 2);
      ctx.beginPath();
      for (let quadrant = 0; quadrant < 4; quadrant++) {
        if (!(mask & (1 << quadrant))) continue;
        const left = quadrant % 2 ? cellWidth - midX : 0;
        const top = quadrant >= 2 ? cellHeight - midY : 0;
        ctx.rect(x + left / dpr, y + top / dpr, midX / dpr, midY / dpr);
      }
      // Ghostty overlaps rounded halves on odd-sized cells; composite their union once.
      ctx.fill();
      return true;
    }
    let w = cellWidth;
    let h = cellHeight;
    let left = 0;
    let top = 0;
    if (cp === 0x2580 || cp === 0x2594) {
      h = Math.round(cellHeight * (cp === 0x2580 ? 1 / 2 : 1 / 8));
    } else if (cp >= 0x2581 && cp <= 0x2587) {
      h = Math.round(cellHeight * (cp - 0x2580) / 8);
      top = cellHeight - h;
    } else if (cp >= 0x2589 && cp <= 0x258f) {
      w = Math.round(cellWidth * (0x2590 - cp) / 8);
    } else if (cp === 0x2590 || cp === 0x2595) {
      w = Math.round(cellWidth * (cp === 0x2590 ? 1 / 2 : 1 / 8));
      left = cellWidth - w;
    }
    const alpha = ctx.globalAlpha;
    if (cp >= 0x2591 && cp <= 0x2593) ctx.globalAlpha = alpha * (cp - 0x2590) * 64 / 255;
    ctx.fillRect(x + left / dpr, y + top / dpr, w / dpr, h / dpr);
    ctx.globalAlpha = alpha;
    return true;
  }

  private drawBoxGlyph(glyph: string, x: number, y: number, width: number, height: number): boolean {
    const index = "─│┌┐└┘├┤┬┴┼━┃┏┓┗┛┣┫┳┻╋".indexOf(glyph);
    if (index < 0 || glyph.length !== 1 || !this.canvasContext) return false;
    const directions = ["lr", "ud", "rd", "ld", "ru", "lu", "urd", "uld", "lrd", "lru", "lrud"][index % 11];
    const dpr = this.devicePixelRatio;
    const font = this.fontMetrics;
    const unitThickness = font && font.underlineThickness > 0
      ? font.underlineThickness / font.unitsPerEm : 0.05;
    const lightPixels = Math.max(1, Math.ceil(unitThickness * this.plugin.terminalFont.size * dpr));
    const pixels = lightPixels * (index < 11 ? 1 : 2);
    const thickness = pixels / dpr;
    const cx = x + Math.max(0, Math.floor((width * dpr - pixels) / 2)) / dpr;
    const cy = y + Math.max(0, Math.floor((height * dpr - pixels) / 2)) / dpr;
    const ctx = this.canvasContext;
    if (directions.includes("l")) ctx.fillRect(x, cy, cx - x + thickness, thickness);
    if (directions.includes("r")) ctx.fillRect(cx, cy, x + width - cx, thickness);
    if (directions.includes("u")) ctx.fillRect(cx, y, thickness, cy - y + thickness);
    if (directions.includes("d")) ctx.fillRect(cx, cy, thickness, y + height - cy);
    return true;
  }

  private drawTextDecoration(
    x: number,
    y: number,
    width: number,
    color: string
  ): void {
    if (!this.canvasContext) return;
    const ctx = this.canvasContext;
    ctx.strokeStyle = color;
    const dpr = this.devicePixelRatio;
    ctx.lineWidth = 1 / dpr;
    ctx.beginPath();
    ctx.moveTo(x, (Math.round(y * dpr) + 0.5) / dpr);
    ctx.lineTo(x + width, (Math.round(y * dpr) + 0.5) / dpr);
    ctx.stroke();
  }

  private drawSelection(): void {
    const sel = this.normalizedSelection();
    if (!sel || !this.canvasContext) return;
    const { startRow, startCol, endRow, endCol } = sel;
    const { width, height } = this.getCharSize();
    const { cols, rows } = this.viewportSize;
    const ctx = this.canvasContext;

    const { selectionBg } = this.plugin.terminalColorConfig;
    ctx.fillStyle = this.colorToRgba(selectionBg ?? this.themeColors.fg, 0.35);

    for (let row = startRow; row <= endRow; row++) {
      const rowIndex = row - 1;
      if (rowIndex < 0 || rowIndex >= rows) continue;
      const fromCol = row === startRow ? startCol : 1;
      const toCol = row === endRow ? endCol : cols;
      if (toCol < fromCol) continue;
      const x = (fromCol - 1) * width;
      const y = rowIndex * height;
      ctx.fillRect(x, y, (toCol - fromCol + 1) * width, height);
    }
  }

  // Selection anchor/focus in mousedown/mousemove order; normalize to
  // top-left → bottom-right (row-major, then column) reading order.
  private normalizedSelection(): {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
  } | null {
    if (!this.selectionAnchor || !this.selectionFocus) return null;
    let a = this.selectionAnchor;
    let b = this.selectionFocus;
    if (a.row > b.row || (a.row === b.row && a.col > b.col)) {
      [a, b] = [b, a];
    }
    if (a.row === b.row && a.col === b.col) return null;
    return { startRow: a.row, startCol: a.col, endRow: b.row, endCol: b.col };
  }

  private clearSelection(): void {
    if (!this.selectionAnchor && !this.selectionFocus) return;
    this.selectionAnchor = null;
    this.selectionFocus = null;
    this.scheduleRender(true);
  }

  private getSelectedText(): string {
    const sel = this.normalizedSelection();
    if (!sel || !this.vt) return "";
    const { startRow, startCol, endRow, endCol } = sel;
    const { cols } = this.viewportSize;

    const lines: string[] = [];
    for (let row = startRow; row <= endRow; row++) {
      const cells = this.vt.dumpViewportRowCells(row - 1);
      let from = row === startRow ? startCol - 1 : 0;
      if (cells[from] === "" && from > 0) from--;
      const to = row === endRow ? endCol : cols;
      lines.push(cells.slice(from, to).join("").replace(/\s+$/, ""));
    }
    return lines.join("\n");
  }

  private copyToClipboard(text: string): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron clipboard needs runtime require() (same pattern as node-pty above); no @types/electron dependency, so cast to the minimal shape we use
      const { clipboard } = require("electron") as {
        clipboard: { writeText(text: string): void };
      };
      clipboard.writeText(text);
    } catch (error) {
      console.error("[ghostty] Failed to copy selection to clipboard:", error);
    }
  }

  private drawHoveredLink(): void {
    if (!this.hoveredLink || !this.canvasContext) return;
    const { row, startCol, endCol } = this.hoveredLink;
    const rowIndex = row - 1;
    if (rowIndex < 0 || rowIndex >= this.viewportSize.rows) return;

    const { width, height } = this.getCharSize();
    const x = (startCol - 1) * width;
    const y = rowIndex * height + height - 2;
    this.drawTextDecoration(
      x,
      y,
      Math.max(width, (endCol - startCol) * width),
      this.themeColors.fgCss
    );
  }

  private rowTextToCells(rowText: string, cols: number): string[] {
    return terminalRowCells(rowText, cols);
  }

  private allViewportRows(): number[] {
    return Array.from({ length: this.viewportSize.rows }, (_, row) => row);
  }

  private getCanvasFont(flags: number): string {
    const { family, size } = this.plugin.terminalFont;
    const fontStyle = flags & StyleRunFlags.italic ? "italic" : "normal";
    const fontWeight = flags & StyleRunFlags.bold ? "700" : "400";
    return `${fontStyle} ${fontWeight} ${size}px ${family}`;
  }

  private focusTerminal = (): void => {
    this.inputEl?.focus();
  };

  // Font size changed in settings: re-measure cells and re-layout the grid in place.
  refreshFont(): void {
    this.charSize = null;
    if (this.vt) this.updateSize(true);
  }

  focusInput(): void {
    this.inputEl?.focus();
  }

  private updateCaret(): void {
    if (!this.screenEl || !this.vt) return;
    const cursor = this.vt.cursorPosition();
    if (!cursor?.valid) {
      this.screenEl.setCssProps({ "--ghostty-caret-visible": "0" });
      return;
    }
    
    // Hide caret when scrolled away from the active screen
    if (!this.autoScroll) {
      this.screenEl.setCssProps({ "--ghostty-caret-visible": "0" });
      return;
    }
    
    const { width, height } = this.getCharSize();
    // Cursor position is 1-indexed from VT, convert to 0-indexed pixels
    const x = (cursor.col - 1) * width;
    const y = (cursor.row - 1) * height;
    this.screenEl.setCssProps({
      "--ghostty-caret-x": `${x}px`,
      "--ghostty-caret-y": `${y}px`,
      "--ghostty-caret-w": `${width}px`,
      "--ghostty-caret-h": `${height}px`,
      "--ghostty-caret-visible": "1",
    });
  }

  private parseOscTitleFromStream(data: string): void {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (this.oscTitleCapturing) {
        if (ch === "\x07") {
          // BEL terminator
          this.setSessionTitle(this.oscTitleBuf);
          this.oscTitleCapturing = false;
          this.oscTitleBuf = "";
        } else if (ch === "\x1b" && data[i + 1] === "\\") {
          // ST (ESC \) terminator
          this.setSessionTitle(this.oscTitleBuf);
          this.oscTitleCapturing = false;
          this.oscTitleBuf = "";
          i++;
        } else {
          this.oscTitleBuf += ch;
        }
      } else if (ch === "\x1b" && data[i + 1] === "]") {
        const code = data.slice(i + 2, i + 4);
        if (code === "0;" || code === "2;") {
          this.oscTitleCapturing = true;
          this.oscTitleBuf = "";
          i += 3; // skip ESC ] N ;
        }
      }
    }
  }

  private setSessionTitle(raw: string): void {
    const title = raw.replace(/[\x00-\x1f]/g, "").trim();
    if (!title || title === this.sessionTitle) return;
    // Use the title supplied by the running terminal application.
    this.sessionTitle = title.length > 40 ? title.slice(0, 38) + "…" : title;
    // Neither is kept in sync with getDisplayText() automatically — each needs its own
    // explicit refresh:
    // - Tab label: updateHeader() (undocumented, not in obsidian.d.ts, but present at
    //   runtime — verified on 1.13.4) re-pulls getDisplayText() into the tab strip.
    // - View header (the bar above the terminal content, separate DOM from the tab):
    //   titleEl is only set once by the framework: at initial view creation, not on later
    //   getDisplayText() changes, so it has to be written directly.
    (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    (this as unknown as { titleEl?: HTMLElement }).titleEl?.setText(this.sessionTitle);
  }

  private handleFocus = (): void => {
    this.screenEl?.addClass("is-focused");
  };

  private handleBlur = (): void => {
    this.screenEl?.removeClass("is-focused");
  };

  private handleCssChange = (): void => {
    this.charSize = null;
    this.applyThemeColors();
    this.updateSize(true);
    this.scheduleRender(true);
  };

  private handleScroll = (): void => {
    this.updateCaret();
  };

  private handleWheel = (event: WheelEvent): void => {
    if (!this.vt) return;
    event.preventDefault();

    const { height } = this.getCharSize();
    this.scrollLines += event.deltaY;

    const linesToScroll = Math.trunc(this.scrollLines / height);
    if (linesToScroll !== 0) {
      this.scrollLines -= linesToScroll * height;
      // Negative = scroll up (show older content), positive = scroll down
      const result = this.vt.scrollViewport(linesToScroll);
      if (result === 0) {
        if (linesToScroll < 0) {
          this.autoScroll = false;
        } else {
          // Scrolling down - re-enable autoScroll
          this.autoScroll = true;
        }
        this.scheduleRender();
      }
    }
  };

  private handleMouseMove = (event: MouseEvent): void => {
    if (this.isSelecting) {
      this.updateSelectionDrag(event);
      return;
    }

    const cell = this.eventToCell(event);
    if (!cell) {
      this.setHoveredLink(null);
      return;
    }
    const modifierHeld = event.metaKey || event.ctrlKey;
    if (
      this.lastHoverCell?.col === cell.col &&
      this.lastHoverCell?.row === cell.row &&
      this.lastHoverModifier === modifierHeld
    ) {
      this.positionLinkTooltip(event);
      return;
    }

    this.lastHoverCell = cell;
    this.lastHoverModifier = modifierHeld;
    // Links only light up while Cmd/Ctrl is held — matches real Ghostty/iTerm2, and keeps a
    // bare click free for normal terminal interaction (positioning, drag-select, etc.).
    this.setHoveredLink(modifierHeld ? this.findLinkAt(cell.col, cell.row) : null);
    this.positionLinkTooltip(event);
  };

  private handleMouseLeave = (): void => {
    this.lastHoverCell = null;
    this.setHoveredLink(null);
  };

  // Re-evaluates link hover the instant Cmd/Ctrl is pressed or released, without waiting for
  // the next mousemove (e.g. holding the mouse still and pressing Cmd).
  private handleLinkModifierChange = (event: KeyboardEvent): void => {
    if (event.key !== "Meta" && event.key !== "Control") return;
    if (!this.lastHoverCell) return;
    const modifierHeld = event.metaKey || event.ctrlKey;
    if (modifierHeld === this.lastHoverModifier) return;
    this.lastHoverModifier = modifierHeld;
    this.setHoveredLink(
      modifierHeld ? this.findLinkAt(this.lastHoverCell.col, this.lastHoverCell.row) : null
    );
  };

  private handleScreenClick = (event: MouseEvent): void => {
    if (this.didDragSelect) {
      // Suppress link-open on the click that follows a real drag selection.
      this.didDragSelect = false;
      return;
    }
    if (!this.hoveredLink || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    this.openHyperlink(this.hoveredLink.uri).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Failed to open link: ${message}`);
    });
  };

  private handleSelectionMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    const cell = this.eventToCellClamped(event);
    if (!cell) return;
    event.preventDefault();

    this.clearSelection();
    this.isSelecting = true;
    this.didDragSelect = false;
    this.selectionAnchor = cell;
    this.selectionFocus = cell;
    this.lastSelectCell = cell;
  };

  private updateSelectionDrag(event: MouseEvent): void {
    const cell = this.eventToCellClamped(event);
    if (!cell) return;
    if (this.lastSelectCell?.col === cell.col && this.lastSelectCell?.row === cell.row) {
      return;
    }
    this.lastSelectCell = cell;
    this.selectionFocus = cell;
    if (
      this.selectionAnchor &&
      (cell.col !== this.selectionAnchor.col || cell.row !== this.selectionAnchor.row)
    ) {
      this.didDragSelect = true;
    }
    this.scheduleRender(true);
  }

  private handleSelectionMouseUp = (): void => {
    if (!this.isSelecting) return;
    this.isSelecting = false;

    if (!this.didDragSelect) {
      // Plain click, no drag: clear any stale selection and let the click
      // handler (link-open) run normally.
      this.clearSelection();
      return;
    }

    const text = this.getSelectedText();
    if (text) {
      this.copyToClipboard(text);
    } else {
      this.clearSelection();
    }
  };

  private eventToCell(event: MouseEvent): { col: number; row: number } | null {
    if (!this.canvasEl) return null;
    const rect = this.canvasEl.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null;

    const { width, height } = this.getCharSize();
    const col = Math.floor(x / width) + 1;
    const row = Math.floor(y / height) + 1;
    if (
      col < 1 ||
      row < 1 ||
      col > this.viewportSize.cols ||
      row > this.viewportSize.rows
    ) {
      return null;
    }
    return { col, row };
  }

  // Like eventToCell but clamps to the viewport bounds instead of returning null,
  // so dragging a selection past the canvas edge still extends the selection.
  private eventToCellClamped(event: MouseEvent): Cell | null {
    if (!this.canvasEl) return null;
    const rect = this.canvasEl.getBoundingClientRect();
    const { width, height } = this.getCharSize();
    const { cols, rows } = this.viewportSize;

    const x = Math.max(0, Math.min(event.clientX - rect.left, rect.width - 1));
    const y = Math.max(0, Math.min(event.clientY - rect.top, rect.height - 1));

    const col = Math.min(cols, Math.max(1, Math.floor(x / width) + 1));
    const row = Math.min(rows, Math.max(1, Math.floor(y / height) + 1));
    return { col, row };
  }

  private findLinkAt(col: number, row: number): HoveredLink | null {
    return this.findOsc8LinkAt(col, row) ?? this.findPlainUrlLinkAt(col, row);
  }

  private findOsc8LinkAt(col: number, row: number): HoveredLink | null {
    if (!this.vt) return null;
    const uri = this.vt.hyperlinkAt(col, row);
    if (!uri) return null;

    let startCol = col;
    while (startCol > 1 && this.vt.hyperlinkAt(startCol - 1, row) === uri) {
      startCol--;
    }

    let endCol = col + 1;
    while (
      endCol <= this.viewportSize.cols &&
      this.vt.hyperlinkAt(endCol, row) === uri
    ) {
      endCol++;
    }

    return { uri, row, startCol, endCol };
  }

  // Fallback for plain URLs Claude Code (or any CLI) prints as bare text rather than
  // wrapping in an OSC 8 hyperlink.
  private findPlainUrlLinkAt(col: number, row: number): HoveredLink | null {
    if (!this.vt) return null;
    const cells = this.vt.dumpViewportRowCells(row - 1);
    const rowText = cells.join("");

    PLAIN_URL_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PLAIN_URL_REGEX.exec(rowText))) {
      const trimmed = trimTrailingUrlPunctuation(match[0]);
      if (!trimmed) continue;
      const startIdx = match.index;
      const endIdx = startIdx + trimmed.length;
      const range = textRangeToCells(cells, startIdx, endIdx);
      if (range && col >= range.startCol && col < range.endCol) {
        return { uri: trimmed, row, ...range };
      }
    }
    return null;
  }

  private setHoveredLink(link: HoveredLink | null): void {
    const previous = this.hoveredLink;
    const changed =
      previous?.uri !== link?.uri ||
      previous?.row !== link?.row ||
      previous?.startCol !== link?.startCol ||
      previous?.endCol !== link?.endCol;
    if (!changed) return;

    this.hoveredLink = link;
    this.screenEl?.toggleClass("has-hovered-link", Boolean(link));

    if (this.linkTooltipEl) {
      this.linkTooltipEl.toggleClass("is-visible", Boolean(link));
      this.linkTooltipEl.textContent = link?.uri ?? "";
    }

    this.scheduleRender(true);
  }

  private positionLinkTooltip(event: MouseEvent): void {
    if (!this.hoveredLink || !this.linkTooltipEl || !this.screenEl) return;
    const screenRect = this.screenEl.getBoundingClientRect();
    const tooltip = this.linkTooltipEl;
    const left = event.clientX - screenRect.left + 12;
    const top = event.clientY - screenRect.top + 14;

    tooltip.style.left = `${Math.max(4, Math.min(left, screenRect.width - 24))}px`;
    tooltip.style.top = `${Math.max(4, Math.min(top, screenRect.height - 24))}px`;
  }

  private handlePaste = (event: ClipboardEvent): void => {
    if (!this.pty) return;
    const text = event.clipboardData?.getData("text");
    if (text) {
      this.pty.write(text);
      event.preventDefault();
      event.stopPropagation();
    }
  };

  private handleDragOver = (event: DragEvent): void => {
    // Without this, the browser's default is to navigate to/open the dropped file.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    this.screenEl?.addClass("is-drag-over");
  };

  private handleDragLeave = (): void => {
    this.screenEl?.removeClass("is-drag-over");
  };

  private handleDrop = (event: DragEvent): void => {
    event.preventDefault();
    this.screenEl?.removeClass("is-drag-over");
    if (!this.pty) return;

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;

    // File dropped from Finder gets its POSIX path via Electron's webUtils — inserted as
    // text (not submitted) so the user can add a prompt around it before pressing Enter,
    // same as typing or pasting a path. No inline image rendering: Claude Code reads image
    // paths straight out of the prompt text, so writing the path is all that's needed.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron webUtils needs runtime require() (same pattern as clipboard above); no @types/electron dependency, so cast to the minimal shape we use
      const { webUtils } = require("electron") as {
        webUtils: { getPathForFile(file: File): string };
      };
      const paths = Array.from(files)
        .map((file) => webUtils.getPathForFile(file))
        .filter((path) => path.length > 0)
        .map((path) => `'${path.replace(/'/g, `'\\''`)}'`);

      if (paths.length > 0) {
        this.pty.write(paths.join(" "));
        this.focusInput();
      }
    } catch (error) {
      console.error("[ghostty] Failed to resolve dropped file path:", error);
    }
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.pty) return;
    
    // Only handle when our input is focused
    if (document.activeElement !== this.inputEl) return;

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.leaf.detach();
      return;
    }
    // Cmd+C: copy selection if one exists; otherwise fall through so the
    // pty write path below is untouched (Ctrl+C, handled separately, sends ETX).
    if (event.metaKey && event.key.toLowerCase() === "c" && this.normalizedSelection()) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.copyToClipboard(this.getSelectedText());
      return;
    }
    if (event.isComposing || event.key === "Process") {
      return;
    }

    // Handle scroll keys with Shift modifier or Page Up/Down
    if (this.handleScrollKey(event)) {
      return;
    }

    let data: string | null = null;

    // Cmd+Backspace = Ctrl+U (kill line backward)
    if (event.metaKey && event.key === "Backspace") {
      data = "\x15";
    // Cmd+A = Ctrl+A (beginning of line)
    } else if (event.metaKey && event.key.toLowerCase() === "a") {
      data = "\x01";
    // Cmd+E = Ctrl+E (end of line)
    } else if (event.metaKey && event.key.toLowerCase() === "e") {
      data = "\x05";
    // Cmd+K = Ctrl+K (kill to end of line)
    } else if (event.metaKey && event.key.toLowerCase() === "k") {
      data = "\x0b";
    // Cmd+U = Ctrl+U (kill to beginning of line)
    } else if (event.metaKey && event.key.toLowerCase() === "u") {
      data = "\x15";
    // Cmd+L = Ctrl+L (clear screen)
    } else if (event.metaKey && event.key.toLowerCase() === "l") {
      data = "\x0c";
    // Option+Left = move back one word (Esc+b)
    } else if (event.altKey && event.key === "ArrowLeft") {
      data = "\x1bb";
    // Option+Right = move forward one word (Esc+f)
    } else if (event.altKey && event.key === "ArrowRight") {
      data = "\x1bf";
    // Option+Backspace = delete word backward (Esc+Backspace)
    } else if (event.altKey && event.key === "Backspace") {
      data = "\x1b\x7f";
    // Option+D = delete word forward
    } else if (event.altKey && event.key.toLowerCase() === "d") {
      data = "\x1bd";
    } else if (event.ctrlKey && event.key.length === 1) {
      const code = event.key.toUpperCase().charCodeAt(0) - 64;
      if (code >= 1 && code <= 26) {
        data = String.fromCharCode(code);
      }
    // Shift+Enter = literal newline in the input, not submit. Ghostty (and iTerm2/Kitty/
    // WezTerm/Warp) bind this to ESC+CR by default: Node's readline keypress parser treats
    // an ESC-prefixed key as meta+<key>, so downstream CLIs (e.g. Claude Code) that check for
    // meta+return already do the right thing here — no terminal-specific config needed.
    } else if (event.key === "Enter" && event.shiftKey) {
      data = "\x1b\r";
    } else if (event.key === "Enter") {
      data = "\r";
    } else if (event.key === "Backspace") {
      data = "\x7f";
    } else if (event.key === "Tab") {
      data = "\t";
    } else if (event.key === "Escape") {
      data = "\x1b";
    } else if (event.key === "ArrowUp") {
      data = "\x1b[A";
    } else if (event.key === "ArrowDown") {
      data = "\x1b[B";
    } else if (event.key === "ArrowRight") {
      data = "\x1b[C";
    } else if (event.key === "ArrowLeft") {
      data = "\x1b[D";
    // Home = beginning of line
    } else if (event.key === "Home") {
      data = "\x1b[H";
    // End = end of line  
    } else if (event.key === "End") {
      data = "\x1b[F";
    // Delete key
    } else if (event.key === "Delete") {
      data = "\x1b[3~";
    }

    if (data) {
      this.pty.write(data);
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }
  };

  private handleScrollKey(event: KeyboardEvent): boolean {
    if (!this.vt) return false;

    let delta = 0;
    const pageSize = this.measureSize().rows - 1;

    if (event.key === "PageUp") {
      delta = -pageSize;
    } else if (event.key === "PageDown") {
      delta = pageSize;
    } else if (event.shiftKey && event.key === "ArrowUp") {
      delta = -1;
    } else if (event.shiftKey && event.key === "ArrowDown") {
      delta = 1;
    } else if (event.key === "Home" && event.shiftKey) {
      // Scroll to top
      this.vt.scrollViewport(-10000);
      this.autoScroll = false;
      this.scheduleRender();
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return true;
    } else if (event.key === "End" && event.shiftKey) {
      // Scroll to bottom
      this.vt.scrollViewport(10000);
      this.autoScroll = true;
      this.scheduleRender();
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return true;
    }

    if (delta !== 0) {
      const result = this.vt.scrollViewport(delta);
      if (result === 0) {
        this.autoScroll = delta > 0; // true if scrolling down, false if up
        this.scheduleRender();
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return true;
    }

    return false;
  };

  private handleInput = (): void => {
    if (!this.pty || !this.inputEl || this.composing) return;
    const value = this.inputEl.value;
    if (value.length > 0) {
      this.pty.write(value);
      this.inputEl.value = "";
    }
  };

  private handleCompositionStart = (): void => {
    this.composing = true;
    this.compositionBuffer = "";
  };

  private handleCompositionUpdate = (event: CompositionEvent): void => {
    this.compositionBuffer = event.data ?? "";
  };

  private handleCompositionEnd = (event: CompositionEvent): void => {
    if (!this.pty || !this.inputEl) return;
    const text = event.data ?? this.compositionBuffer;
    if (text) {
      this.pty.write(text);
    }
    this.inputEl.value = "";
    this.composing = false;
    this.compositionBuffer = "";
  };

  private applyThemeColors(): void {
    const { foreground: themeFg, background: themeBg } = this.plugin.terminalColorConfig;
    const fg = themeFg ?? DEFAULT_FG;
    let bg: number;
    if (themeBg !== null) {
      bg = themeBg;
    } else {
      const target = this.screenEl ?? this.bodyEl ?? document.body;
      const bgCss = getComputedStyle(target).backgroundColor || "#000000";
      bg = this.parseCssColor(bgCss, DEFAULT_BG);
    }
    this.themeColors = {
      fg,
      bg,
      fgCss: this.colorToCss(fg),
      bgCss: this.colorToCss(bg),
    };
    this.vt?.setDefaultColors(fg, bg);
  }

  private applyGhosttyPalette(): void {
    if (!this.vt) return;
    const { palette } = this.plugin.terminalColorConfig;
    // Set as the default palette, so OSC 104 resets to the Ghostty theme.
    this.vt.setPalette(palette);
  }

  private async openHyperlink(uri: string): Promise<void> {
    const trimmed = uri.trim();
    if (!trimmed) return;

    if (/^https?:\/\//i.test(trimmed)) {
      window.open(trimmed, "_blank");
      return;
    }

    const target = this.resolveVaultTarget(trimmed);
    if (!target) {
      new Notice(`No vault file found for ${trimmed}`);
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(target.path);
    if (!(file instanceof TFile)) {
      new Notice(`No vault file found for ${target.path}`);
      return;
    }

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file, {
      active: true,
      eState: target.line
        ? {
            line: Math.max(0, target.line - 1),
            col: target.column ? Math.max(0, target.column - 1) : 0,
          }
        : undefined,
    });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  private resolveVaultTarget(
    uri: string
  ): { path: string; line?: number; column?: number } | null {
    const pathLike = this.uriToPathLike(uri);
    if (!pathLike) return null;

    const location = this.extractPathLocation(pathLike);
    const candidates = this.getVaultPathCandidates(location.path);

    for (const candidate of candidates) {
      const normalized = normalizePath(candidate);
      const file = this.app.vault.getAbstractFileByPath(normalized);
      if (file instanceof TFile) {
        return {
          path: normalized,
          line: location.line,
          column: location.column,
        };
      }
    }

    return null;
  }

  private uriToPathLike(uri: string): string | null {
    if (/^file:\/\//i.test(uri)) {
      try {
        return decodeURIComponent(new URL(uri).pathname);
      } catch {
        return uri.replace(/^file:\/\//i, "");
      }
    }

    if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) {
      return null;
    }

    return uri;
  }

  private extractPathLocation(pathLike: string): {
    path: string;
    line?: number;
    column?: number;
  } {
    const pathWithoutHash = pathLike.split("#", 1)[0].split("?", 1)[0];
    const match = /^(.*?)(?::(\d+))(?::(\d+))?$/.exec(pathWithoutHash);
    if (!match || !match[1]) {
      return { path: pathWithoutHash };
    }

    return {
      path: match[1],
      line: match[2] ? Number.parseInt(match[2], 10) : undefined,
      column: match[3] ? Number.parseInt(match[3], 10) : undefined,
    };
  }

  private getVaultPathCandidates(pathLike: string): string[] {
    const candidates: string[] = [];
    const vaultBasePath = this.getVaultBasePath();

    if (isAbsolute(pathLike)) {
      const absolutePath = normalizeFsPath(pathLike);
      if (vaultBasePath && this.isPathInside(vaultBasePath, absolutePath)) {
        candidates.push(relative(vaultBasePath, absolutePath));
      }
    } else {
      candidates.push(pathLike);

      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
        const activeDir = dirname(activeFile.path);
        candidates.push(activeDir === "." ? pathLike : join(activeDir, pathLike));
      }
    }

    return Array.from(new Set(candidates));
  }

  private getVaultBasePath(): string | null {
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    const basePath = adapter.getBasePath?.();
    return basePath ? normalizeFsPath(basePath) : null;
  }

  private isPathInside(parent: string, child: string): boolean {
    const diff = relative(parent, child);
    return diff === "" || (!diff.startsWith("..") && !isAbsolute(diff));
  }

  private parseCssColor(value: string, fallback: number): number {
    const trimmed = value.trim();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
    if (hex) {
      const raw = hex[1];
      const normalized =
        raw.length === 3
          ? raw
              .split("")
              .map((part) => `${part}${part}`)
              .join("")
          : raw;
      return Number.parseInt(normalized, 16);
    }

    const rgb = /^rgba?\(([^)]+)\)$/i.exec(trimmed);
    if (rgb) {
      const [r, g, b] = rgb[1]
        .split(",")
        .slice(0, 3)
        .map((part) => Math.max(0, Math.min(255, Number.parseFloat(part))));
      if ([r, g, b].every((part) => Number.isFinite(part))) {
        return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
      }
    }

    return fallback;
  }

  private colorToCss(color: number): string {
    return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
  }

  private colorToRgba(color: number, alpha: number): string {
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
}

type TerminalFont = {
  family: string;   // CSS family name used with Canvas — always "GhosttyTerminalFont" when loaded from file
  size: number;     // px, from Ghostty font-size
  filePath: string; // absolute path to the TTF/OTF file, or "" if not found
  faces: { filePath: string; style: "normal" | "italic"; weight: "400" | "700" }[];
};

type GhosttyColorConfig = {
  palette: Map<number, number>; // ANSI palette index 0-255 → 0xRRGGBB
  foreground: number | null;    // default fg (0xRRGGBB), null if not in config/theme
  background: number | null;    // default bg (0xRRGGBB), null if not in config/theme
  selectionBg: number | null;   // selection-background (0xRRGGBB), null if not in config/theme
};

const EMPTY_COLOR_CONFIG: GhosttyColorConfig = {
  palette: new Map(),
  foreground: null,
  background: null,
  selectionBg: null,
};

// We load the font ourselves via FontFace so we assign our own internal CSS name.
// This avoids relying on Electron knowing the system CSS family name for the font.
const GHOSTTY_FONT_FAMILY = "GhosttyTerminalFont";

function parseHexColor(s: string): number | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s.trim());
  return m ? parseInt(m[1], 16) : null;
}

function findGhosttyThemeFile(name: string): string {
  const candidates = [
    join(homedir(), ".config", "ghostty", "themes", name),
    join(homedir(), "Library", "Application Support", "com.mitchellh.ghostty", "themes", name),
    `/Applications/Ghostty.app/Contents/Resources/ghostty/themes/${name}`,
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "";
}

function parseColorLines(text: string): GhosttyColorConfig {
  const result: GhosttyColorConfig = { ...EMPTY_COLOR_CONFIG, palette: new Map() };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key === "palette") {
      const m = /^(\d+)=(.+)$/.exec(val);
      if (m) {
        const idx = parseInt(m[1], 10);
        const color = parseHexColor(m[2]);
        if (idx >= 0 && idx <= 255 && color !== null) result.palette.set(idx, color);
      }
    } else if (key === "foreground") {
      const c = parseHexColor(val);
      if (c !== null) result.foreground = c;
    } else if (key === "background") {
      const c = parseHexColor(val);
      if (c !== null) result.background = c;
    } else if (key === "selection-background") {
      const c = parseHexColor(val);
      if (c !== null) result.selectionBg = c;
    }
  }
  return result;
}

function parseGhosttyColorConfig(): GhosttyColorConfig {
  const configPaths = [
    join(homedir(), ".config", "ghostty", "config"),
    join(homedir(), "Library", "Application Support", "com.mitchellh.ghostty", "config"),
  ];
  for (const p of configPaths) {
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, "utf8");
      // Extract theme name from config first
      let themeName = "";
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
        const eq = trimmed.indexOf("=");
        if (trimmed.slice(0, eq).trim() === "theme") {
          // Support "LightTheme,DarkTheme" — take the dark (second) variant, or the single value
          const parts = trimmed.slice(eq + 1).trim().split(",");
          themeName = (parts[1] ?? parts[0]).trim();
          break;
        }
      }
      // Parse theme palette as base, then override with config-level entries
      const base: GhosttyColorConfig = themeName
        ? (() => {
            const tf = findGhosttyThemeFile(themeName);
            return tf
              ? parseColorLines(readFileSync(tf, "utf8"))
              : { ...EMPTY_COLOR_CONFIG, palette: new Map() };
          })()
        : { ...EMPTY_COLOR_CONFIG, palette: new Map() };
      const overrides = parseColorLines(text);
      // Config entries override theme entries
      for (const [idx, color] of overrides.palette) base.palette.set(idx, color);
      if (overrides.foreground !== null) base.foreground = overrides.foreground;
      if (overrides.background !== null) base.background = overrides.background;
      if (overrides.selectionBg !== null) base.selectionBg = overrides.selectionBg;
      return base;
    } catch {
      // ignore
    }
  }
  return { ...EMPTY_COLOR_CONFIG, palette: new Map() };
}

// Resolve installed TTF/OTF families and retain legacy filename-stem support.
// Does not require fc-list (which MacPorts installs outside Electron's PATH).
function findFontFile(name: string, style = "Regular"): string {
  const dirs = [
    "/Library/Fonts",
    join(homedir(), "Library", "Fonts"),
    "/System/Library/Fonts",
    "/System/Library/Fonts/Supplemental",
    "/usr/local/share/fonts",
    "/opt/local/share/fonts",
  ];
  for (const dir of dirs) {
    for (const ext of [".ttf", ".otf", ".TTF", ".OTF"]) {
      const stem = name.replace(/-Regular$/, `-${style}`);
      const candidate = join(dir, `${stem}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  const normalizeStyle = (value: string) => value.toLowerCase().replace(/\s+/g, "");
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!/\.(ttf|otf)$/i.test(file)) continue;
      const candidate = join(dir, file);
      try {
        const font = readFontNames(readFileSync(candidate));
        if (font.names.some((value) => value.toLowerCase() === name.toLowerCase()) &&
            font.styles.some((value) => normalizeStyle(value) === normalizeStyle(style))) {
          return candidate;
        }
      } catch (error) {
        console.warn(`[ghostty] Cannot inspect font ${candidate}`, error);
      }
    }
  }
  return "";
}

function parseGhosttyConfig(): TerminalFont {
  const candidates = [
    join(homedir(), ".config", "ghostty", "config"),
    join(homedir(), "Library", "Application Support", "com.mitchellh.ghostty", "config"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, "utf8");
      let rawFamily = "";
      let size = 0;
      const styles = new Map<string, string>();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
        const eq = trimmed.indexOf("=");
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (key === "font-family") rawFamily = val;
        else if (key === "font-size") size = parseFloat(val) || 0;
        else if (key.startsWith("font-family-")) styles.set(key, val);
      }
      if (rawFamily || size > 0) {
        const filePath = rawFamily ? findFontFile(rawFamily) : "";
        if (rawFamily && !filePath) console.warn(`[ghostty] Font family "${rawFamily}" not found; using monospace`);
        return {
          family: filePath ? GHOSTTY_FONT_FAMILY : "monospace",
          filePath,
          size: size > 0 ? size : 13,
          faces: ([
            ["normal", "400", "", "Regular"],
            ["normal", "700", "font-family-bold", "Bold"],
            ["italic", "400", "font-family-italic", "Italic"],
            ["italic", "700", "font-family-bold-italic", "BoldItalic"],
          ] as const).map(([style, weight, key, suffix]) => ({
            style,
            weight,
            filePath: key
              ? findFontFile(styles.get(key) ?? rawFamily, suffix)
              : filePath,
          })),
        };
      }
    } catch (error) {
      console.warn(`[ghostty] Cannot read font configuration ${p}`, error);
    }
  }
  return { family: "monospace", size: 13, filePath: "", faces: [] };
}

interface GhosttyPluginSettings {
  // Absolute, "~"-prefixed, or vault-root-relative path. Empty string = vault root.
  startDirectory: string;
  // Absolute or "~"-prefixed path to the shell. Empty string = auto-detect (see resolveShell).
  shell: string;
  // Per computer (key: computerName()). data.json lives in the plugin folder, which can be
  // shared between machines (machine-cfg), so each machine keeps its own values.
  agentCommands: Record<string, string>;
  // Font size in px; a missing entry uses font-size from the Ghostty config.
  fontSizes: Record<string, number>;
}

const DEFAULT_SETTINGS: GhosttyPluginSettings = {
  startDirectory: "",
  shell: "",
  agentCommands: {},
  fontSizes: {},
};

const FONT_SIZE_MIN = 6;
const FONT_SIZE_MAX = 72;

// Short, case-normalized host name: "Far-Star.local" and "far-star" are the same computer.
function computerName(): string {
  return hostname().split(".")[0].toLowerCase() || "default";
}

// MacPorts bash 5 when installed; /bin/bash on macOS is bash 3.2.
const PREFERRED_SHELLS = ["/opt/local/bin/bash", "/bin/bash"];

function resolveShell(configured: string): string {
  if (process.platform === "win32") return "powershell.exe";
  const custom = configured.trim();
  if (custom) {
    const path = custom.startsWith("~") ? join(homedir(), custom.slice(1)) : custom;
    if (existsSync(path)) return path;
    console.warn(`Configured shell not found: ${path}; falling back to auto-detect`);
  }
  return PREFERRED_SHELLS.find((candidate) => existsSync(candidate)) ?? "/bin/bash";
}

class GhosttySettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: GhosttyPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Start directory")
      .setDesc(
        "Working directory new terminals open in. Absolute path, " +
          "\"~\"-prefixed, or relative to the vault root. Leave blank for the vault root."
      )
      .addText((text) =>
        text
          .setPlaceholder("(vault root)")
          .setValue(this.plugin.settings.startDirectory)
          .onChange(async (value) => {
            this.plugin.settings.startDirectory = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Shell")
      .setDesc(
        "Shell to start in new terminals. Absolute or \"~\"-prefixed path. Leave blank to use " +
          "MacPorts bash (/opt/local/bin/bash) when installed, otherwise /bin/bash."
      )
      .addText((text) =>
        text
          .setPlaceholder("/opt/local/bin/bash")
          .setValue(this.plugin.settings.shell)
          .onChange(async (value) => {
            this.plugin.settings.shell = value;
            await this.plugin.saveSettings();
          })
      );

    const computer = computerName();
    const ghosttySize = this.plugin.ghosttyFont.size;
    const otherSizes = Object.keys(this.plugin.settings.fontSizes)
      .filter((name) => name !== computer)
      .sort();
    new Setting(containerEl)
      .setName("Font size")
      .setDesc(
        `Terminal font size in pixels on this computer (${computer}), ` +
          `${FONT_SIZE_MIN}–${FONT_SIZE_MAX}. Leave blank to use font-size from the Ghostty ` +
          `config (${ghosttySize}). Applies to open terminals immediately.` +
          (otherSizes.length ? ` Also set on: ${otherSizes.join(", ")}.` : "")
      )
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = String(FONT_SIZE_MIN);
        text.inputEl.max = String(FONT_SIZE_MAX);
        text
          .setPlaceholder(String(ghosttySize))
          .setValue(this.plugin.settings.fontSizes[computer]?.toString() ?? "")
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              await this.plugin.setFontSize(null);
              return;
            }
            const size = Number(trimmed);
            // Ignore partial input such as the "1" on the way to "14".
            if (Number.isFinite(size) && size >= FONT_SIZE_MIN && size <= FONT_SIZE_MAX) {
              await this.plugin.setFontSize(size);
            }
          });
      });

    const others = Object.keys(this.plugin.settings.agentCommands)
      .filter((name) => name !== computer)
      .sort();
    new Setting(containerEl)
      .setName("Agent start command")
      .setDesc(
        `Command that starts the agent in each new or restored terminal on this computer ` +
          `(${computer}), run after the shell starts in the start directory, for example ` +
          `"claude --continue". Each computer keeps its own value, so a plugin folder shared ` +
          `between machines can start a different agent on each. Leave blank for a shell only. ` +
          `New shell (no Agent) skips it. Changes apply to the next terminal you open.` +
          (others.length ? ` Also set on: ${others.join(", ")}.` : "")
      )
      .addText((text) =>
        text
          .setPlaceholder("claude --continue")
          .setValue(this.plugin.agentCommand())
          .onChange(async (value) => {
            await this.plugin.setAgentCommand(value);
          })
      );
  }
}

export default class GhosttyPlugin extends Plugin {
  private nativeState: GhosttyNativeState | null = null;
  private pendingShellOnly = false;
  settings: GhosttyPluginSettings = DEFAULT_SETTINGS;
  // Font from the Ghostty config; terminalFont is the same with this computer's size applied.
  ghosttyFont: TerminalFont = parseGhosttyConfig();
  terminalFont: TerminalFont = this.ghosttyFont;
  terminalColorConfig: GhosttyColorConfig = parseGhosttyColorConfig();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new GhosttySettingTab(this.app, this));

    this.registerView(VIEW_TYPE_GHOSTTY, (leaf: WorkspaceLeaf) => {
      return new GhosttyTerminalView(leaf, this);
    });

    const ribbonIcon = this.addRibbonIcon("ghost", "Open Agent terminal", () => {
      this.toggleView().catch(console.error);
    });
    ribbonIcon.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const menu = new Menu();
      menu.addItem((item) =>
        item.setTitle("New Agent session").setIcon("ghost").onClick(() => {
          this.openNewTerminal().catch(console.error);
        })
      );
      menu.addItem((item) =>
        item.setTitle("New shell (no Agent)").setIcon("terminal").onClick(() => {
          this.openNewTerminal(undefined, { shellOnly: true }).catch(console.error);
        })
      );
      menu.showAtMouseEvent(event);
    });

    this.addCommand({
      id: "toggle",
      name: "Toggle terminal",
      callback: () => {
        this.toggleView().catch(console.error);
      },
    });

    this.addCommand({
      id: "new-terminal",
      name: "New terminal",
      callback: () => {
        this.openNewTerminal().catch(console.error);
      },
    });

    await Promise.resolve();
  }

  onunload(): void {
    // Views are cleaned up automatically by Obsidian
  }

  private async toggleView(): Promise<void> {
    const { workspace } = this.app;
    const existingLeaves = workspace.getLeavesOfType(VIEW_TYPE_GHOSTTY);

    if (existingLeaves.length > 0) {
      const leaf = existingLeaves[0];
      // If the terminal is focused, close it; otherwise reveal it
      if (leaf.view.containerEl.contains(document.activeElement)) {
        leaf.detach();
        return;
      }
      await workspace.revealLeaf(leaf);
      const view = leaf.view;
      if (view instanceof GhosttyTerminalView) {
        view.focusInput();
      }
      return;
    }

    await this.activateView();
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existingLeaves = workspace.getLeavesOfType(VIEW_TYPE_GHOSTTY);

    if (existingLeaves.length > 0) {
      await workspace.revealLeaf(existingLeaves[0]);
      const view = existingLeaves[0].view;
      if (view instanceof GhosttyTerminalView) {
        view.focusInput();
      }
      return;
    }

    // First open: create a horizontal split (terminal panel at bottom)
    const leaf = workspace.getLeaf("split", "horizontal");
    await leaf.setViewState({ type: VIEW_TYPE_GHOSTTY, active: true });
    await workspace.revealLeaf(leaf);

    setTimeout(() => {
      const view = leaf.view;
      if (view instanceof GhosttyTerminalView) {
        view.focusInput();
      }
    }, 100);
  }

  async openNewTerminal(
    fromLeaf?: WorkspaceLeaf,
    options?: { shellOnly?: boolean }
  ): Promise<void> {
    const { workspace } = this.app;
    // Anchor leaf: the caller's leaf (from "+" button) or any existing terminal.
    // Setting it active first makes getLeaf("tab") open in the same tab group.
    const anchor = fromLeaf ?? workspace.getLeavesOfType(VIEW_TYPE_GHOSTTY).at(-1);

    if (anchor) {
      workspace.setActiveLeaf(anchor, { focus: false });
    }

    const newLeaf = anchor
      ? workspace.getLeaf("tab")              // new tab in same group
      : workspace.getLeaf("split", "horizontal"); // first ever terminal: bottom split

    this.pendingShellOnly = options?.shellOnly ?? false;
    await newLeaf.setViewState({ type: VIEW_TYPE_GHOSTTY, active: true });
    await workspace.revealLeaf(newLeaf);

    setTimeout(() => {
      const view = newLeaf.view;
      if (view instanceof GhosttyTerminalView) view.focusInput();
    }, 100);
  }

  /** One-shot flag consumed by GhosttyTerminalView.startSession() when a fresh session
   * spawns; always false for leaves Obsidian restores from a saved workspace layout, so
   * restored terminals run the configured startup command. */
  consumeShellOnlyFlag(): boolean {
    const flag = this.pendingShellOnly;
    this.pendingShellOnly = false;
    return flag;
  }

  getStartDirectory(): string {
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    const vaultRoot = adapter.getBasePath?.() || process.env.HOME || process.cwd() || "/";

    const configured = this.settings.startDirectory.trim();
    if (!configured) return vaultRoot;

    const expanded = configured.startsWith("~")
      ? join(homedir(), configured.slice(1))
      : configured;
    return isAbsolute(expanded) ? expanded : join(vaultRoot, expanded);
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) ?? {};
    const { startupCommand: legacy, ...rest } = data as Partial<GhosttyPluginSettings> & {
      startupCommand?: string;
    };
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...rest,
      agentCommands: { ...(rest.agentCommands ?? {}) },
      fontSizes: { ...(rest.fontSizes ?? {}) },
    };
    this.applyFontSize();
    // Before 0.9.0 one "Startup command" applied to every computer. Keep it as this
    // computer's command; other computers set their own.
    if (legacy !== undefined) {
      const computer = computerName();
      if (legacy.trim() && !(computer in this.settings.agentCommands)) {
        this.settings.agentCommands[computer] = legacy.trim();
      }
      await this.saveSettings();
    }
  }

  // The agent start command for this computer ("" = shell only).
  agentCommand(): string {
    return (this.settings.agentCommands[computerName()] ?? "").trim();
  }

  // This computer's font size, or the Ghostty config's.
  fontSize(): number {
    const size = this.settings.fontSizes[computerName()];
    return typeof size === "number" && size >= FONT_SIZE_MIN && size <= FONT_SIZE_MAX
      ? size
      : this.ghosttyFont.size;
  }

  async setFontSize(size: number | null): Promise<void> {
    const computer = computerName();
    if (size === null) delete this.settings.fontSizes[computer];
    else this.settings.fontSizes[computer] = size;
    await this.saveSettings();
    this.applyFontSize();
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GHOSTTY)) {
      if (leaf.view instanceof GhosttyTerminalView) leaf.view.refreshFont();
    }
  }

  private applyFontSize(): void {
    this.terminalFont = { ...this.ghosttyFont, size: this.fontSize() };
  }

  async setAgentCommand(value: string): Promise<void> {
    const computer = computerName();
    const command = value.trim();
    if (command) this.settings.agentCommands[computer] = command;
    else delete this.settings.agentCommands[computer];
    await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async getNativeState(refresh = false): Promise<GhosttyNativeState> {
    if (refresh || !this.nativeState || !this.nativeState.native) {
      this.nativeState = await loadGhosttyNative(this.resolvePluginDir());
    }
    return this.nativeState;
  }

  getPluginDirPath(): string {
    return this.resolvePluginDir();
  }

  private resolvePluginDir(): string {
    const candidates: string[] = [];
    const manifestDir = (this.manifest as { dir?: string }).dir;
    if (manifestDir) {
      candidates.push(manifestDir);
    }

    const adapter = this.app.vault.adapter as {
      getBasePath?: () => string;
    };
    if (adapter.getBasePath) {
      const basePath = adapter.getBasePath();
      if (basePath) {
        candidates.push(
          join(basePath, this.app.vault.configDir, "plugins", this.manifest.id)
        );
      }
    }

    for (const dir of candidates) {
      if (existsSync(join(dir, "manifest.json"))) {
        return dir;
      }
    }

    return candidates[0] ?? "";
  }
}
