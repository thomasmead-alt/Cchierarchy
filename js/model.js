// Normalized hierarchy data model.
// A Tree is a plain object: { nodes: Map<id, Node>, rootIds: string[] }
// A Node is: { id, code, name, parentId, kind: 'parent'|'leaf', source }
// Codes are NOT used as ids since the same code may legitimately appear in
// both source files (and we may temporarily allow duplicates while resolving).

let _counter = 0;
function genId(prefix = 'n') {
  _counter += 1;
  return `${prefix}_${_counter.toString(36)}`;
}

function newTree() {
  return { nodes: new Map(), rootIds: [] };
}

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
  tree._childIndex = null; // invalidate
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

// path of names from root to node (inclusive)
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

function moveNode(tree, nodeId, newParentId) {
  const node = tree.nodes.get(nodeId);
  if (!node) return;
  tree._childIndex = null; // invalidate
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
  tree._childIndex = null; // invalidate
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
