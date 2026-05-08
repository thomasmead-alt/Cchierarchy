// Build a Mermaid `flowchart TD` of the working hierarchy with diff classes
// applied: new, amended, deleted (subgraph), parent. Pure function — no DOM.
//
// options:
//   mode: 'compact' (only nodes touched by a change + ancestors) | 'full'
//   ccCodes: optional Set<code> to limit scope to a project
//   showDeleted: include a "Deleted from A" subgraph (default true)
//   title: optional diagram title (rendered as ::title:: comment)

function buildMermaidDiagram(workingTree, report, options) {
  options = options || {};
  const mode = options.mode || 'compact';
  const showDeleted = options.showDeleted !== false;
  const scope = options.ccCodes;

  const lines = ['flowchart TD'];
  lines.push('  classDef new fill:#E5F4ED,stroke:#00A972,color:#0A5A3D');
  lines.push('  classDef amended fill:#FFF4E0,stroke:#C26B00,color:#683800');
  lines.push('  classDef deleted fill:#FCE9EC,stroke:#D62F4B,color:#7A1830,stroke-dasharray:4 4');
  lines.push('  classDef parent fill:#EAF2F9,stroke:#2272B4,color:#0F3F66');
  if (options.title) lines.push(`  %% ${options.title}`);
  lines.push('');

  if (!workingTree || workingTree.nodes.size === 0) return lines.join('\n');

  const newSet = new Set(((report && report.newCC) || []).map((x) => x.code));
  const amendedSet = new Set(((report && report.amendedCC) || []).map((x) => x.code));

  const inScopeLeaf = (n) => !scope || (n.kind === 'leaf' && scope.has(n.code));

  let nodesToEmit = [];
  if (mode === 'compact') {
    const interesting = new Set();
    walk(workingTree, (node) => {
      if (node.kind !== 'leaf') return;
      if (scope && !scope.has(node.code)) return;
      if (!newSet.has(node.code) && !amendedSet.has(node.code)) return;
      let cur = node;
      while (cur) {
        interesting.add(cur.id);
        cur = cur.parentId ? workingTree.nodes.get(cur.parentId) : null;
      }
    });
    walk(workingTree, (node) => { if (interesting.has(node.id)) nodesToEmit.push(node); });
  } else {
    // 'full': include every node, optionally limited to project scope's
    // leaves + their ancestor chains.
    if (scope) {
      const include = new Set();
      walk(workingTree, (node) => {
        if (node.kind === 'leaf' && scope.has(node.code)) {
          let cur = node;
          while (cur) { include.add(cur.id); cur = cur.parentId ? workingTree.nodes.get(cur.parentId) : null; }
        }
      });
      walk(workingTree, (node) => { if (include.has(node.id)) nodesToEmit.push(node); });
    } else {
      walk(workingTree, (node) => nodesToEmit.push(node));
    }
  }

  if (nodesToEmit.length === 0 && (!showDeleted || !report || !report.deletedNodes || !report.deletedNodes.length)) {
    lines.push('  empty["No changes in scope"]');
    return lines.join('\n');
  }

  const idMap = new Map();
  let counter = 0;
  for (const n of nodesToEmit) idMap.set(n.id, 'n' + (++counter));

  // Edges first
  for (const n of nodesToEmit) {
    if (n.parentId && idMap.has(n.parentId)) {
      lines.push(`  ${idMap.get(n.parentId)} --> ${idMap.get(n.id)}`);
    }
  }
  // Node labels
  for (const n of nodesToEmit) {
    const label = (n.code ? `${n.code}<br/>${n.name || ''}` : (n.name || '?')).trim();
    lines.push(`  ${idMap.get(n.id)}[${escapeMermaidLabel(label)}]`);
  }
  // Class application
  const newIds = nodesToEmit.filter((n) => n.kind === 'leaf' && newSet.has(n.code)).map((n) => idMap.get(n.id));
  const amendedIds = nodesToEmit.filter((n) => n.kind === 'leaf' && amendedSet.has(n.code)).map((n) => idMap.get(n.id));
  const parentIds = nodesToEmit.filter((n) => n.kind === 'parent').map((n) => idMap.get(n.id));
  if (newIds.length) lines.push(`  class ${newIds.join(',')} new`);
  if (amendedIds.length) lines.push(`  class ${amendedIds.join(',')} amended`);
  if (parentIds.length) lines.push(`  class ${parentIds.join(',')} parent`);

  // Deleted leaves as a separate subgraph at the bottom (outside the live tree)
  if (showDeleted && report && report.deletedNodes) {
    const deletedLeaves = report.deletedNodes.filter((d) => d.kind === 'leaf' && (!scope || scope.has(d.code)));
    if (deletedLeaves.length) {
      lines.push('');
      lines.push('  subgraph del["Deleted from A"]');
      const delIds = [];
      let i = 0;
      for (const d of deletedLeaves) {
        i += 1;
        const id = `d${i}`;
        const label = d.code ? `${d.code}<br/>${d.name || ''}` : (d.name || '?');
        lines.push(`    ${id}[${escapeMermaidLabel(label)}]`);
        delIds.push(id);
      }
      lines.push('  end');
      if (delIds.length) lines.push(`  class ${delIds.join(',')} deleted`);
    }
  }

  return lines.join('\n');
}

function escapeMermaidLabel(s) {
  // Wrap in quotes; escape inner quotes. Preserve <br/> tags so labels can
  // line-wrap (mermaid renders HTML in quoted labels).
  return '"' + String(s == null ? '' : s).replace(/"/g, '#quot;') + '"';
}
