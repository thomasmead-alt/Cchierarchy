// Manager-placement recommender. For each ResponsiblePerson with ≥2 cost
// centres in the working tree, identify the one at the shallowest position
// in the hierarchy (the "manager" CC). Suggest moving every other CC of
// that person UNDER the manager so the manager's reports actually report
// to them in the cost-centre structure too.
//
// Tie-break: when multiple owned CCs share the shallowest depth, pick the
// alphabetically first by code so the choice is deterministic.
//
// Skipped when:
//   - person has only one CC in the working tree;
//   - all of the person's other CCs are already descendants of the manager.


var norm = (s) => (s == null ? '' : String(s).trim());

function suggest(masterRecords, workingTree) {
  if (!workingTree || workingTree.nodes.size === 0) return [];

  // Build code -> node lookup, plus a depth-from-root for every node.
  // Note: we accept BOTH leaves and parent nodes with codes, because a
  // previously-applied manager-placement promotes the manager CC to kind
  // 'parent' but it should still be recognised as the same person's CC.
  const codeToNode = new Map();
  const depthOf = new Map();
  walk(workingTree, (node, depth) => {
    depthOf.set(node.id, depth);
    if (node.code && !codeToNode.has(node.code)) {
      codeToNode.set(node.code, node);
    }
  });

  // Group master records by responsible person.
  const groups = new Map();
  for (const r of masterRecords) {
    const person = norm(r.responsiblePerson);
    if (!person) continue;
    if (!groups.has(person)) groups.set(person, []);
    groups.get(person).push(r);
  }

  const isUnder = (descendant, ancestorId) => {
    let cur = descendant.parentId ? workingTree.nodes.get(descendant.parentId) : null;
    while (cur) {
      if (cur.id === ancestorId) return true;
      cur = cur.parentId ? workingTree.nodes.get(cur.parentId) : null;
    }
    return false;
  };

  const out = [];
  for (const [person, members] of groups) {
    if (members.length < 2) continue;

    // Members that are actually placed in the working tree.
    const present = members
      .map((m) => ({ record: m, node: codeToNode.get(m.code) }))
      .filter((x) => !!x.node);
    if (present.length < 2) continue;

    // Sort by depth ascending (shallowest first), then by code.
    present.sort((a, b) => {
      const da = depthOf.get(a.node.id) ?? 99;
      const db = depthOf.get(b.node.id) ?? 99;
      return da - db || (a.record.code || '').localeCompare(b.record.code || '');
    });
    const manager = present[0];

    const others = present.slice(1);
    const toMove = others.filter((o) => !isUnder(o.node, manager.node.id));
    if (toMove.length === 0) continue; // already structured correctly

    const alreadyPlaced = others.filter((o) => isUnder(o.node, manager.node.id)).map((o) => o.record.code);
    const unplaced = members.filter((m) => !codeToNode.has(m.code)).map((m) => m.code);

    out.push({
      id: `mgr_${person.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`,
      kind: 'manager-placement',
      responsiblePerson: person,
      managerCode: manager.record.code,
      managerName: manager.node.name,
      managerDepth: depthOf.get(manager.node.id),
      moveCodes: toMove.map((o) => o.record.code),
      alreadyPlacedCodes: alreadyPlaced,
      unplacedCodes: unplaced,
      rationale:
        `${person} is responsible for ${members.length} cost centres. ` +
        `${manager.record.code} (${manager.node.name}) sits at the shallowest position in the hierarchy; ` +
        `${toMove.length} of their other CC${toMove.length === 1 ? '' : 's'} should sit beneath it.`,
    });
  }

  // Most-impactful (largest move count) first.
  out.sort((a, b) => b.moveCodes.length - a.moveCodes.length);
  return out;
}
