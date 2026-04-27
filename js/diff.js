// Compare two trees and a master list. Returns a single report object
// with per-change-type lists, plus duplicates, missing, invalid.
//
// Keys:
//   leaf code is the natural key for a cost centre.
//   parent nodes don't always have codes (level-column files), so we use
//   their slash-delimited path-from-root as the key.


const norm = (s) => (s == null ? '' : String(s).trim());

function leafIndex(tree) {
  const out = new Map(); // code -> { node, parentPath }
  walk(tree, (node, _depth, path) => {
    if (node.kind === 'leaf' && node.code) {
      const parentPath = path.slice(0, -1).map((n) => n.name || n.code).join(' / ');
      // If the same code appears more than once, keep first; duplicates handled separately.
      if (!out.has(node.code)) out.set(node.code, { node, parentPath });
    }
  });
  return out;
}

function parentIndex(tree) {
  const out = new Map(); // path -> { node, childCodes:Set }
  walk(tree, (node, _depth, path) => {
    if (node.kind === 'parent') {
      const key = path.map((n) => n.name || n.code).join(' / ');
      out.set(key, { node, key, childCodes: new Set() });
    }
  });
  // populate childCodes
  walk(tree, (node, _depth, path) => {
    if (node.kind === 'leaf' && node.code) {
      const parent = path.slice(0, -1);
      if (!parent.length) return;
      const key = parent.map((n) => n.name || n.code).join(' / ');
      const entry = out.get(key);
      if (entry) entry.childCodes.add(node.code);
    }
  });
  return out;
}

// All occurrences (per tree) of a code, as { tree, parentPath, node }.
function allLeafOccurrences(tree, label) {
  const out = [];
  walk(tree, (node, _depth, path) => {
    if (node.kind === 'leaf' && node.code) {
      out.push({
        source: label,
        node,
        parentPath: path.slice(0, -1).map((n) => n.name || n.code).join(' / '),
      });
    }
  });
  return out;
}

