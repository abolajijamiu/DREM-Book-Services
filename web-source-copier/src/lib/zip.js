/**
 * A tiny ZIP writer.
 *
 * Deflate comes from the platform's CompressionStream('deflate-raw'), so there
 * is no bundled compression library. Entries that do not get smaller (or that
 * the platform cannot deflate) fall back to stored.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined' || !bytes.length) return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    return out.length < bytes.length ? out : null;
  } catch (err) {
    return null; // 'deflate-raw' unsupported — store instead
  }
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

/** Keeps a ZIP path legal on Windows and free of traversal tricks. */
export function sanitizeZipPath(rawPath) {
  const parts = String(rawPath)
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .map((segment) =>
      segment
        .replace(/[\x00-\x1f<>:"|?*]/g, '_')
        .replace(/[. ]+$/, '')
        .slice(0, 100)
    )
    .filter(Boolean);
  return parts.join('/') || 'file';
}

export class ZipWriter {
  constructor() {
    this.chunks = [];
    this.entries = [];
    this.offset = 0;
    this.used = new Set();
  }

  /** Returns the path actually used (de-duplicated). */
  reservePath(path) {
    let candidate = sanitizeZipPath(path);
    if (!this.used.has(candidate)) {
      this.used.add(candidate);
      return candidate;
    }
    const dot = candidate.lastIndexOf('.');
    const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
    const ext = dot > 0 ? candidate.slice(dot) : '';
    let n = 2;
    while (this.used.has(stem + '-' + n + ext)) n++;
    candidate = stem + '-' + n + ext;
    this.used.add(candidate);
    return candidate;
  }

  async add(path, data, options = {}) {
    const name = options.preserveName ? sanitizeZipPath(path) : this.reservePath(path);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    const nameBytes = new TextEncoder().encode(name);
    const compressed = options.store ? null : await deflateRaw(bytes);
    const payload = compressed || bytes;
    const method = compressed ? 8 : 0;
    const crc = crc32(bytes);
    const { time, date } = dosDateTime(options.date || new Date());

    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 0x0800, true); // UTF-8 names
    header.setUint16(8, method, true);
    header.setUint16(10, time, true);
    header.setUint16(12, date, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, payload.length, true);
    header.setUint32(22, bytes.length, true);
    header.setUint16(26, nameBytes.length, true);
    header.setUint16(28, 0, true);

    this.chunks.push(new Uint8Array(header.buffer), nameBytes, payload);
    this.entries.push({
      nameBytes,
      method,
      time,
      date,
      crc,
      compressedSize: payload.length,
      size: bytes.length,
      offset: this.offset
    });
    this.offset += 30 + nameBytes.length + payload.length;
    return name;
  }

  async finish() {
    const centralStart = this.offset;
    let centralSize = 0;

    for (const entry of this.entries) {
      const view = new DataView(new ArrayBuffer(46));
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 20, true);
      view.setUint16(8, 0x0800, true);
      view.setUint16(10, entry.method, true);
      view.setUint16(12, entry.time, true);
      view.setUint16(14, entry.date, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, entry.compressedSize, true);
      view.setUint32(24, entry.size, true);
      view.setUint16(28, entry.nameBytes.length, true);
      view.setUint16(30, 0, true);
      view.setUint16(32, 0, true);
      view.setUint16(34, 0, true);
      view.setUint16(36, 0, true);
      view.setUint32(38, 0o100644 << 16, true); // regular file, rw-r--r--
      view.setUint32(42, entry.offset, true);
      this.chunks.push(new Uint8Array(view.buffer), entry.nameBytes);
      centralSize += 46 + entry.nameBytes.length;
    }

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, centralStart, true);
    end.setUint16(20, 0, true);
    this.chunks.push(new Uint8Array(end.buffer));

    return new Blob(this.chunks, { type: 'application/zip' });
  }
}
