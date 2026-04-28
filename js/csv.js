// CSV import/export. Hand-rolled — no external dependencies.
//
// Hierarchy formats supported:
//   - "levels"      : Level1, Level2, ..., LevelN, Code, Name
//   - "parentChild" : Code, Name, ParentCode
// Master list:        Code, Name, ResponsiblePerson, ...

var norm = (s) => (s == null ? '' : String(s).trim());
const lower = (s) => norm(s).toLowerCase().replace(/\s+/g, '');

// --- Hand-rolled CSV parsing -------------------------------------------------
// Handles RFC 4180-ish CSV: quoted fields, doubled-quote escapes, CR/LF/CRLF
// line endings, embedded newlines in quotes, leading UTF-8 BOM. Returns rows
// as arrays of strings.
function parseCsvText(text) {
  if (typeof text !== 'string') text = String(text || '');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') {
      row.push(field); rows.push(row); row = []; field = '';
      if (text[i + 1] === '\n') i += 2; else i++;
      continue;
    }
    if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; i++; continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Parse CSV text into the same shape PapaParse used to return:
// { meta: { fields: [headers] }, data: [{header: cell, ...}, ...] }
// Empty rows (all blank cells) are dropped.
function parseCsvWithHeader(text, transformHeader) {
  const rows = parseCsvText(text);
  if (!rows.length) return { meta: { fields: [] }, data: [] };
  const rawHeaders = rows[0];
  const fields = rawHeaders.map((h) => (transformHeader ? transformHeader(h) : h));
  const data = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const allBlank = cells.every((c) => c === '' || c == null);
    if (allBlank) continue;
    const obj = {};
    for (let j = 0; j < fields.length; j++) {
      obj[fields[j]] = cells[j] != null ? cells[j] : '';
    }
    data.push(obj);
  }
  return { meta: { fields }, data };
}

// Read a File or Blob via FileReader and parse it. Mirrors the previous
// PapaParse-based API so the rest of the app is unchanged.
function parseFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(parseCsvWithHeader(String(reader.result || ''), (h) => norm(h)));
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

// --- CSV serialization ------------------------------------------------------
function escapeCell(v) {
  if (v == null) return '';
  const s = String(v);
  if (/["\r\n,]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// rows: Array<object>. headerOrder: optional array of field names.
function toCsv(rows, headerOrder) {
  if (!rows || !rows.length) {
    return headerOrder && headerOrder.length ? headerOrder.map(escapeCell).join(',') : '';
  }
  const fields = headerOrder && headerOrder.length
    ? headerOrder
    : Array.from(rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s; }, new Set()));
  const lines = [fields.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(fields.map((f) => escapeCell(row[f] == null ? '' : row[f])).join(','));
  }
  return lines.join('\r\n');
}

// --- Format detection -------------------------------------------------------
function detectFormat(headers) {
  const h = headers.map(lower);
  const hasParentCode = h.includes('parentcode') || h.includes('parent') || h.includes('parentid');
  const hasCode = h.includes('code') || h.includes('costcentre') || h.includes('costcentrecode');
  const levelCols = headers.filter((x) => /^level\s*\d+$/i.test(x));
  if (levelCols.length >= 1 && hasCode) return 'levels';
  if (hasParentCode && hasCode) return 'parentChild';
  if (levelCols.length >= 1) return 'levels';
  if (hasCode) return 'parentChild';
  return 'unknown';
}

function findHeader(headers, candidates) {
  const map = new Map(headers.map((h) => [lower(h), h]));
  for (const c of candidates) {
    const found = map.get(lower(c));
    if (found) return found;
  }
  return null;
}

// --- Level-columns parser ---------------------------------------------------
function parseLevels(rows, headers, source) {
  const tree = newTree();
  const codeHeader = findHeader(headers, ['Code', 'CostCentre', 'CostCentreCode', 'CC Code']);
  const nameHeader = findHeader(headers, ['Name', 'CostCentreName', 'CC Name']);
  const levelHeaders = headers
    .filter((h) => /^level\s*\d+$/i.test(h))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));

  const parentByPath = new Map();
  const ensureParentPath = (segments) => {
    if (!segments.length) return null;
    let parentId = null;
    for (let i = 0; i < segments.length; i++) {
      const key = segments.slice(0, i + 1).join(' ');
      let id = parentByPath.get(key);
      if (!id) {
        const node = addNode(tree, {
          id: genId('p'),
          name: segments[i],
          code: '',
          parentId,
          kind: 'parent',
          source,
        });
        id = node.id;
        parentByPath.set(key, id);
      }
      parentId = id;
    }
    return parentId;
  };

  const issues = [];
  for (const row of rows) {
    const segments = levelHeaders.map((h) => norm(row[h])).filter((v) => v.length > 0);
    const code = norm(codeHeader ? row[codeHeader] : '');
    const name = norm(nameHeader ? row[nameHeader] : segments[segments.length - 1] || '');
    if (!code && !name && !segments.length) continue;
    if (!code) { issues.push({ kind: 'missing-code', row }); continue; }
    let parentSegments = segments;
    if (
      parentSegments.length &&
      (parentSegments[parentSegments.length - 1] === name ||
        parentSegments[parentSegments.length - 1] === code)
    ) {
      parentSegments = parentSegments.slice(0, -1);
    }
    const parentId = ensureParentPath(parentSegments);
    addNode(tree, { id: genId('l'), code, name, parentId, kind: 'leaf', source });
  }
  return { tree, issues };
}