function compare(treeA, treeB, masterRecords = []) {
  const masterByCode = new Map();
  for (const r of masterRecords) masterByCode.set(r.code, r);

  const leavesA = leafIndex(treeA);
  const leavesB = leafIndex(treeB);
  const parentsA = parentIndex(treeA);
  const parentsB = parentIndex(treeB);

  const newCC = [];
  const amendedCC = [];
  const newNodes = [];
  const amendedNodes = [];
  const deletedNodes = [];

  // ---- Cost centres (leaves) ----
  for (const [code, b] of leavesB) {
    const a = leavesA.get(code);
    if (!a) {
      newCC.push({
        code,
        name: b.node.name,
        parentPath: b.parentPath,
        responsiblePerson: masterByCode.get(code)?.responsiblePerson || '',
      });
    } else {
      const renamed = norm(a.node.name) !== norm(b.node.name);
      const reparented = a.parentPath !== b.parentPath;
      if (renamed || reparented) {
        amendedCC.push({
          code,
          oldName: a.node.name,
          newName: b.node.name,
          oldParentPath: a.parentPath,
          newParentPath: b.parentPath,
          changeType: [renamed && 'name', reparented && 'parent'].filter(Boolean).join('+'),
        });
      }
    }
  }
  for (const [code, a] of leavesA) {
    if (!leavesB.has(code)) {
      deletedNodes.push({
        kind: 'leaf',
        code,
        name: a.node.name,
        parentPath: a.parentPath,
      });
    }
  }

  // ---- Parent (group) nodes ----
  for (const [key, b] of parentsB) {
    const a = parentsA.get(key);
    if (!a) {
      newNodes.push({
        path: key,
        name: b.node.name,
        code: b.node.code || '',
        childCount: b.childCodes.size,
      });
    } else {
      // Compare child code sets and rename
      const renamed = norm(a.node.name) !== norm(b.node.name);
      const same = a.childCodes.size === b.childCodes.size &&
        [...a.childCodes].every((c) => b.childCodes.has(c));
      if (!same || renamed) {
        const added = [...b.childCodes].filter((c) => !a.childCodes.has(c));
        const removed = [...a.childCodes].filter((c) => !b.childCodes.has(c));
        amendedNodes.push({
          path: key,
          oldName: a.node.name,
          newName: b.node.name,
          renamed,
          addedChildren: added.join('|'),
          removedChildren: removed.join('|'),
        });
      }
    }
  }
  for (const [key, a] of parentsA) {
    if (!parentsB.has(key)) {
      deletedNodes.push({
        kind: 'parent',
        path: key,
        name: a.node.name,
        code: a.node.code || '',
      });
    }
  }

  // ---- Duplicates: same code under more than one distinct parent path across A∪B ----
  const occurrences = new Map(); // code -> [{source, parentPath, node}]
  for (const occ of allLeafOccurrences(treeA, 'A')) {
    if (!occurrences.has(occ.node.code)) occurrences.set(occ.node.code, []);
    occurrences.get(occ.node.code).push(occ);
  }
  for (const occ of allLeafOccurrences(treeB, 'B')) {
    if (!occurrences.has(occ.node.code)) occurrences.set(occ.node.code, []);
    occurrences.get(occ.node.code).push(occ);
  }
  const duplicates = [];
  for (const [code, occs] of occurrences) {
    const distinctParents = new Set(occs.map((o) => `${o.source}::${o.parentPath}`));
    // duplicates are codes assigned in MORE THAN ONE parent path. We consider
    // multiple distinct parent paths across A∪B as a duplicate concern.
    const distinctPathsOnly = new Set(occs.map((o) => o.parentPath));
    if (occs.length > 1 && distinctPathsOnly.size > 1) {
      duplicates.push({
        code,
        occurrenceCount: occs.length,
        assignments: occs.map((o) => ({
          source: o.source,
          parentPath: o.parentPath,
          name: o.node.name,
          nodeId: o.node.id,
        })),
        responsiblePerson: masterByCode.get(code)?.responsiblePerson || '',
      });
    }
  }

  // ---- Missing: master code not present in either A or B ----
  const allLeafCodes = new Set([...leavesA.keys(), ...leavesB.keys()]);
  const missing = [];
  for (const r of masterRecords) {
    if (!allLeafCodes.has(r.code)) {
      missing.push({
        code: r.code,
        name: r.name,
        responsiblePerson: r.responsiblePerson,
      });
    }
  }

  // ---- Invalid: hierarchy code not in master, or name mismatch vs master ----
  const invalid = [];
  for (const [code, b] of leavesB) {
    const m = masterByCode.get(code);
    if (!m) {
      invalid.push({
        code,
        source: 'B',
        issue: 'not-in-master',
        hierName: b.node.name,
        masterName: '',
        parentPath: b.parentPath,
      });
    } else if (norm(m.name) && norm(m.name) !== norm(b.node.name)) {
      invalid.push({
        code,
        source: 'B',
        issue: 'name-mismatch',
        hierName: b.node.name,
        masterName: m.name,
        parentPath: b.parentPath,
      });
    }
  }
  for (const [code, a] of leavesA) {
    const m = masterByCode.get(code);
    if (!m) {
      invalid.push({
        code,
        source: 'A',
        issue: 'not-in-master',
        hierName: a.node.name,
        masterName: '',
        parentPath: a.parentPath,
      });
    } else if (norm(m.name) && norm(m.name) !== norm(a.node.name)) {
      invalid.push({
        code,
        source: 'A',
        issue: 'name-mismatch',
        hierName: a.node.name,
        masterName: m.name,
        parentPath: a.parentPath,
      });
    }
  }

  // Whitespace/casing warnings on codes
  const codeWarnings = [];
  for (const code of allLeafCodes) {
    if (code !== code.trim() || code !== code.toUpperCase()) {
      codeWarnings.push({ code, issue: 'whitespace-or-case' });
    }
  }

  return {
    newCC,
    amendedCC,
    newNodes,
    amendedNodes,
    deletedNodes,
    duplicates,
    missing,
    invalid,
    codeWarnings,
  };
}

function summarise(report) {
  return {
    newCC: report.newCC.length,
    amendedCC: report.amendedCC.length,
    newNodes: report.newNodes.length,
    amendedNodes: report.amendedNodes.length,
    deletedNodes: report.deletedNodes.length,
    duplicates: report.duplicates.length,
    missing: report.missing.length,
    invalid: report.invalid.length,
  };
}
