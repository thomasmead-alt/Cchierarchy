// Tree rendering. Two modes: read-only (for A and B) and editable (for the
// working hierarchy). Editable mode supports drag-and-drop reparenting via
// SortableJS, inline rename of code/name, add and delete nodes.

import {
  childrenOf,
  rootNodes,
  moveNode,
  deleteNode,
  addNode,
  genId,
} from './model.js';

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// flags: { highlights: Map<nodeId, 'new'|'amended'|'deleted'|'duplicate'|'invalid'|'recommended'> }
export function renderTree(container, tree, opts = {}) {
  const { editable = false, highlights = new Map(), onChange = () => {} } = opts;
  container.innerHTML = '';
  if (!tree || tree.nodes.size === 0) {
    container.appendChild(el('div', { class: 'empty-state' }, 'No data loaded.'));
    return;
  }

  const rootUl = el('ul', { class: 'tree-root', dataset: { parentId: '__root__' } });
  for (const node of rootNodes(tree)) {
    rootUl.appendChild(renderNode(tree, node, { editable, highlights, onChange }));
  }
  container.appendChild(rootUl);

  if (editable) wireSortable(container, tree, onChange);
}

function renderNode(tree, node, ctx) {
  const li = el('li', { dataset: { id: node.id } });
  const children = childrenOf(tree, node.id);
  const expanded = true;

  const toggle = el('span', {
    class: 'toggle',
    onclick: () => li.classList.toggle('collapsed'),
  }, children.length ? '▾' : '·');

  const codeEl = el('span', { class: 'code' }, node.code || '');
  const nameEl = el('span', { class: 'name' }, node.name || '');
  const kindEl = el('span', { class: 'kind' }, node.kind === 'parent' ? 'parent' : 'leaf');

  if (ctx.editable) {
    [codeEl, nameEl].forEach((target, i) => {
      target.title = 'Click to edit';
      target.addEventListener('dblclick', () => beginEdit(target, node, i === 0 ? 'code' : 'name', ctx.onChange));
      target.addEventListener('click', (ev) => {
        if (ev.detail === 2) return; // dblclick handler will fire
      });
    });
  }

  const nodeRow = el('span', {
    class: 'node',
    dataset: { id: node.id, kind: node.kind },
  }, [toggle, kindEl, codeEl, ' ', nameEl]);

  // diff highlight
  const hl = ctx.highlights.get(node.id);
  if (hl) nodeRow.classList.add(`diff-${hl}`);

  if (ctx.editable) {
    const actions = el('span', { class: 'node-actions' }, [
      el('button', {
        title: 'Add child',
        onclick: () => {
          const code = prompt('Code for new node (blank for parent group):', '');
          const name = prompt('Name:', code || 'New node');
          if (name == null) return;
          addNode(tree, {
            id: genId('m'),
            code: code || '',
            name,
            parentId: node.id,
            kind: code ? 'leaf' : 'parent',
            source: 'manual',
          });
          if (node.kind === 'leaf') node.kind = 'parent';
          ctx.onChange();
        },
      }, '+ child'),
      el('button', {
        title: 'Delete node and its descendants',
        onclick: () => {
          if (!confirm(`Delete "${node.name || node.code}" and all descendants?`)) return;
          deleteNode(tree, node.id);
          ctx.onChange();
        },
      }, '×'),
    ]);
    nodeRow.appendChild(actions);
  }

  li.appendChild(nodeRow);

  if (children.length) {
    const ul = el('ul', { dataset: { parentId: node.id } });
    for (const child of children) ul.appendChild(renderNode(tree, child, ctx));
    li.appendChild(ul);
  } else if (ctx.editable) {
    // empty container so users can drop into this node
    const ul = el('ul', { dataset: { parentId: node.id } });
    li.appendChild(ul);
  }
  return li;
}

function beginEdit(target, node, field, onChange) {
  const original = node[field] || '';
  target.contentEditable = 'true';
  target.focus();
  // place caret at end
  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const finish = (commit) => {
    target.contentEditable = 'false';
    target.removeEventListener('blur', onBlur);
    target.removeEventListener('keydown', onKey);
    if (commit) {
      const v = target.textContent.trim();
      if (v !== original) {
        node[field] = v;
        onChange();
      }
    } else {
      target.textContent = original;
    }
  };
  const onBlur = () => finish(true);
  const onKey = (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  };
  target.addEventListener('blur', onBlur);
  target.addEventListener('keydown', onKey);
}

function wireSortable(container, tree, onChange) {
  // Use SortableJS on every <ul> within the container so users can drag a node
  // into any group's child list.
  const lists = container.querySelectorAll('ul');
  for (const ul of lists) {
    new Sortable(ul, {
      group: 'cchier',
      animation: 120,
      fallbackOnBody: true,
      swapThreshold: 0.65,
      ghostClass: 'drag-ghost',
      onEnd: (evt) => {
        const id = evt.item.dataset.id;
        const newParentId = evt.to.dataset.parentId === '__root__' ? null : evt.to.dataset.parentId;
        moveNode(tree, id, newParentId);
        onChange();
      },
    });
  }
}
