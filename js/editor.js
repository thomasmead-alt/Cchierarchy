// Tree rendering. Two modes: read-only (for A and B) and editable (for the
// working hierarchy). Editable mode supports drag-and-drop reparenting via
// SortableJS, inline rename of code/name, add and delete nodes.


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
function renderTree(container, tree, opts = {}) {
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
  // Native HTML5 drag-and-drop. No external library.
  // Each LI is draggable; each UL is a drop target. On drop we update the
  // model via moveNode() and re-render via onChange().
  let draggedId = null;

  // Pre-compute descendant set for the dragged node so we can refuse drops
  // into the node itself or any of its children (which would create a cycle).
  let blocked = new Set();
  const collectDescendants = (id, out = new Set()) => {
    out.add(id);
    for (const n of tree.nodes.values()) {
      if (n.parentId === id) collectDescendants(n.id, out);
    }
    return out;
  };

  const lis = container.querySelectorAll('li[data-id]');
  for (const li of lis) {
    li.setAttribute('draggable', 'true');
    li.addEventListener('dragstart', (e) => {
      draggedId = li.dataset.id;
      blocked = collectDescendants(draggedId);
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', draggedId); } catch (_) {}
      li.classList.add('drag-ghost');
      e.stopPropagation();
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('drag-ghost');
      container.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
      draggedId = null;
      blocked = new Set();
    });
  }

  const uls = container.querySelectorAll('ul');
  for (const ul of uls) {
    ul.addEventListener('dragover', (e) => {
      if (!draggedId) return;
      const targetParent = ul.dataset.parentId === '__root__' ? null : ul.dataset.parentId;
      if (targetParent && blocked.has(targetParent)) return; // refuse cycle
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    ul.addEventListener('dragenter', (e) => {
      if (!draggedId) return;
      const targetParent = ul.dataset.parentId === '__root__' ? null : ul.dataset.parentId;
      if (targetParent && blocked.has(targetParent)) return;
      e.stopPropagation();
      // clear other highlights, then mark this ul
      container.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
      ul.classList.add('drag-over');
    });
    ul.addEventListener('dragleave', (e) => {
      if (e.target === ul) ul.classList.remove('drag-over');
    });
    ul.addEventListener('drop', (e) => {
      if (!draggedId) return;
      const targetParent = ul.dataset.parentId === '__root__' ? null : ul.dataset.parentId;
      if (targetParent && blocked.has(targetParent)) return;
      e.preventDefault();
      e.stopPropagation();
      ul.classList.remove('drag-over');
      moveNode(tree, draggedId, targetParent);
      const movedId = draggedId;
      draggedId = null;
      blocked = new Set();
      onChange(movedId);
    });
  }
}
