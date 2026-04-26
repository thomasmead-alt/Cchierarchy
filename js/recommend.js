// Build recommended parent-node groupings from the master list's
// ResponsiblePerson column.
//
// A suggestion is emitted when ≥2 cost centres share a responsible person
// AND those cost centres are NOT already all siblings under a single parent
// in the working tree.

import { walk } from './model.js';

const norm = (s) => (s == null ? '' : String(s).trim());

function buildLeafLookup(workingTree) {
  // code -> { node, parentId }
  const out = new Map();
  walk(workingTree, (node) => {
    if (node.kind === 'leaf' && node.code) {
      // multiple occurrences possible; record the first one. duplicates are
      // surfaced separately and shouldn't block recommendations.
      if (!out.has(node.code)) out.set(node.code, node);
    }
  });
  return out;
}

export function suggest(masterRecords, workingTree) {
  const groups = new Map(); // person -> [masterRecord]
  for (const r of masterRecords) {
    const person = norm(r.responsiblePerson);
    if (!person) continue;
    if (!groups.has(person)) groups.set(person, []);
    groups.get(person).push(r);
  }

  const leafLookup = buildLeafLookup(workingTree);
  const suggestions = [];

  for (const [person, members] of groups) {
    if (members.length < 2) continue;

    // What parents do these cost centres currently sit under in the working tree?
    const presentNodes = members
      .map((m) => leafLookup.get(m.code))
      .filter(Boolean);
    const presentCodes = presentNodes.map((n) => n.code);
    if (presentNodes.length < 2) continue;

    const parentIds = new Set(presentNodes.map((n) => n.parentId || '__root__'));
    if (parentIds.size === 1) {
      // already siblings under a single parent — nothing to suggest
      continue;
    }

    // codes from master that are not yet placed in the working tree at all
    const missingFromTree = members
      .filter((m) => !leafLookup.has(m.code))
      .map((m) => m.code);

    suggestions.push({
      id: `rec_${person.replace(/\s+/g, '_').toLowerCase()}`,
      responsiblePerson: person,
      suggestedParentName: `${person}'s cost centres`,
      memberCodes: members.map((m) => m.code),
      placedCodes: presentCodes,
      unplacedCodes: missingFromTree,
      currentParentCount: parentIds.size,
      rationale:
        `${members.length} cost centres share '${person}' as responsible person ` +
        `but currently span ${parentIds.size} different parent(s) in the working tree.`,
    });
  }

  // sort: most-impactful first (more members, more current parents)
  suggestions.sort(
    (a, b) =>
      b.memberCodes.length - a.memberCodes.length ||
      b.currentParentCount - a.currentParentCount,
  );
  return suggestions;
}