// --- Parent/child parser ----------------------------------------------------
function parseParentChild(rows, headers, source) {
  const tree = newTree();
  const codeHeader = findHeader(headers, ['Code', 'CostCentre', 'CostCentreCode']);
  const nameHeader = findHeader(headers, ['Name', 'CostCentreName']);
  const parentHeader = findHeader(headers, ['ParentCode', 'Parent', 'ParentId']);
  const kindHeader = findHeader(headers, ['Kind', 'Type', 'NodeType']);

  const issues = [];
  const byCode = new Map();
  for (const row of rows) {
    const code = norm(codeHeader ? row[codeHeader] : '');
    const name = norm(nameHeader ? row[nameHeader] : '');
    const kindRaw = norm(kindHeader ? row[kindHeader] : '').toLowerCase();
    if (!code) {
      if (name || (parentHeader && norm(row[parentHeader]))) issues.push({ kind: 'missing-code', row });
      continue;
    }
    if (byCode.has(code)) { issues.push({ kind: 'duplicate-code-in-file', code }); continue; }
    const node = addNode(tree, {
      id: genId('n'),
      code,
      name,
      parentId: null,
      kind: kindRaw === 'parent' || kindRaw === 'p' ? 'parent' : 'leaf',
      source,
    });
    byCode.set(code, node.id);
  }
  for (const row of rows) {
    const code = norm(codeHeader ? row[codeHeader] : '');
    const parentCode = norm(parentHeader ? row[parentHeader] : '');
    if (!code || !parentCode) continue;
    const childId = byCode.get(code);
    const parentId = byCode.get(parentCode);
    if (!childId) continue;
    if (!parentId) { issues.push({ kind: 'missing-parent', code, parentCode }); continue; }
    const child = tree.nodes.get(childId);
    child.parentId = parentId;
    const parent = tree.nodes.get(parentId);
    if (parent.kind === 'leaf') parent.kind = 'parent';
  }
  tree.rootIds = [];
  for (const n of tree.nodes.values()) if (!n.parentId) tree.rootIds.push(n.id);
  return { tree, issues };
}

function parseHierarchy(parsedCsv, source, formatOverride) {
  const headers = parsedCsv.meta.fields || [];
  const rows = parsedCsv.data || [];
  const format = formatOverride && formatOverride !== 'auto' ? formatOverride : detectFormat(headers);
  if (format === 'levels') {
    const { tree, issues } = parseLevels(rows, headers, source);
    return { tree, issues, format };
  }
  if (format === 'parentChild') {
    const { tree, issues } = parseParentChild(rows, headers, source);
    return { tree, issues, format };
  }
  return { tree: newTree(), issues: [{ kind: 'unknown-format' }], format: 'unknown' };
}

function parseMaster(parsedCsv) {
  const headers = parsedCsv.meta.fields || [];
  const rows = parsedCsv.data || [];
  const codeH = findHeader(headers, ['Code', 'CostCentre', 'CostCentreCode']);
  const nameH = findHeader(headers, ['Name', 'CostCentreName']);
  const rpH = findHeader(headers, [
    'ResponsiblePerson', 'Responsible Person', 'Owner', 'Manager', 'CostCentreOwner',
  ]);
  const pcH = findHeader(headers, [
    'ProfitCentre', 'Profit Centre', 'ProfitCenter', 'Profit Center', 'PC', 'PCCode',
  ]);
  const out = [];
  const issues = [];
  const seen = new Set();
  for (const row of rows) {
    const code = norm(codeH ? row[codeH] : '');
    if (!code) continue;
    if (seen.has(code)) { issues.push({ kind: 'duplicate-code-in-master', code }); continue; }
    seen.add(code);
    out.push({
      code,
      name: norm(nameH ? row[nameH] : ''),
      responsiblePerson: norm(rpH ? row[rpH] : ''),
      profitCentre: norm(pcH ? row[pcH] : ''),
      raw: row,
    });
  }
  return { records: out, issues, headers };
}
