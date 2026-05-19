// ============================================================================
// Tree data model — single source of truth for the hierarchy shape and every
// mutation primitive that other modules use.
//
// TREE CONTRACT
//   Tree  = { nodes: Map<id, Node>, rootIds: string[] }
//   Node  = { id, code, name, parentId, kind: 'parent'|'leaf', source }
//
//   - `id`        — app-generated stable ID (NOT the CC code). Codes can
//                   legitimately repeat across A vs working while user
//                   resolves duplicates, so we never key by code.
//   - `parentId`  — null for root nodes; for non-roots, must point at an
//                   existing node in the same tree.
//   - `rootIds`   — every node with `parentId === null` MUST be listed.
//   - `kind`      — 'parent' if the node holds children, 'leaf' otherwise.
//                   Mutations (moveNode, addLeafUnder) automatically promote
//                   a leaf to parent when it gains a first child.
//
// Every mutation goes through one of the helpers in this file. Callers MUST
// NOT mutate node fields or rootIds directly — the lazy `_childIndex` cache
// would go stale.
// ============================================================================

let _counter = 0;
function genId(prefix = 'n') {
  _counter += 1;
  return `${prefix}_${_counter.toString(36)}`;
}

function newTree() {
  return { nodes: new Map(), rootIds: [] };
}

function _invalidate(tree) { tree._childIndex = null; }

function addNode(tree, partial) {
  const id = partial.id || genId();
  const node = {
    id,
    code: partial.code || '',
    name: partial.name || '',
    parentId: partial.parentId || null,
    kind: partial.kind || 'leaf',
    source: partial.source || 'manual',
  };
  tree.nodes.set(id, node);
  if (!node.parentId) tree.rootIds.push(id);
  _invalidate(tree);
  return node;
}

// Lazy parent->children index. Built on first call and reused until any
// mutation invalidates it. Without this, childrenOf scans every node which
// makes walk() O(n²) — painful past a few thousand nodes.
function _buildChildIndex(tree) {
  const idx = new Map();
  for (const n of tree.nodes.values()) {
    const arr = idx.get(n.parentId);
    if (arr) arr.push(n); else idx.set(n.parentId, [n]);
  }
  tree._childIndex = idx;
  return idx;
}

function childrenOf(tree, parentId) {
  const idx = tree._childIndex || _buildChildIndex(tree);
  return idx.get(parentId) || [];
}

function rootNodes(tree) {
  return tree.rootIds.map((id) => tree.nodes.get(id)).filter(Boolean);
}

function walk(tree, visitor, parentId = null, depth = 0, path = []) {
  const list = parentId === null ? rootNodes(tree) : childrenOf(tree, parentId);
  for (const node of list) {
    const nextPath = [...path, node];
    visitor(node, depth, nextPath);
    walk(tree, visitor, node.id, depth + 1, nextPath);
  }
}

// Walk only the subset of `tree` whose ids are in `scopeIds`. Children
// outside scope are pruned at render time but their data is NOT touched —
// edits made elsewhere still apply to the live tree.
function walkScoped(tree, scopeIds, visitor, parentId = null, depth = 0, path = []) {
  if (!scopeIds) return walk(tree, visitor, parentId, depth, path);
  const list = parentId === null ? rootNodes(tree) : childrenOf(tree, parentId);
  for (const node of list) {
    if (!scopeIds.has(node.id)) continue;
    const nextPath = [...path, node];
    visitor(node, depth, nextPath);
    walkScoped(tree, scopeIds, visitor, node.id, depth + 1, nextPath);
  }
}

// path of nodes from root to node (inclusive)
function pathOf(tree, node) {
  const out = [];
  let cur = node;
  while (cur) {
    out.unshift(cur);
    cur = cur.parentId ? tree.nodes.get(cur.parentId) : null;
  }
  return out;
}

function pathString(tree, node) {
  return pathOf(tree, node).map((n) => n.name || n.code).join(' / ');
}

// Mutate node fields in-place. Returns the node (or null if missing).
function renameNode(tree, nodeId, fields) {
  const node = tree.nodes.get(nodeId);
  if (!node) return null;
  if (typeof fields.name === 'string') node.name = fields.name;
  if (typeof fields.code === 'string') node.code = fields.code;
  return node;
}

function addLeafUnder(tree, parentId, { code = '', name = '', source = 'manual' } = {}) {
  const node = addNode(tree, { code, name, parentId, kind: 'leaf', source });
  if (parentId) {
    const p = tree.nodes.get(parentId);
    if (p && p.kind === 'leaf') p.kind = 'parent';
  }
  return node;
}

function addParentUnder(tree, parentId, { name = 'New group', code = '', source = 'manual' } = {}) {
  const node = addNode(tree, { code, name, parentId, kind: 'parent', source });
  if (parentId) {
    const p = tree.nodes.get(parentId);
    if (p && p.kind === 'leaf') p.kind = 'parent';
  }
  return node;
}

