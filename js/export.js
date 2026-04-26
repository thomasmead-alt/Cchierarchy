// Build CSV files from the comparison report and trigger downloads.

import { toCsv } from './csv.js';
import { walk, pathString } from './model.js';

const FILES = {
  new_cost_centres: {
    rows: (r) => r.newCC,
    headers: ['code', 'name', 'parentPath', 'responsiblePerson'],
  },
  amended_cost_centres: {
    rows: (r) => r.amendedCC,
    headers: ['code', 'oldName', 'newName', 'oldParentPath', 'newParentPath', 'changeType'],
  },
  new_nodes: {
    rows: (r) => r.newNodes,
    headers: ['path', 'name', 'code', 'childCount'],
  },
  amended_nodes: {
    rows: (r) => r.amendedNodes,
    headers: ['path', 'oldName', 'newName', 'renamed', 'addedChildren', 'removedChildren'],
  },
  deleted_nodes: {
    rows: (r) => r.deletedNodes,
    headers: ['kind', 'path', 'code', 'name', 'parentPath'],
  },
  duplicates: {
    rows: (r) => r.duplicates.flatMap((d) =>
      d.assignments.map((a) => ({
        code: d.code,
        source: a.source,
        parentPath: a.parentPath,
        name: a.name,
        responsiblePerson: d.responsiblePerson,
      })),
    ),
    headers: ['code', 'source', 'parentPath', 'name', 'responsiblePerson'],
  },
  missing: {
    rows: (r) => r.missing,
    headers: ['code', 'name', 'responsiblePerson'],
  },
  invalid: {
    rows: (r) => r.invalid,
    headers: ['code', 'source', 'issue', 'hierName', 'masterName', 'parentPath'],
  },
};

export function fileNames() {
  return Object.keys(FILES);
}

export function buildCsv(name, report) {
  const spec = FILES[name];
  if (!spec) return '';
  return toCsv(spec.rows(report), spec.headers);
}

export function buildAllCsvs(report) {
  const out = {};
  for (const name of Object.keys(FILES)) {
    out[`${name}.csv`] = buildCsv(name, report);
  }
  return out;
}

// Working hierarchy export: parent/child format, every node a row.
export function buildWorkingHierarchyCsv(tree) {
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

export function downloadString(filename, contents, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadZip(filename, files) {
  const zip = new JSZip();
  for (const [name, body] of Object.entries(files)) zip.file(name, body);
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
