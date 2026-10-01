export type FontMetrics = {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  lineGap: number;
  underlineThickness: number;
};

function fontTables(data: Buffer): Map<string, Buffer> {
  if (data.length < 12) throw new Error("Truncated font header");
  const count = data.readUInt16BE(4);
  if (12 + count * 16 > data.length) throw new Error("Truncated font table directory");
  const tables = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const offset = 12 + i * 16;
    const start = data.readUInt32BE(offset + 8);
    const length = data.readUInt32BE(offset + 12);
    if (start + length > data.length) throw new Error("Truncated font table");
    tables.set(data.toString("ascii", offset, offset + 4), data.subarray(start, start + length));
  }
  return tables;
}

export function readFontNames(data: Buffer): { names: string[]; styles: string[] } {
  const table = fontTables(data).get("name");
  if (!table || table.length < 6) throw new Error("Font lacks a name table");
  const count = table.readUInt16BE(2);
  const strings = table.readUInt16BE(4);
  if (6 + count * 12 > table.length) throw new Error("Truncated font names");
  const names = new Set<string>();
  const styles = new Set<string>();
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * 12;
    const platform = table.readUInt16BE(offset);
    const id = table.readUInt16BE(offset + 6);
    if (![1, 2, 4, 6, 16, 17].includes(id)) continue;
    const length = table.readUInt16BE(offset + 8);
    const start = strings + table.readUInt16BE(offset + 10);
    if (start + length > table.length) throw new Error("Truncated font name");
    let name: string;
    if (platform === 0 || platform === 3) {
      if (length % 2) throw new Error("Invalid UTF-16 font name");
      name = Buffer.from(table.subarray(start, start + length)).swap16().toString("utf16le");
    } else if (platform === 1) {
      name = table.toString("latin1", start, start + length);
    } else continue;
    (id === 2 || id === 17 ? styles : names).add(name);
  }
  return { names: [...names], styles: [...styles] };
}

export function readFontMetrics(data: Buffer): FontMetrics {
  const tables = fontTables(data);
  const head = tables.get("head") ?? tables.get("bhed");
  const hhea = tables.get("hhea");
  const os2 = tables.get("OS/2");
  if (!head || head.length < 20 || !hhea || hhea.length < 10) {
    throw new Error("Font lacks head/hhea metrics");
  }
  const unitsPerEm = head.readUInt16BE(18);
  if (!unitsPerEm) throw new Error("Invalid font units per em");
  let ascent = hhea.readInt16BE(4);
  let descent = hhea.readInt16BE(6);
  let lineGap = hhea.readInt16BE(8);
  if (os2 && os2.length >= 78) {
    const typoAscent = os2.readInt16BE(68);
    const typoDescent = os2.readInt16BE(70);
    if (os2.readUInt16BE(62) & 0x80 || (!ascent && !descent && (typoAscent || typoDescent))) {
      ascent = typoAscent;
      descent = typoDescent;
      lineGap = os2.readInt16BE(72);
    } else if (!ascent && !descent) {
      ascent = os2.readUInt16BE(74);
      descent = -os2.readUInt16BE(76);
      lineGap = 0;
    }
  }
  if (ascent - descent + lineGap <= 0) throw new Error("Invalid font line height");
  const post = tables.get("post");
  const underlineThickness = post && post.length >= 12 ? post.readInt16BE(10) : 0;
  return { unitsPerEm, ascent, descent, lineGap, underlineThickness };
}

export function terminalMetrics(advance: number, size: number, dpr: number, font: FontMetrics): {
  width: number; height: number; baseline: number;
} {
  const scale = size * dpr / font.unitsPerEm;
  const faceHeight = (font.ascent - font.descent + font.lineGap) * scale;
  const height = Math.max(1, Math.round(faceHeight));
  const bottomBaseline = Math.round(
    (font.lineGap / 2 - font.descent) * scale - (height - faceHeight) / 2
  );
  return {
    width: Math.max(1, Math.round(advance * dpr)) / dpr,
    height: height / dpr,
    baseline: (height - bottomBaseline) / dpr,
  };
}
