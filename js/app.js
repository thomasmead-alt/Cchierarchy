// App bootstrap. Wires together CSV import → tree build → diff → render.

import { parseFile, parseHierarchy, parseMaster, detectFormat } from './csv.js';
import { newTree, cloneTree, addNode, genId, walk, findByCode, moveNode, deleteNode } from './model.js';
import { compare, summarise } from './diff.js';
import { suggest } from './recommend.js';
import { renderTree } from './editor.js';
import {
  buildAllCsvs,
  buildCsv,
  buildWorkingHierarchyCsv,
  downloadString,
  downloadZip,
} from './export.js';

const state = {
  raw: { A: null, B: null, master: null },
  parsed: { A: null, B: null, master: null },
  trees: { A: null, B: null },
  master: { records: [], headers: [] },
  working: null,
  workingHistory: [],
  filter: null,
  activeTab: 'duplicates',
  activeView: 'imports',
  report: null,
  recommendations: [],
};

const VIEW_TITLES = {
  imports: 'Imports',
  dashboard: 'Compare',
  hierarchy: 'Hierarchy',
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
    if (slot === 'master') {
      const m = parseMaster(parsed);
      state.master = { records: m.records, headers: parsed.meta.fields || [] };
      $(`label.dropzone[data-slot="master"] [data-format]`).textContent = 'master';
    } else {
      const headers = parsed.meta.fields || [];
      const fmt = detectFormat(headers);
      const result = parseHierarchy(parsed, slot, fmt);
      state.trees[slot] = result.tree;
      $(`label.dropzone[data-slot="${slot}"] [data-format]`).textContent = result.format;
    }
    setStatus(`Loaded <strong>${file.name}</strong> into ${slot}.`, 'ok');
    recompute();
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load ${file.name}: ${err.message || err}`, 'error');
  }
}

function clearAll() {
  state.raw = { A: null, B: null, master: null };
  state.parsed = { A: null, B: null, master: null };
  state.trees = { A: null, B: null };
  state.master = { records: [], headers: [] };
  state.working = null;
  state.workingHistory = [];
  state.filter = null;
  state.report = null;
  state.recommendations = [];
  for (const slot of ['A', 'B', 'master']) {
    $(`label.dropzone[data-slot="${slot}"] [data-filename]`).textContent = '';
    $(`label.dropzone[data-slot="${slot}"] [data-format]`).textContent = '';
  }
  recompute();
  setStatus('Cleared. Drop CSVs to begin.');
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
  if (b) renderTree($('#tree-B'), b, { editable: false, highlights: hlB });
  else $('#tree-B').innerHTML = '<div class="empty-state">Drop hierarchy B above.</div>';
  if (state.working) {
    renderTree($('#tree-working'), state.working, {
      editable: true,
      highlights: hlW,
      onChange: () => {
        pushHistory();
        recompute();
      },
    });
  } else {
    $('#tree-working').innerHTML = '<div class="empty-state">Working hierarchy will appear once A or B is loaded.</div>';
  }

  $('#meta-A').textContent = a ? `${countLeaves(a)} cost centres / ${countParents(a)} groups` : '';
  $('#meta-B').textContent = b ? `${countLeaves(b)} cost centres / ${countParents(b)} groups` : '';

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
  }
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
  for (const slot of ['A', 'B', 'master']) {
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

function wireWorkingActions() {
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
  master_csv: `Code,Name,ResponsiblePerson
CC100,Plant A,Alice Operations
CC101,Plant B,Alice Operations
CC102,Warehouse North,Alice Operations
CC103,Warehouse South,Alice Operations
CC200,Direct Sales UK,Bob Sales
CC201,Retail UK,Bob Sales
CC202,EU Sales,Bob Sales
CC203,APAC Sales,Bob Sales
CC300,IT Helpdesk,Carol IT
CC301,IT Infrastructure,Carol IT
CC302,HR Operations,Dave HR
CC303,Finance Ops,Eve Finance
CC304,Treasury,Eve Finance
CC400,Web Platform,Frank Digital
CC401,Data Analytics,Frank Digital
CC500,Investor Relations,Eve Finance
`,
};

async function loadSamples() {
  const make = (name, body) => new File([body], name, { type: 'text/csv' });
  await loadSlot('A', make('hierarchy_a.csv', SAMPLES.hierarchy_a_csv));
  await loadSlot('B', make('hierarchy_b.csv', SAMPLES.hierarchy_b_csv));
  await loadSlot('master', make('master.csv', SAMPLES.master_csv));
  setStatus('Loaded sample CSVs. Switching to Compare view.', 'ok');
  setView('dashboard');
}

// ---------- Init ----------

function wireRail() {
  $$('.rail-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });
}

function init() {
  wireRail();
  wireDropzones();
  wireTabs();
  wireTiles();
  wireExports();
  wireWorkingActions();
  $('#loadSamples').addEventListener('click', loadSamples);
  $('#clearAll').addEventListener('click', clearAll);
  setView('imports');
  recompute();
}

document.addEventListener('DOMContentLoaded', init);
