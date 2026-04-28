// App bootstrap. Wires together CSV import → tree build → diff → render.







const state = {
  raw: { A: null, B: null, master: null, pc: null, projects: null },
  parsed: { A: null, B: null, master: null, pc: null, projects: null },
  trees: { A: null, B: null, pc: null },
  // user-supplied column overrides per slot: { code, name, parent, levels:[], format }
  mapping: { A: {}, B: {}, master: {}, pc: {}, projects: {} },
  master: { records: [], headers: [] },
  // CC-code to project name from the optional projects.csv upload (empty when not provided)
  projectAssignments: null,
  // table view toggle for the Hierarchy editor
  hierarchyMode: 'tree',
  working: null,
  workingHistory: [],
  filter: null,
  activeTab: 'duplicates',
  activeView: 'imports',
  report: null,
  recommendations: [],
  projects: [],
};

const VIEW_TITLES = {
  imports: 'Imports',
  dashboard: 'Compare',
  hierarchy: 'Hierarchy',
  projects: 'Projects',
  reports: 'Reports',
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function setStatus(msg, kind = '') {
  const s = $('#status');
  s.className = 'status' + (kind ? ' ' + kind : '');
  s.innerHTML = msg;
  const pill = $('#status-pill');
  if (pill) {
    if (kind === 'error') { pill.textContent = 'Error'; pill.className = 'status-pill error'; }
    else if (kind === 'ok') { pill.textContent = 'Ready'; pill.className = 'status-pill'; }
    else { pill.textContent = state.report ? 'Ready' : 'Idle'; pill.className = 'status-pill' + (state.report ? '' : ' idle'); }
  }
}

function setView(name) {
  state.activeView = name;
  $$('.rail-item[data-view]').forEach((i) => i.classList.toggle('active', i.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
  const crumb = $('#topbar-view');
  if (crumb) crumb.textContent = VIEW_TITLES[name] || name;
}

function pushHistory() {
  if (!state.working) return;
  state.workingHistory.push(cloneTree(state.working));
  if (state.workingHistory.length > 50) state.workingHistory.shift();
  $('#undo').disabled = state.workingHistory.length === 0;
}

function undo() {
  const prev = state.workingHistory.pop();
  if (!prev) return;
  state.working = prev;
  $('#undo').disabled = state.workingHistory.length === 0;
  recompute();
}

// ---------- File loading ----------

async function loadSlot(slot, file) {
  state.raw[slot] = file;
  $(`label.dropzone[data-slot="${slot}"] [data-filename]`).textContent = file.name;
  try {
    const parsed = await parseFile(file);
    state.parsed[slot] = parsed;
    state.mapping[slot] = state.mapping[slot] || {}; // user overrides preserved across reloads
    reparseSlot(slot);
    // If this is a hierarchy slot and the working tree has no manual edits
    // yet, refresh it so subsequent loads (e.g., A first then B) actually use
    // the latest B as the editing baseline. Once the user has edited, we
    // preserve their work.
    if ((slot === 'A' || slot === 'B') && state.workingHistory.length === 0) {
      const fresh = state.trees.B || state.trees.A;
      state.working = fresh ? cloneTree(fresh) : null;
    }
    setStatus(`Loaded <strong>${file.name}</strong> into ${slot}.`, 'ok');
    renderMapper(slot);
    recompute();
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load ${file.name}: ${err.message || err}`, 'error');
  }
}

// Re-run the parser for a slot using the current mapping override (or empty
// mapping → auto-detect). Called after a new file is loaded and after the
// user changes a column-mapping dropdown.
function reparseSlot(slot) {
  const parsed = state.parsed[slot];
  if (!parsed) return;
  const mapping = state.mapping[slot] || {};
  const headers = parsed.meta.fields || [];
  const badge = $(`label.dropzone[data-slot="${slot}"] [data-format]`);
  if (slot === 'master') {
    const m = parseMaster(parsed, mapping);
    state.master = { records: m.records, headers };
    if (badge) badge.textContent = 'master';
    return;
  }
  if (slot === 'projects') {
    state.projectAssignments = parseProjectsCsv(parsed);
    if (badge) badge.textContent = 'projects';
    return;
  }
  // Hierarchy slots: A, B, pc — honour the optional format override too.
  const fmt = mapping.format && mapping.format !== 'auto' ? mapping.format : detectFormat(headers);
  const result = parseHierarchy(parsed, slot, fmt, mapping);
  state.trees[slot] = result.tree;
  if (badge) badge.textContent = result.format;
}

function clearAll() {
  state.raw = { A: null, B: null, master: null, pc: null, projects: null };
  state.parsed = { A: null, B: null, master: null, pc: null, projects: null };
  state.trees = { A: null, B: null, pc: null };
  state.mapping = { A: {}, B: {}, master: {}, pc: {}, projects: {} };
  state.master = { records: [], headers: [] };
  state.projectAssignments = null;
  state.working = null;
  state.workingHistory = [];
  state.filter = null;
  state.report = null;
  state.recommendations = [];
  state.projects = [];
  for (const slot of ['A', 'B', 'master', 'pc', 'projects']) {
    const dz = $(`label.dropzone[data-slot="${slot}"]`);
    if (!dz) continue;
    dz.querySelector('[data-filename]').textContent = '';
    dz.querySelector('[data-format]').textContent = '';
    const mapper = dz.parentElement.querySelector(`.mapper[data-slot="${slot}"]`);
    if (mapper) mapper.innerHTML = '';
  }
  recompute();
  setStatus('Cleared. Drop CSVs to begin.');
}

// --- Project assignments CSV parser ----------------------------------------
// Accepts headers (case-insensitive): Code/CostCentre, Project/ProjectName,
// optionally Description/ProjectDescription. Returns
// { byCode: Map<code, projectName>, projects: Map<name, {description, codes:Set}> }.
function parseProjectsCsv(parsedCsv) {
  const headers = parsedCsv.meta.fields || [];
  const rows = parsedCsv.data || [];
  const codeH = headers.find((h) => /^(code|costcentre|cost centre|costcentrecode|cc code)$/i.test(h));
  const projH = headers.find((h) => /^(project|projectname|project name)$/i.test(h));
  const descH = headers.find((h) => /^(description|projectdescription|project description|notes)$/i.test(h));
  if (!codeH || !projH) return null;
  const byCode = new Map();
  const projects = new Map();
  for (const row of rows) {
    const code = String(row[codeH] || '').trim();
    const proj = String(row[projH] || '').trim();
    if (!code || !proj) continue;
    byCode.set(code, proj);
    if (!projects.has(proj)) projects.set(proj, { description: '', codes: new Set() });
    const p = projects.get(proj);
    p.codes.add(code);
    if (descH && row[descH]) p.description = String(row[descH]).trim();
  }
  return { byCode, projects };
}

// --- Per-upload column-mapping UI ------------------------------------------
function renderMapper(slot) {
  const dz = $(`label.dropzone[data-slot="${slot}"]`);
  if (!dz) return;
  // Insert/find the mapper row right after the dropzone in the imports grid.
  let mapper = dz.parentElement.querySelector(`.mapper[data-slot="${slot}"]`);
  if (!mapper) {
    mapper = document.createElement('div');
    mapper.className = 'mapper';
    mapper.dataset.slot = slot;
    dz.insertAdjacentElement('afterend', mapper);
  }
  const parsed = state.parsed[slot];
  if (!parsed) { mapper.innerHTML = ''; return; }
  const headers = parsed.meta.fields || [];
  const m = state.mapping[slot] || {};
  const opts = (selected) =>
    `<option value="">—</option>` +
    headers.map((h) => `<option value="${escapeAttr(h)}"${h === selected ? ' selected' : ''}>${escape(h)}</option>`).join('');

  // Different fields are relevant per slot.
  let fieldsHtml = '';
  if (slot === 'master') {
    fieldsHtml = `
      <label>Code <select data-field="code">${opts(m.code)}</select></label>
      <label>Name / Description <select data-field="name">${opts(m.name)}</select></label>
      <label>Responsible Person <select data-field="rp">${opts(m.rp)}</select></label>
      <label>Profit Centre <select data-field="pc">${opts(m.pc)}</select></label>`;
  } else if (slot === 'projects') {
    fieldsHtml = `
      <label>Code <select data-field="code">${opts(m.code)}</select></label>
      <label>Project <select data-field="project">${opts(m.project)}</select></label>
      <label>Description <select data-field="description">${opts(m.description)}</select></label>`;
  } else {
    // hierarchy slots (A, B, pc)
    const fmt = (m.format && m.format !== 'auto') ? m.format : detectFormat(headers);
    fieldsHtml = `
      <label>Format
        <select data-field="format">
          <option value="auto"${!m.format || m.format === 'auto' ? ' selected' : ''}>Auto · ${fmt}</option>
          <option value="levels"${m.format === 'levels' ? ' selected' : ''}>Level columns</option>
          <option value="parentChild"${m.format === 'parentChild' ? ' selected' : ''}>Parent / Child</option>
        </select>
      </label>
      <label>Code <select data-field="code">${opts(m.code)}</select></label>
      <label>Name / Description <select data-field="name">${opts(m.name)}</select></label>
      <label>Parent code <select data-field="parent">${opts(m.parent)}</select></label>
      <div class="levels">
        <span class="level-label">Level columns</span>
        <span class="level-list">${headers.map((h) => `
          <label class="level-chip"><input type="checkbox" data-field="level" value="${escapeAttr(h)}"${(m.levels || []).includes(h) ? ' checked' : ''}/>${escape(h)}</label>
        `).join('')}</span>
      </div>`;
  }
  mapper.innerHTML = `<div class="mapper-head"><strong>Column mapping</strong> <span class="muted">— overrides auto-detect for this file</span></div>
    <div class="mapper-grid">${fieldsHtml}</div>`;

  // Wire change events
  mapper.querySelectorAll('select[data-field], input[data-field]').forEach((ctrl) => {
    ctrl.addEventListener('change', () => {
      const m2 = state.mapping[slot] || {};
      if (ctrl.dataset.field === 'level') {
        const cur = new Set(m2.levels || []);
        if (ctrl.checked) cur.add(ctrl.value); else cur.delete(ctrl.value);
        m2.levels = headers.filter((h) => cur.has(h)); // preserve column order
      } else {
        m2[ctrl.dataset.field] = ctrl.value || undefined;
      }
      state.mapping[slot] = m2;
      reparseSlot(slot);
      recompute();
    });
  });
}

// ---------- Recompute & render ----------

function recompute() {
  const a = state.trees.A;
  const b = state.trees.B;
  // Default the working tree to a clone of B (or A if B missing) on first
  // availability. Don't overwrite if user has already edited it.
  if (!state.working && (a || b)) {
    state.working = cloneTree(b || a);
  }

  // Compare: working vs A, so user edits flow through to the change report.
  const report = compare(a || newTree(), state.working || b || newTree(), state.master.records);
  state.report = report;
  state.recommendations = state.working ? suggest(state.master.records, state.working) : [];
  state.projects = deriveProjects(state.trees.pc, state.master.records, report, state.projectAssignments);

  // tile counts
  const counts = summarise(report);
  for (const k of Object.keys(counts)) {
    const e = document.getElementById('count-' + k);
    if (e) e.textContent = counts[k];
    const tabct = document.getElementById('tabct-' + k);
    if (tabct) tabct.textContent = counts[k];
    const expct = document.getElementById('expct-' + k);
    if (expct) expct.textContent = counts[k];
  }

  // Build per-tree highlight maps so diff highlights show on the trees
  const hlA = buildHighlights(a, report, 'A');
  const hlB = buildHighlights(b, report, 'B');
  const hlW = buildHighlights(state.working, report, 'working');

  if (a) renderTree($('#tree-A'), a, { editable: false, highlights: hlA });
  else $('#tree-A').innerHTML = '<div class="empty-state">Drop hierarchy A above.</div>';
  // Compare's middle pane shows the live "working" tree (B + your edits) so
  // hierarchy edits are reflected here in real time. Falls back to the raw B
  // upload if the user hasn't started a working tree yet.
  const compareTree = state.working || b;
  if (compareTree) {
    renderTree($('#tree-B'), compareTree, {
      editable: false,
      highlights: state.working ? hlW : hlB,
    });
  } else {
    $('#tree-B').innerHTML = '<div class="empty-state">Drop hierarchy B above.</div>';
  }
  if (state.working) {
    if (state.hierarchyMode === 'table') {
      renderWorkingTable($('#table-working'), state.working);
    } else {
      renderTree($('#tree-working'), state.working, {
        editable: true,
        highlights: hlW,
        onChange: (movedId) => {
          pushHistory();
          recompute();
          if (movedId) requestAnimationFrame(() => flashMoved($('#tree-working'), movedId));
        },
      });
    }
  } else {
    $('#tree-working').innerHTML = '<div class="empty-state">Working hierarchy will appear once A or B is loaded.</div>';
    $('#table-working').innerHTML = '';
  }
  // toggle visibility of the two view modes
  $('#tree-working').hidden = state.hierarchyMode === 'table';
  $('#table-working').hidden = state.hierarchyMode !== 'table';
  $$('.seg-btn[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.hierarchyMode));

  $('#meta-A').textContent = a ? `${countLeaves(a)} cost centres / ${countParents(a)} groups` : '';
  const metaTree = state.working || b;
  $('#meta-B').textContent = metaTree
    ? `${countLeaves(metaTree)} cost centres / ${countParents(metaTree)} groups${state.working ? ' (working)' : ''}`
    : '';
  const metaPc = $('#meta-pc');
  if (metaPc) {
    if (state.trees.pc) {
      metaPc.textContent = `${state.projects.filter((p) => p.id !== '__unassigned__').length} projects · ${state.trees.pc.nodes.size} PC nodes`;
    } else {
      metaPc.textContent = '';
    }
  }

  renderSidebar();
}

function countLeaves(t) {
  let n = 0;
  walk(t, (node) => { if (node.kind === 'leaf') n++; });
  return n;
}
function countParents(t) {
  let n = 0;
  walk(t, (node) => { if (node.kind === 'parent') n++; });
  return n;
}

function buildHighlights(tree, report, which) {
  const hl = new Map();
  if (!tree) return hl;

  const setIfFound = (code, kindHint, color) => {
    if (!code) return;
    walk(tree, (node) => {
      if (node.kind === kindHint && node.code === code) hl.set(node.id, color);
    });
  };

  // newCC -> in B and working only
  if (which === 'B' || which === 'working') {
    for (const r of report.newCC) setIfFound(r.code, 'leaf', 'new');
    for (const r of report.amendedCC) setIfFound(r.code, 'leaf', 'amended');
  }
  // deletedNodes -> in A only
  if (which === 'A') {
    for (const r of report.deletedNodes) {
      if (r.kind === 'leaf') setIfFound(r.code, 'leaf', 'deleted');
      // for parent, we don't have an id easily; mark by name+path
    }
  }
  // duplicates: highlight every occurrence
  for (const d of report.duplicates) setIfFound(d.code, 'leaf', 'duplicate');
  // invalid: highlight in respective source
  for (const v of report.invalid) {
    if ((v.source === 'A' && which === 'A') || (v.source === 'B' && which === 'B') || which === 'working') {
      setIfFound(v.code, 'leaf', 'invalid');
    }
  }
  // recommended placement: highlight nodes that are in working & sourced as recommended
  if (which === 'working') {
    walk(tree, (node) => {
      if (node.source === 'recommended') hl.set(node.id, 'recommended');
    });
  }
  return hl;
}

// ---------- Sidebar tabs ----------

function renderSidebar() {
  renderChanges();
  renderDuplicates();
  renderMissing();
  renderInvalid();
  renderRecommendations();
  renderProjects();
}

function renderChanges() {
  const c = $('#panel-changes');
  if (!state.report) { c.innerHTML = empty('No comparison yet.'); return; }
  const r = state.report;
  const sections = [
    ['New cost centres', 'new', r.newCC, (x) => `<code>${x.code}</code> ${escape(x.name)} <span class="meta">→ ${escape(x.parentPath || '(root)')}</span>`],
    ['Amended cost centres', 'amended', r.amendedCC, (x) => `<code>${x.code}</code> <span class="meta">[${x.changeType}]</span><br>${escape(x.oldName)} → ${escape(x.newName)}<br><span class="meta">${escape(x.oldParentPath)} → ${escape(x.newParentPath)}</span>`],
    ['New nodes', 'new', r.newNodes, (x) => `<strong>${escape(x.name)}</strong> <span class="meta">${escape(x.path)} · ${x.childCount} children</span>`],
    ['Amended nodes', 'amended', r.amendedNodes, (x) => `<strong>${escape(x.path)}</strong>${x.renamed ? `<br>${escape(x.oldName)} → ${escape(x.newName)}` : ''}<br><span class="meta">+${x.addedChildren || '∅'} / -${x.removedChildren || '∅'}</span>`],
    ['Deleted nodes', 'deleted', r.deletedNodes, (x) => `${x.kind === 'leaf' ? `<code>${x.code}</code> ${escape(x.name)}` : `<strong>${escape(x.name || x.path)}</strong>`} <span class="meta">${escape(x.parentPath || x.path || '')}</span>`],
  ];
  if (state.filter && !sections.find(([_, __, list]) => list === r[state.filter])) {
    state.filter = null;
  }
  let out = '';
  for (const [title, badge, list, render] of sections) {
    if (state.filter && (
      (state.filter === 'newCC' && list !== r.newCC) ||
      (state.filter === 'amendedCC' && list !== r.amendedCC) ||
      (state.filter === 'newNodes' && list !== r.newNodes) ||
      (state.filter === 'amendedNodes' && list !== r.amendedNodes) ||
      (state.filter === 'deletedNodes' && list !== r.deletedNodes)
    )) continue;
    out += `<div class="section-heading">${title} (${list.length})</div>`;
    if (!list.length) out += `<div class="empty-state" style="padding:0.4rem 0;">None.</div>`;
    for (const item of list) {
      out += `<div class="list-item"><span class="badge badge-${badge}">${badge}</span>${render(item)}</div>`;
    }
  }
  c.innerHTML = out || empty('No changes detected.');
}

function renderDuplicates() {
  const c = $('#panel-duplicates');
  if (!state.report) { c.innerHTML = empty('No comparison yet.'); return; }
  const list = state.report.duplicates;
  if (!list.length) { c.innerHTML = empty('No duplicate assignments.'); return; }
  let out = `<div class="section-heading">Duplicates (${list.length})</div>`;
  for (const d of list) {
    const parents = d.assignments.map((a) =>
      `<div><span class="meta">[${a.source}]</span> ${escape(a.parentPath || '(root)')}</div>`
    ).join('');
    const buttons = d.assignments.map((a) =>
      `<button class="btn btn-small" data-action="resolve-dup" data-code="${escapeAttr(d.code)}" data-keep-source="${a.source}" data-keep-path="${escapeAttr(a.parentPath)}">Keep ${a.source}: ${escape(a.parentPath || '(root)')}</button>`
    ).join('');
    out += `<div class="list-item">
      <span class="badge badge-duplicate">duplicate</span>
      <code>${escape(d.code)}</code>
      ${d.responsiblePerson ? `<span class="meta">· ${escape(d.responsiblePerson)}</span>` : ''}
      ${parents}
      <div class="actions">${buttons}</div>
    </div>`;
  }
  c.innerHTML = out;
}

function renderMissing() {
  const c = $('#panel-missing');
  if (!state.report) { c.innerHTML = empty('No comparison yet.'); return; }
  const list = state.report.missing;
  if (!list.length) { c.innerHTML = empty('All master cost centres are placed.'); return; }
  let out = `<div class="section-heading">Missing from both hierarchies (${list.length})</div>`;
  for (const m of list) {
    out += `<div class="list-item">
      <span class="badge badge-missing">missing</span>
      <code>${escape(m.code)}</code> ${escape(m.name)}
      ${m.responsiblePerson ? `<div class="meta">${escape(m.responsiblePerson)}</div>` : ''}
      <div class="actions">
        <button class="btn btn-small" data-action="add-missing" data-code="${escapeAttr(m.code)}">Add to working tree (root)</button>
      </div>
    </div>`;
  }
  c.innerHTML = out;
}

function renderInvalid() {
  const c = $('#panel-invalid');
  if (!state.report) { c.innerHTML = empty('No comparison yet.'); return; }
  const list = state.report.invalid;
  if (!list.length) { c.innerHTML = empty('No invalid entries.'); return; }
  let out = `<div class="section-heading">Invalid (${list.length})</div>`;
  for (const v of list) {
    out += `<div class="list-item">
      <span class="badge badge-invalid">${v.issue}</span>
      <span class="meta">[${v.source}]</span>
      <code>${escape(v.code)}</code>
      ${v.issue === 'name-mismatch' ? `<br>${escape(v.hierName)} <span class="meta">vs master:</span> ${escape(v.masterName)}` : ''}
      <div class="meta">${escape(v.parentPath || '')}</div>
    </div>`;
  }
  c.innerHTML = out;
}

function renderRecommendations() {
  const c = $('#panel-recommendations');
  if (!state.master.records.length) {
    c.innerHTML = empty('Load a master list with ResponsiblePerson to see recommendations.');
    return;
  }
  if (!state.recommendations.length) {
    c.innerHTML = empty('No recommendations — every responsible-person group is already grouped.');
    return;
  }
  let out = `<div class="section-heading">Suggested groupings (${state.recommendations.length})</div>`;
  for (const s of state.recommendations) {
    out += `<div class="list-item">
      <strong>${escape(s.suggestedParentName)}</strong>
      <div class="meta">${escape(s.rationale)}</div>
      <div class="meta">In tree: ${s.placedCodes.length}${s.unplacedCodes.length ? ` · Unplaced: ${s.unplacedCodes.length}` : ''}</div>
      <div class="meta">${s.memberCodes.map(escape).join(', ')}</div>
      <div class="actions">
        <button class="btn btn-small" data-action="apply-rec" data-id="${escapeAttr(s.id)}">Apply</button>
        <button class="btn btn-small" data-action="apply-rec-with-unplaced" data-id="${escapeAttr(s.id)}">Apply + add unplaced</button>
      </div>
    </div>`;
  }
  c.innerHTML = out;
}

// ---------- Projects (derive + render) ----------
function deriveProjects(pcTree, masterRecords, report, projectAssignments) {
  // Build code->profitCentre lookup from master.
  const ccToPc = new Map();
  for (const r of masterRecords) if (r.code && r.profitCentre) ccToPc.set(r.code, r.profitCentre);

  const filterReportByCcCodes = (rep, codes) => ({
    newCC: rep.newCC.filter((x) => codes.has(x.code)),
    amendedCC: rep.amendedCC.filter((x) => codes.has(x.code)),
    deletedNodes: rep.deletedNodes.filter((x) => x.kind === 'leaf' ? codes.has(x.code) : false),
    duplicates: rep.duplicates.filter((d) => codes.has(d.code)),
    missing: rep.missing.filter((m) => codes.has(m.code)),
    invalid: rep.invalid.filter((v) => codes.has(v.code)),
    newNodes: [], amendedNodes: [],
  });

  // ---- User-uploaded project assignments take precedence ----
  // When a projects.csv has been provided, every row defines a project. CCs
  // not listed go to the Unassigned bucket. PC hierarchy is only used as the
  // source for the starter download — it does not influence scoping here.
  if (projectAssignments && projectAssignments.projects && projectAssignments.projects.size) {
    const projects = [];
    const placedCodes = new Set();
    for (const [name, info] of projectAssignments.projects) {
      const ccCodes = new Set(info.codes);
      for (const c of ccCodes) placedCodes.add(c);
      projects.push({
        id: 'manual:' + name,
        name,
        code: '',
        description: info.description || '',
        pcCount: 0,
        ccCount: ccCodes.size,
        ccCodes,
        source: 'manual',
        filtered: filterReportByCcCodes(report, ccCodes),
      });
    }
    const orphan = new Set();
    for (const r of masterRecords) {
      if (!r.code) continue;
      if (!placedCodes.has(r.code)) orphan.add(r.code);
    }
    if (orphan.size) {
      projects.push({
        id: '__unassigned__',
        name: 'Unassigned',
        code: '',
        pcCount: 0,
        ccCount: orphan.size,
        ccCodes: orphan,
        source: 'orphan',
        filtered: filterReportByCcCodes(report, orphan),
      });
    }
    return projects;
  }

  if (!pcTree || !pcTree.rootIds.length) return [];

  const collectPcCodes = (rootId) => {
    const codes = new Set();
    const recurse = (id) => {
      const node = pcTree.nodes.get(id);
      if (!node) return;
      if (node.code) codes.add(node.code);
      // Also accept the node's NAME as a fallback PC identifier when the PC
      // file uses level-columns (no per-node code).
      if (!node.code && node.name) codes.add(node.name);
      for (const n of pcTree.nodes.values()) if (n.parentId === id) recurse(n.id);
    };
    recurse(rootId);
    return codes;
  };

  const projects = [];
  for (const rootId of pcTree.rootIds) {
    const rootNode = pcTree.nodes.get(rootId);
    if (!rootNode) continue;
    const pcCodes = collectPcCodes(rootId);
    const ccCodes = new Set();
    for (const [cc, pc] of ccToPc) if (pcCodes.has(pc)) ccCodes.add(cc);
    projects.push({
      id: rootId,
      name: rootNode.name || rootNode.code || 'Project',
      code: rootNode.code || '',
      pcCount: pcCodes.size,
      ccCount: ccCodes.size,
      ccCodes,
      filtered: filterReportByCcCodes(report, ccCodes),
    });
  }

  // Catch-all bucket for cost centres that have no profit-centre assignment, OR
  // whose profit centre isn't found anywhere in the PC hierarchy. Always shown
  // when at least one such CC exists so they don't silently disappear.
  const allProjectCcCodes = new Set();
  for (const p of projects) for (const c of p.ccCodes) allProjectCcCodes.add(c);
  const orphan = new Set();
  for (const r of masterRecords) {
    if (!r.code) continue;
    if (!allProjectCcCodes.has(r.code)) orphan.add(r.code);
  }
  if (orphan.size) {
    projects.push({
      id: '__unassigned__',
      name: 'Unassigned',
      code: '',
      pcCount: 0,
      ccCount: orphan.size,
      ccCodes: orphan,
      filtered: filterReportByCcCodes(report, orphan),
    });
  }

  return projects;
}

function renderProjects() {
  const c = $('#panel-projects');
  if (!c) return;
  if (!state.master.records.length) {
    c.innerHTML = empty('Load the master list so cost centres can be mapped to projects.');
    return;
  }
  if (!state.trees.pc && !state.projectAssignments) {
    c.innerHTML = empty('Drop a profit-centre hierarchy CSV in Imports (and optionally a project-assignments CSV) to see projects.');
    return;
  }
  if (!state.projects.length) {
    c.innerHTML = empty('No projects derived. The PC hierarchy has no top-level nodes, or master rows have no ProfitCentre values.');
    return;
  }

  const totalCC = state.projects.reduce((s, p) => s + p.ccCount, 0);
  const projectCount = state.projects.filter((p) => p.id !== '__unassigned__').length;
  const sourceLabel = state.projectAssignments ? 'from uploaded project assignments' : 'from PC hierarchy';

  let out = `<div class="projects-toolbar">
      <div>
        <strong>${projectCount} projects</strong>
        <span class="muted"> · ${totalCC} cost centres covered · ${escape(sourceLabel)}</span>
      </div>
      <div class="projects-actions">
        <button class="btn btn-small" data-action="download-starter-projects">Download starter projects.csv</button>
      </div>
    </div>`;
  out += '<div class="project-grid">';
  for (const p of state.projects) {
    const f = p.filtered;
    const totalChanges =
      f.newCC.length + f.amendedCC.length + f.deletedNodes.length;
    const totalQuality =
      f.duplicates.length + f.missing.length + f.invalid.length;
    const isOrphan = p.id === '__unassigned__';
    out += `<div class="project-card${isOrphan ? ' project-orphan' : ''}" data-project-id="${escapeAttr(p.id)}">
      <header class="project-head">
        <div>
          <strong class="project-name">${escape(p.name)}</strong>
          ${p.code ? `<code class="meta">${escape(p.code)}</code>` : ''}
        </div>
        <div class="project-meta meta">${p.ccCount} cost centres${p.pcCount ? ` · ${p.pcCount} profit centres` : ''}</div>
      </header>
      <div class="project-tiles">
        <div class="ptile"><span class="ptile-count tone-green">${f.newCC.length}</span><span class="ptile-label">New CC</span></div>
        <div class="ptile"><span class="ptile-count tone-amber">${f.amendedCC.length}</span><span class="ptile-label">Amended CC</span></div>
        <div class="ptile"><span class="ptile-count tone-red">${f.deletedNodes.length}</span><span class="ptile-label">Deleted</span></div>
        <div class="ptile"><span class="ptile-count tone-coral">${f.duplicates.length}</span><span class="ptile-label">Duplicates</span></div>
        <div class="ptile"><span class="ptile-count tone-purple">${f.missing.length}</span><span class="ptile-label">Missing</span></div>
        <div class="ptile"><span class="ptile-count tone-amber">${f.invalid.length}</span><span class="ptile-label">Invalid</span></div>
      </div>
      <details class="project-scope" open>
        <summary>Scope · ${p.ccCount} cost centres in working hierarchy</summary>
        <div class="tree project-scope-tree" data-scope-for="${escapeAttr(p.id)}"></div>
      </details>
      <div class="project-foot">
        <span class="meta">${totalChanges} changes · ${totalQuality} quality issues</span>
        <button class="btn btn-small" data-action="export-project" data-id="${escapeAttr(p.id)}">Download project ZIP</button>
      </div>
    </div>`;
  }
  out += '</div>';
  c.innerHTML = out;

  // Mount per-project sub-trees once the HTML is in the DOM.
  if (state.working) {
    for (const p of state.projects) {
      const container = c.querySelector(`.project-scope-tree[data-scope-for="${cssEscape(p.id)}"]`);
      if (!container) continue;
      const subtree = projectScopedTree(state.working, p.ccCodes);
      const highlights = buildHighlights(subtree, state.report, 'working');
      if (subtree.nodes.size === 0) {
        container.innerHTML = '<div class="empty-state">No matching cost centres in the working hierarchy.</div>';
      } else {
        renderTree(container, subtree, { editable: false, highlights });
      }
    }
  }
}

// Build a sub-tree from `tree` containing only the leaves whose codes are in
// ccCodes plus their ancestors. Renderable with renderTree like any other tree.
function projectScopedTree(tree, ccCodes) {
  const out = newTree();
  if (!tree || !ccCodes || !ccCodes.size) return out;
  const idsToInclude = new Set();
  walk(tree, (node) => {
    if (node.kind === 'leaf' && ccCodes.has(node.code)) {
      let cur = node;
      while (cur) {
        idsToInclude.add(cur.id);
        cur = cur.parentId ? tree.nodes.get(cur.parentId) : null;
      }
    }
  });
  for (const id of idsToInclude) {
    const n = tree.nodes.get(id);
    if (n) out.nodes.set(id, { ...n });
  }
  // Also collect leaves that are in scope but their immediate parent might not
  // already be a "parent" kind (e.g., recommended single-leaf groups).
  out.rootIds = tree.rootIds.filter((id) => idsToInclude.has(id));
  return out;
}

function cssEscape(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

function exportProject(projectId) {
  const p = state.projects.find((x) => x.id === projectId);
  if (!p) return;
  const slug = (p.name || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  // Reuse buildAllCsvs but feed it a fake report whose lists are the filtered ones.
  const fakeReport = { ...state.report, ...p.filtered };
  const files = buildAllCsvs(fakeReport);
  // Add a manifest CSV listing the cost centres in scope, useful for review.
  const manifestRows = [...p.ccCodes].sort().map((code) => {
    const m = state.master.records.find((r) => r.code === code) || {};
    return { Code: code, Name: m.name || '', ProfitCentre: m.profitCentre || '', ResponsiblePerson: m.responsiblePerson || '' };
  });
  files['cost_centres_in_scope.csv'] = toCsv(manifestRows, ['Code', 'Name', 'ProfitCentre', 'ResponsiblePerson']);
  downloadZip(`project_${slug}.zip`, files);
}

function escape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escape(s).replace(/`/g, '&#96;'); }
function empty(msg) { return `<div class="empty-state">${escape(msg)}</div>`; }

// ---------- Sidebar action handlers (event delegation) ----------

function handleSidebarClick(ev) {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'apply-rec' || action === 'apply-rec-with-unplaced') {
    const rec = state.recommendations.find((r) => r.id === btn.dataset.id);
    if (!rec || !state.working) return;
    pushHistory();
    applyRecommendation(rec, action === 'apply-rec-with-unplaced');
    recompute();
  } else if (action === 'resolve-dup') {
    const code = btn.dataset.code;
    const keepSource = btn.dataset.keepSource;
    const keepPath = btn.dataset.keepPath;
    pushHistory();
    resolveDuplicate(code, keepSource, keepPath);
    recompute();
  } else if (action === 'add-missing') {
    const code = btn.dataset.code;
    const m = state.master.records.find((r) => r.code === code);
    if (!m || !state.working) return;
    pushHistory();
    addNode(state.working, {
      id: genId('m'),
      code: m.code,
      name: m.name || m.code,
      parentId: null,
      kind: 'leaf',
      source: 'manual',
    });
    recompute();
  } else if (action === 'export-project') {
    exportProject(btn.dataset.id);
  } else if (action === 'download-starter-projects') {
    downloadStarterProjects();
  }
}

function downloadStarterProjects() {
  if (!state.projects.length) {
    setStatus('Nothing to export — load PC hierarchy and master list first.', 'error');
    return;
  }
  const rows = [];
  for (const p of state.projects) {
    if (p.id === '__unassigned__') continue;
    for (const code of p.ccCodes) {
      const m = state.master.records.find((r) => r.code === code) || {};
      rows.push({ Code: code, Project: p.name, Description: m.name || '' });
    }
  }
  const csv = toCsv(rows, ['Code', 'Project', 'Description']);
  downloadString('projects.csv', csv);
  setStatus('Downloaded projects.csv. Edit in Excel and re-upload to override scope.', 'ok');
}

function applyRecommendation(rec, addUnplaced) {
  const t = state.working;
  // Create a new parent at root.
  const parent = addNode(t, {
    id: genId('rec'),
    name: rec.suggestedParentName,
    code: '',
    parentId: null,
    kind: 'parent',
    source: 'recommended',
  });
  // Move every leaf with a matching code under it.
  for (const code of rec.memberCodes) {
    const node = findByCode(t, code);
    if (node) {
      moveNode(t, node.id, parent.id);
    } else if (addUnplaced) {
      const m = state.master.records.find((r) => r.code === code);
      addNode(t, {
        id: genId('mr'),
        code,
        name: m?.name || code,
        parentId: parent.id,
        kind: 'leaf',
        source: 'recommended',
      });
    }
  }
}

function resolveDuplicate(code, keepSource, keepPath) {
  // Within the working tree, keep the leaf whose parentPath matches keepPath
  // and delete the other occurrences. The keepSource hint is just for UX.
  const t = state.working;
  const occs = [];
  walk(t, (node, _depth, path) => {
    if (node.kind === 'leaf' && node.code === code) {
      const p = path.slice(0, -1).map((n) => n.name || n.code).join(' / ');
      occs.push({ node, parentPath: p });
    }
  });
  if (occs.length <= 1) return;
  let kept = occs.find((o) => o.parentPath === keepPath);
  if (!kept) kept = occs[0];
  for (const o of occs) if (o.node.id !== kept.node.id) deleteNode(t, o.node.id);
}

// ---------- Filtering via tiles ----------

function setFilter(f) {
  state.filter = state.filter === f ? null : f;
  $$('.tile').forEach((t) => t.classList.toggle('active', t.dataset.filter === state.filter));
  // Quality tiles jump to the Reports view and select the matching tab.
  const tabFor = { duplicates: 'duplicates', missing: 'missing', invalid: 'invalid' };
  if (state.filter && tabFor[state.filter]) {
    setView('reports');
    setActiveTab(tabFor[state.filter]);
  }
  renderSidebar();
}

function setActiveTab(name) {
  state.activeTab = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
}

// ---------- Wiring ----------

function wireDropzones() {
  for (const slot of ['A', 'B', 'master', 'pc', 'projects']) {
    const dz = $(`label.dropzone[data-slot="${slot}"]`);
    const input = dz.querySelector('input[type=file]');
    input.addEventListener('change', (ev) => {
      const f = ev.target.files[0];
      if (f) loadSlot(slot, f);
    });
    dz.addEventListener('dragover', (ev) => { ev.preventDefault(); dz.classList.add('drag'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
    dz.addEventListener('drop', (ev) => {
      ev.preventDefault();
      dz.classList.remove('drag');
      const f = ev.dataTransfer.files[0];
      if (f) loadSlot(slot, f);
    });
  }
}

function wireTabs() {
  $('#tabs').addEventListener('click', (ev) => {
    const t = ev.target.closest('.tab');
    if (!t) return;
    setActiveTab(t.dataset.tab);
  });
}

function wireTiles() {
  $('#tiles').addEventListener('click', (ev) => {
    const t = ev.target.closest('.tile');
    if (!t) return;
    setFilter(t.dataset.filter);
  });
}

function wireExports() {
  $('#exportZip').addEventListener('click', async () => {
    if (!state.report) { setStatus('Nothing to export yet.', 'error'); return; }
    const files = buildAllCsvs(state.report);
    files['working_hierarchy.csv'] = buildWorkingHierarchyCsv(state.working);
    await downloadZip('cost_centre_diff.zip', files);
    setStatus('ZIP downloaded.', 'ok');
  });
  $$('button[data-export]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!state.report) { setStatus('Nothing to export yet.', 'error'); return; }
      const name = btn.dataset.export;
      let body;
      if (name === 'working_hierarchy') {
        body = buildWorkingHierarchyCsv(state.working);
      } else {
        body = buildCsv(name, state.report);
      }
      downloadString(`${name}.csv`, body);
    });
  });
}

// --- Tabular hierarchy editor ----------------------------------------------
// Flat editable table. Bulk reparent via checkbox-select + parent picker,
// inline rename of code/name, per-row delete, search filter.
function renderWorkingTable(container, tree) {
  container.innerHTML = '';
  // Build the parent options once
  const parentChoices = [{ id: '__root__', label: '— root —' }];
  walk(tree, (node, _depth, path) => {
    if (node.kind === 'parent') {
      parentChoices.push({
        id: node.id,
        label: path.map((n) => n.name || n.code).join(' / '),
      });
    }
  });

  // Build rows: every node, sorted by parent path then name
  const rows = [];
  walk(tree, (node, depth, path) => {
    rows.push({
      node,
      depth,
      parentPath: path.slice(0, -1).map((n) => n.name || n.code).join(' / ') || '— root —',
    });
  });

  const filterValue = (container.dataset.filter || '').toLowerCase();
  const visible = filterValue
    ? rows.filter((r) => {
        const hay = `${r.node.code} ${r.node.name} ${r.parentPath}`.toLowerCase();
        return hay.includes(filterValue);
      })
    : rows;

  const selectedIds = new Set((container.dataset.selected || '').split(',').filter(Boolean));

  const optsHtml = parentChoices.map((c) =>
    `<option value="${escapeAttr(c.id)}">${escape(c.label)}</option>`
  ).join('');

  const head = `
    <div class="table-toolbar">
      <input type="search" class="table-filter" placeholder="Filter by code, name, or parent..." value="${escapeAttr(filterValue)}" />
      <span class="table-stats muted">${visible.length} of ${rows.length} rows · ${selectedIds.size} selected</span>
      <span class="table-bulk">
        <select class="bulk-parent" ${selectedIds.size ? '' : 'disabled'}>
          <option value="">Move selected to…</option>
          ${optsHtml}
        </select>
        <button class="btn btn-small bulk-delete" ${selectedIds.size ? '' : 'disabled'}>Delete selected</button>
      </span>
    </div>`;

  let body = `<table class="hier-table"><thead><tr>
    <th class="cb"><input type="checkbox" class="select-all" ${selectedIds.size === visible.length && visible.length ? 'checked' : ''}/></th>
    <th>Kind</th>
    <th>Code</th>
    <th>Name</th>
    <th>Parent</th>
    <th class="actions"></th>
  </tr></thead><tbody>`;
  for (const r of visible) {
    const node = r.node;
    const checked = selectedIds.has(node.id) ? 'checked' : '';
    body += `<tr data-id="${escapeAttr(node.id)}">
      <td class="cb"><input type="checkbox" class="row-check" ${checked}/></td>
      <td><span class="kind kind-${node.kind}">${node.kind}</span></td>
      <td><input type="text" class="cell-code" value="${escapeAttr(node.code || '')}" placeholder="(none)"/></td>
      <td><input type="text" class="cell-name" value="${escapeAttr(node.name || '')}"/></td>
      <td>
        <select class="cell-parent">
          ${parentChoices.map((c) => {
            const sel = (c.id === '__root__' && !node.parentId) || c.id === node.parentId;
            return `<option value="${escapeAttr(c.id)}"${sel ? ' selected' : ''}>${escape(c.label)}</option>`;
          }).join('')}
        </select>
      </td>
      <td class="actions"><button class="row-delete" title="Delete">×</button></td>
    </tr>`;
  }
  body += '</tbody></table>';
  container.innerHTML = head + body;

  // Event wiring (delegated)
  container.querySelector('.table-filter').addEventListener('input', (e) => {
    container.dataset.filter = e.target.value;
    renderWorkingTable(container, tree);
    e.target.focus();
    e.target.setSelectionRange(e.target.value.length, e.target.value.length);
  });

  container.querySelector('.select-all').addEventListener('change', (e) => {
    if (e.target.checked) {
      container.dataset.selected = visible.map((r) => r.node.id).join(',');
    } else {
      container.dataset.selected = '';
    }
    renderWorkingTable(container, tree);
  });

  container.querySelectorAll('.row-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      const tr = cb.closest('tr');
      const id = tr.dataset.id;
      const ids = new Set((container.dataset.selected || '').split(',').filter(Boolean));
      if (cb.checked) ids.add(id); else ids.delete(id);
      container.dataset.selected = [...ids].join(',');
      renderWorkingTable(container, tree);
    });
  });

  // Inline edit on code / name (commit on blur or Enter)
  container.querySelectorAll('.cell-code, .cell-name').forEach((inp) => {
    const tr = inp.closest('tr');
    const id = tr.dataset.id;
    const field = inp.classList.contains('cell-code') ? 'code' : 'name';
    const node = tree.nodes.get(id);
    if (!node) return;
    const commit = () => {
      const v = inp.value.trim();
      if (v === (node[field] || '')) return;
      pushHistory();
      node[field] = v;
      recompute();
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
      if (e.key === 'Escape') { inp.value = node[field] || ''; inp.blur(); }
    });
  });

  // Per-row parent change
  container.querySelectorAll('.cell-parent').forEach((sel) => {
    const id = sel.closest('tr').dataset.id;
    sel.addEventListener('change', () => {
      const newParent = sel.value === '__root__' ? null : sel.value;
      // Refuse cycles
      if (newParent && wouldCycle(tree, id, newParent)) {
        alert('Cannot move a node under itself or its own descendants.');
        renderWorkingTable(container, tree);
        return;
      }
      pushHistory();
      moveNode(tree, id, newParent);
      recompute();
    });
  });

  container.querySelectorAll('.row-delete').forEach((btn) => {
    const id = btn.closest('tr').dataset.id;
    btn.addEventListener('click', () => {
      const node = tree.nodes.get(id);
      if (!node) return;
      if (!confirm(`Delete "${node.name || node.code}" and any descendants?`)) return;
      pushHistory();
      deleteNode(tree, id);
      const ids = new Set((container.dataset.selected || '').split(',').filter(Boolean));
      ids.delete(id);
      container.dataset.selected = [...ids].join(',');
      recompute();
    });
  });

  // Bulk reparent
  const bulkSel = container.querySelector('.bulk-parent');
  bulkSel.addEventListener('change', () => {
    const newParent = bulkSel.value === '__root__' ? null : bulkSel.value;
    const ids = (container.dataset.selected || '').split(',').filter(Boolean);
    if (!ids.length || !bulkSel.value) return;
    let moved = 0;
    pushHistory();
    for (const id of ids) {
      if (newParent && wouldCycle(tree, id, newParent)) continue;
      moveNode(tree, id, newParent);
      moved += 1;
    }
    setStatus(`Moved ${moved} of ${ids.length} selected nodes.`, 'ok');
    container.dataset.selected = '';
    recompute();
  });

  // Bulk delete
  const bulkDel = container.querySelector('.bulk-delete');
  bulkDel.addEventListener('click', () => {
    const ids = (container.dataset.selected || '').split(',').filter(Boolean);
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} selected node(s) and any descendants?`)) return;
    pushHistory();
    for (const id of ids) deleteNode(tree, id);
    container.dataset.selected = '';
    recompute();
  });
}

function wouldCycle(tree, nodeId, newParentId) {
  let cur = tree.nodes.get(newParentId);
  while (cur) {
    if (cur.id === nodeId) return true;
    cur = cur.parentId ? tree.nodes.get(cur.parentId) : null;
  }
  return false;
}

function wireWorkingActions() {
  // Tree / Table mode toggle
  document.querySelectorAll('.seg-btn[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.hierarchyMode = btn.dataset.mode;
      recompute();
    });
  });
  $('#addRoot').addEventListener('click', () => {
    if (!state.working) state.working = { nodes: new Map(), rootIds: [] };
    const name = prompt('Name of new root group:', 'New group');
    if (!name) return;
    pushHistory();
    addNode(state.working, {
      id: genId('m'),
      name,
      code: '',
      parentId: null,
      kind: 'parent',
      source: 'manual',
    });
    recompute();
  });
  $('#resetWorking').addEventListener('click', () => {
    if (!state.trees.B && !state.trees.A) return;
    if (!confirm('Discard your edits and reset working tree to B?')) return;
    pushHistory();
    state.working = cloneTree(state.trees.B || state.trees.A);
    recompute();
  });
  $('#undo').addEventListener('click', undo);

  // Event delegation for action buttons rendered into any panel
  // (Changes / Duplicates / Missing / Invalid / Recommendations).
  document.body.addEventListener('click', handleSidebarClick);
}

// ---------- Sample data ----------

const SAMPLES = {
  hierarchy_a_csv: `Level1,Level2,Level3,Code,Name
Group,Operations,Manufacturing,CC100,Plant A
Group,Operations,Manufacturing,CC101,Plant B
Group,Operations,Logistics,CC102,Warehouse North
Group,Operations,Logistics,CC103,Warehouse South
Group,Sales,Domestic,CC200,Direct Sales UK
Group,Sales,Domestic,CC201,Retail UK
Group,Sales,International,CC202,EU Sales
Group,Support,IT,CC300,IT Helpdesk
Group,Support,HR,CC301,IT Infrastructure
Group,Support,HR,CC302,HR Operations
Group,Support,Finance,CC303,Finance Ops
Group,Support,Finance,CC304,Treasury
`,
  hierarchy_b_csv: `Code,Name,ParentCode
ROOT,Group,
OPS,Operations,ROOT
MFG,Manufacturing,OPS
LOG,Logistics,OPS
SAL,Sales,ROOT
DOM,Domestic,SAL
INT,International,SAL
SUP,Support,ROOT
IT,IT,SUP
HR,HR,SUP
FIN,Finance,SUP
DIG,Digital,SAL
CC100,Plant A (renamed),MFG
CC101,Plant B,MFG
CC102,Warehouse North,LOG
CC200,Direct Sales UK,DOM
CC201,Retail UK,DOM
CC202,EU Sales,INT
CC203,APAC Sales,INT
CC300,IT Helpdesk,IT
CC301,IT Infrastructure,IT
CC302,HR Operations,HR
CC303,Finance Ops,FIN
CC304,Treasury,FIN
CC400,Web Platform,DIG
CC401,Data Analytics,DIG
CC401,Data Analytics,IT
`,
  master_csv: `Code,Name,ResponsiblePerson,ProfitCentre
CC100,Plant A,Alice Operations,PC100
CC101,Plant B,Alice Operations,PC100
CC102,Warehouse North,Alice Operations,PC110
CC103,Warehouse South,Alice Operations,PC110
CC200,Direct Sales UK,Bob Sales,PC200
CC201,Retail UK,Bob Sales,PC200
CC202,EU Sales,Bob Sales,PC210
CC203,APAC Sales,Bob Sales,PC210
CC300,IT Helpdesk,Carol IT,PC400
CC301,IT Infrastructure,Carol IT,PC400
CC302,HR Operations,Dave HR,PC410
CC303,Finance Ops,Eve Finance,PC420
CC304,Treasury,Eve Finance,PC420
CC400,Web Platform,Frank Digital,PC310
CC401,Data Analytics,Frank Digital,PC310
CC500,Investor Relations,Eve Finance,PC420
`,
  pc_csv: `Code,Name,ParentCode
PC1,Operations,
PC100,Manufacturing PC,PC1
PC110,Logistics PC,PC1
PC2,Sales,
PC200,Domestic Sales PC,PC2
PC210,International Sales PC,PC2
PC3,Marketing,
PC300,Brand PC,PC3
PC310,Digital PC,PC3
PC4,Support,
PC400,IT PC,PC4
PC410,HR PC,PC4
PC420,Finance PC,PC4
`,
  projects_csv: `Code,Project,Description
CC100,Plant Modernisation,Plant A reno Q3
CC101,Plant Modernisation,
CC102,Logistics Refresh,
CC103,Logistics Refresh,
CC200,Domestic Sales Push,
CC201,Domestic Sales Push,
CC202,International Sales Push,
CC203,International Sales Push,
CC300,Tech Refresh,
CC301,Tech Refresh,
CC302,People Programme,
CC303,Finance Optimisation,
CC304,Finance Optimisation,
CC400,Digital Build-out,
CC401,Digital Build-out,
`,
};

async function loadSamples() {
  const make = (name, body) => new File([body], name, { type: 'text/csv' });
  await loadSlot('A', make('hierarchy_a.csv', SAMPLES.hierarchy_a_csv));
  await loadSlot('B', make('hierarchy_b.csv', SAMPLES.hierarchy_b_csv));
  await loadSlot('master', make('master.csv', SAMPLES.master_csv));
  await loadSlot('pc', make('profit_centres.csv', SAMPLES.pc_csv));
  setStatus('Loaded sample CSVs. Switching to Compare view.', 'ok');
  setView('dashboard');
}

// ---------- Init ----------

function wireRail() {
  $$('.rail-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });
}

// --- Session save / load ----------------------------------------------------
// Serialise everything needed to resume: parsed CSVs (already plain JSON),
// per-slot column mappings, the working tree (Map -> array), the master
// records, the project assignments (Map/Set -> arrays), and view state.
const SESSION_VERSION = 1;
function serializeSession() {
  const tree = state.working;
  const treeJson = tree
    ? { rootIds: tree.rootIds, nodes: [...tree.nodes.values()] }
    : null;
  const fileMeta = (slot) => state.raw[slot] ? { name: state.raw[slot].name } : null;
  return {
    version: SESSION_VERSION,
    savedAt: new Date().toISOString(),
    fileMeta: { A: fileMeta('A'), B: fileMeta('B'), master: fileMeta('master'), pc: fileMeta('pc'), projects: fileMeta('projects') },
    parsed: state.parsed,
    mapping: state.mapping,
    working: treeJson,
    hierarchyMode: state.hierarchyMode,
    activeView: state.activeView,
    projectAssignments: state.projectAssignments
      ? {
          byCode: [...state.projectAssignments.byCode.entries()],
          projects: [...state.projectAssignments.projects.entries()].map(
            ([k, v]) => [k, { description: v.description, codes: [...v.codes] }],
          ),
        }
      : null,
  };
}

function saveSession() {
  const json = JSON.stringify(serializeSession(), null, 2);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadString(`cchier_session_${stamp}.json`, json, 'application/json');
  setStatus('Session saved.', 'ok');
}

async function loadSessionFromFile(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || data.version !== SESSION_VERSION) {
      setStatus(`Unsupported session file (version=${data && data.version}). Expected ${SESSION_VERSION}.`, 'error');
      return;
    }
    // Restore parsed sources, mappings, then re-run reparseSlot so trees rebuild.
    state.parsed = data.parsed || { A: null, B: null, master: null, pc: null, projects: null };
    state.mapping = data.mapping || { A: {}, B: {}, master: {}, pc: {}, projects: {} };
    for (const slot of ['A', 'B', 'master', 'pc', 'projects']) {
      const dz = $(`label.dropzone[data-slot="${slot}"]`);
      if (!dz) continue;
      const fnEl = dz.querySelector('[data-filename]');
      if (fnEl) fnEl.textContent = (data.fileMeta && data.fileMeta[slot] && data.fileMeta[slot].name) || (state.parsed[slot] ? '(restored)' : '');
      reparseSlot(slot);
      renderMapper(slot);
    }
    // Project assignments need their Map/Set rehydrated.
    if (data.projectAssignments) {
      state.projectAssignments = {
        byCode: new Map(data.projectAssignments.byCode),
        projects: new Map(
          data.projectAssignments.projects.map(([k, v]) => [k, { description: v.description, codes: new Set(v.codes) }]),
        ),
      };
    } else {
      state.projectAssignments = null;
    }
    // Working tree: rebuild Map from the array, reuse the saved rootIds.
    if (data.working) {
      const t = newTree();
      for (const n of data.working.nodes) t.nodes.set(n.id, n);
      t.rootIds = data.working.rootIds;
      state.working = t;
    } else {
      state.working = null;
    }
    state.workingHistory = [];
    state.hierarchyMode = data.hierarchyMode || 'tree';
    setView(data.activeView || 'imports');
    recompute();
    setStatus(`Session "${file.name}" loaded.`, 'ok');
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load session: ${err.message || err}`, 'error');
  }
}

function wireSessionButtons() {
  $('#saveSession').addEventListener('click', saveSession);
  const loader = $('#loadSession');
  if (loader) {
    const input = loader.querySelector('input[type=file]');
    input.addEventListener('change', (ev) => {
      const f = ev.target.files[0];
      if (f) loadSessionFromFile(f);
      ev.target.value = ''; // allow re-loading the same file
    });
  }
}

function init() {
  wireRail();
  wireDropzones();
  wireTabs();
  wireTiles();
  wireExports();
  wireWorkingActions();
  wireSessionButtons();
  $('#loadSamples').addEventListener('click', loadSamples);
  $('#clearAll').addEventListener('click', clearAll);
  setView('imports');
  recompute();
}

// Module scripts execute after the DOM is parsed, but in some load paths
// DOMContentLoaded has already fired by the time we get here. Run init now
// if the document is already past 'loading'; otherwise wait for the event.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
