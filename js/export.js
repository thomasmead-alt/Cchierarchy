// Build CSV files from the comparison report and trigger downloads.
// Hand-rolled minimal STORED-only ZIP writer — no external library.

// All export functions accept an optional `ctx` argument:
//   ctx.approvalOf(type, identifier) → 'approved' | 'rejected' | 'pending'
// App.js supplies this; tests can supply a stub. Default returns 'pending'.
const _defaultCtx = { approvalOf: () => 'pending' };

const FILES = {
  new_cost_centres: {
    rows: (r, ctx) => r.newCC.map((x) => ({ ...x, status: ctx.approvalOf('newCC', x.code) })),
    headers: ['status', 'code', 'name', 'parentPath', 'responsiblePerson'],
  },
  amended_cost_centres: {
    rows: (r, ctx) => r.amendedCC.map((x) => ({ ...x, status: ctx.approvalOf('amendedCC', x.code) })),
    headers: ['status', 'code', 'oldName', 'newName', 'oldParentPath', 'newParentPath', 'changeType'],
  },
  new_nodes: {
    rows: (r, ctx) => r.newNodes.map((x) => ({ ...x, status: ctx.approvalOf('newNode', x.path) })),
    headers: ['status', 'path', 'name', 'code', 'childCount'],
  },
  amended_nodes: {
    rows: (r, ctx) => r.amendedNodes.map((x) => ({ ...x, status: ctx.approvalOf('amendedNode', x.path) })),
    headers: ['status', 'path', 'oldName', 'newName', 'renamed', 'addedChildren', 'removedChildren'],
  },
  deleted_nodes: {
    rows: (r, ctx) => r.deletedNodes.map((x) => ({ ...x, status: ctx.approvalOf('deletedNode', x.kind === 'leaf' ? x.code : x.path) })),
    headers: ['status', 'kind', 'path', 'code', 'name', 'parentPath'],
  },
  duplicates: {
    rows: (r, ctx) => r.duplicates.flatMap((d) =>
      d.assignments.map((a) => ({
        status: ctx.approvalOf('dup', d.code),
        code: d.code,
        source: a.source,
        parentPath: a.parentPath,
        name: a.name,
        responsiblePerson: d.responsiblePerson,
      })),
    ),
    headers: ['status', 'code', 'source', 'parentPath', 'name', 'responsiblePerson'],
  },
  missing: {
    rows: (r, ctx) => r.missing.map((m) => ({ ...m, status: ctx.approvalOf('missing', m.code) })),
    headers: ['status', 'code', 'name', 'responsiblePerson'],
  },
  invalid: {
    rows: (r, ctx) => r.invalid.map((v) => ({ ...v, status: ctx.approvalOf('invalid', v.code + '|' + v.source) })),
    headers: ['status', 'code', 'source', 'issue', 'hierName', 'masterName', 'parentPath'],
  },
};

function fileNames() {
  return Object.keys(FILES);
}

function buildCsv(name, report, ctx) {
  const spec = FILES[name];
  if (!spec) return '';
  return toCsv(spec.rows(report, ctx || _defaultCtx), spec.headers);
}

function buildAllCsvs(report, ctx) {
  const out = {};
  const c = ctx || _defaultCtx;
  for (const name of Object.keys(FILES)) {
    out[`${name}.csv`] = buildCsv(name, report, c);
  }
  return out;
}

// Working hierarchy export: parent/child format, every node a row.
function buildWorkingHierarchyCsv(tree) {
  const rows = [];
  walk(tree, (node) => {
    const parent = node.parentId ? tree.nodes.get(node.parentId) : null;
    rows.push({
      Code: node.code || '',
      Name: node.name,
      ParentCode: parent?.code || '',
      ParentPath: parent ? pathString(tree, parent) : '',
      Kind: node.kind,
      Source: node.source,
    });
  });
  return toCsv(rows, ['Code', 'Name', 'ParentCode', 'ParentPath', 'Kind', 'Source']);
}

function downloadString(filename, contents, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([contents], { type: mime });
  triggerDownload(filename, blob);
}

function triggerDownload(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Hand-rolled ZIP writer (STORED, no compression) ------------------------
// Produces a valid PKZIP file that desktop unzippers (macOS Archive Utility,
// 7-zip, info-zip's `unzip`) accept. Files are stored uncompressed — CSV
// payloads stay small and the implementation stays simple. CRC-32/IEEE per
// entry, single disk, no Zip64.
const _CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ _CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function _dosTime(d) {
  return ((d.getHours() & 0x1F) << 11)
       | ((d.getMinutes() & 0x3F) << 5)
       | ((d.getSeconds() >> 1) & 0x1F);
}
function _dosDate(d) {
  return (((d.getFullYear() - 1980) & 0x7F) << 9)
       | (((d.getMonth() + 1) & 0x0F) << 5)
       | (d.getDate() & 0x1F);
}

// files: { 'name.csv': 'string content' | Uint8Array }
// returns Blob with type application/zip
function buildZip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const dt = _dosTime(now);
  const dd = _dosDate(now);

  const localChunks = [];
  const central = [];
  let offset = 0;
  let entryCount = 0;

  for (const name of Object.keys(files)) {
    const nameBytes = enc.encode(name);
    const content = files[name];
    const data = typeof content === 'string' ? enc.encode(content) : new Uint8Array(content);
    const crc = crc32(data);
    const size = data.length;

    // Local file header (30 bytes + name)
    const lfh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true);   // signature
    lv.setUint16(4, 20, true);           // version needed
    lv.setUint16(6, 0x0800, true);       // flags: language encoding (UTF-8 names)
    lv.setUint16(8, 0, true);            // method: 0 = stored
    lv.setUint16(10, dt, true);
    lv.setUint16(12, dd, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);        // compressed size
    lv.setUint32(22, size, true);        // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);           // extra length
    lfh.set(nameBytes, 30);
    localChunks.push(lfh, data);

    // Central directory entry (46 bytes + name)
    const cdh = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdh.buffer);
    cv.setUint32(0, 0x02014b50, true);   // signature
    cv.setUint16(4, 0x031E, true);       // version made by (Unix, zip 30)
    cv.setUint16(6, 20, true);           // version needed
    cv.setUint16(8, 0x0800, true);       // flags
    cv.setUint16(10, 0, true);           // method
    cv.setUint16(12, dt, true);
    cv.setUint16(14, dd, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);           // extra
    cv.setUint16(32, 0, true);           // comment
    cv.setUint16(34, 0, true);           // disk number
    cv.setUint16(36, 0, true);           // internal attrs
    cv.setUint32(38, 0, true);           // external attrs
    cv.setUint32(42, offset, true);      // relative offset of local header
    cdh.set(nameBytes, 46);
    central.push(cdh);

    offset += lfh.length + data.length;
    entryCount += 1;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) centralSize += c.length;

  // End of central directory (22 bytes, no comment)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);              // disk number
  ev.setUint16(6, 0, true);              // disk with central dir
  ev.setUint16(8, entryCount, true);     // entries this disk
  ev.setUint16(10, entryCount, true);    // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true);             // comment length

  return new Blob([...localChunks, ...central, eocd], { type: 'application/zip' });
}

function downloadZip(filename, files) {
  triggerDownload(filename, buildZip(files));
}