function moveNode(tree, nodeId, newParentId) {
  const node = tree.nodes.get(nodeId);
  if (!node) return;
  _invalidate(tree);
  // detach from current
  if (!node.parentId) {
    tree.rootIds = tree.rootIds.filter((id) => id !== nodeId);
  }
  // attach to new
  if (newParentId) {
    // prevent cycles
    let cur = tree.nodes.get(newParentId);
    while (cur) {
      if (cur.id === nodeId) return; // would create a cycle
      cur = cur.parentId ? tree.nodes.get(cur.parentId) : null;
    }
    node.parentId = newParentId;
    const parent = tree.nodes.get(newParentId);
    if (parent && parent.kind === 'leaf') parent.kind = 'parent';
  } else {
    node.parentId = null;
    if (!tree.rootIds.includes(nodeId)) tree.rootIds.push(nodeId);
  }
}

function deleteNode(tree, nodeId) {
  const node = tree.nodes.get(nodeId);
  if (!node) return;
  // Snapshot children before mutating so the index invalidation doesn't bite
  // mid-iteration.
  const kids = childrenOf(tree, nodeId).slice();
  _invalidate(tree);
  for (const child of kids) deleteNode(tree, child.id);
  tree.nodes.delete(nodeId);
  tree.rootIds = tree.rootIds.filter((id) => id !== nodeId);
}

function cloneTree(tree) {
  const out = newTree();
  for (const n of tree.nodes.values()) out.nodes.set(n.id, { ...n });
  out.rootIds = [...tree.rootIds];
  return out;
}

// Flatten leaves with their root-to-leaf path of node names.
function flattenLeaves(tree) {
  const out = [];
  walk(tree, (node, _depth, path) => {
    if (node.kind === 'leaf') {
      out.push({
        id: node.id,
        code: node.code,
        name: node.name,
        path: path.slice(0, -1).map((n) => n.name || n.code),
        parentId: node.parentId,
      });
    }
  });
  return out;
}

// Flatten parent (non-leaf) nodes
function flattenParents(tree) {
  const out = [];
  walk(tree, (node, _depth, path) => {
    if (node.kind === 'parent') {
      out.push({
        id: node.id,
        code: node.code,
        name: node.name,
        path: path.slice(0, -1).map((n) => n.name || n.code),
        parentId: node.parentId,
      });
    }
  });
  return out;
}

// Find a node by exact code (returns first match).
function findByCode(tree, code) {
  if (!code) return null;
  for (const n of tree.nodes.values()) if (n.code === code) return n;
  return null;
}

// Resolve a slash-delimited parent path (e.g. "Group / Sales / Domestic")
// to a parent node in the tree. Returns the node, or null if not found.
function findParentByPath(tree, pathStr) {
  if (!pathStr) return null;
  const segments = pathStr.split('/').map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return null;
  let candidate = null;
  walk(tree, (node, _depth, p) => {
    if (node.kind !== 'parent') return;
    const key = p.map((n) => (n.name || n.code).trim()).join(' / ');
    if (key === segments.join(' / ')) candidate = node;
  });
  return candidate;
}

// Ensure a slash-delimited parent path exists. Returns the leaf parent
// (the deepest one). Creates empty parent nodes for any missing segment.
function ensurePath(tree, pathStr, opts = {}) {
  const source = opts.source || 'manual';
  const segments = (pathStr || '').split('/').map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return null;
  let parentId = null;
  let cursor = null;
  for (let i = 0; i < segments.length; i++) {
    const wantedKey = segments.slice(0, i + 1).join(' / ');
    cursor = null;
    const candidates = childrenOf(tree, parentId);
    for (const c of candidates) {
      const name = (c.name || c.code).trim();
      const fullKey = (parentId
        ? pathString(tree, tree.nodes.get(parentId)) + ' / ' + name
        : name);
      if (fullKey === wantedKey && c.kind === 'parent') { cursor = c; break; }
    }
    if (!cursor) {
      cursor = addParentUnder(tree, parentId, { name: segments[i], source });
    }
    parentId = cursor.id;
  }
  return cursor;
}

// Delete every leaf with `code` except the one whose id === keptId.
function dedupeCodeKeeping(tree, code, keptId) {
  if (!code) return 0;
  let removed = 0;
  const victims = [];
  for (const n of tree.nodes.values()) {
    if (n.kind === 'leaf' && n.code === code && n.id !== keptId) victims.push(n.id);
  }
  for (const id of victims) { deleteNode(tree, id); removed += 1; }
  return removed;
}

// Dev assertion — throws on inconsistencies. Cheap enough to run on every
// tree change in development; called from inline tests at startup.
function assertTree(tree, label = 'tree') {
  if (!tree || !(tree.nodes instanceof Map) || !Array.isArray(tree.rootIds)) {
    throw new Error(`${label}: not a Tree (missing nodes:Map or rootIds:Array)`);
  }
  for (const id of tree.rootIds) {
    if (!tree.nodes.has(id)) throw new Error(`${label}: rootId ${id} not in nodes`);
    const n = tree.nodes.get(id);
    if (n.parentId) throw new Error(`${label}: root ${id} has parentId ${n.parentId}`);
  }
  for (const n of tree.nodes.values()) {
    if (n.parentId && !tree.nodes.has(n.parentId)) {
      throw new Error(`${label}: node ${n.id} parentId ${n.parentId} missing`);
    }
    if (n.kind !== 'parent' && n.kind !== 'leaf') {
      throw new Error(`${label}: node ${n.id} bad kind ${n.kind}`);
    }
    if (!n.parentId && !tree.rootIds.includes(n.id)) {
      throw new Error(`${label}: parent-less node ${n.id} not in rootIds`);
    }
  }
}
