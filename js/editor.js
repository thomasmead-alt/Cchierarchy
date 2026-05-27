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

// opts:
//   editable   — render edit affordances (DnD, +/×, rename)
//   highlights — Map<nodeId, classSuffix> for diff colour-coding
//   onChange   — callback(movedId) after a mutation
//   scopeIds   — optional Set<id>. When provided, nodes NOT in the set are
//                skipped at render time. The underlying tree is still the live
//                one, so edits via DnD / inline rename commit to it.
//   ccColors   — optional Map<code, {bg, edge, name}>. Tints leaf nodes with
//                the responsible-person spotlight colour.
function renderTree(container, tree, opts = {}) {
  const {
    editable = false,
    highlights = new Map(),
    onChange = () => {},
    scopeIds = null,
    ccColors = null,
  } = opts;
  container.innerHTML = '';
  if (!tree || tree.nodes.size === 0) {
    container.appendChild(el('div', { class: 'empty-state' }, 'No data loaded.'));
    return;
  }

  const ctx = { editable, highlights, onChange, scopeIds, ccColors };
  const rootUl = el('ul', { class: 'tree-root', dataset: { parentId: '__root__' } });
  for (const node of rootNodes(tree)) {
    if (scopeIds && !scopeIds.has(node.id)) continue;
    rootUl.appendChild(renderNode(tree, node, ctx));
  }
  container.appendChild(rootUl);

  if (editable) wireSortable(container, tree, onChange);
}

function renderNode(tree, node, ctx) {
  const li = el('li', { dataset: { id: node.id } });
  const allChildren = childrenOf(tree, node.id);
  const children = ctx.scopeIds
    ? allChildren.filter((c) => ctx.scopeIds.has(c.id))
    : allChildren;
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
      target.addEventListener('dblclick', () => beginEdit(target, tree, node, i === 0 ? 'code' : 'name', ctx.onChange));
      target.addEventListener('click', (ev) => {
        if (ev.detail === 2) return; // dblclick handler will fire
      });
    });
  }

  const nodeRow = el('span', {
    class: 'node',
    dataset: { id: node.id, kind: node.kind },
  }, [toggle, kindEl, codeEl, ' ', nameEl]);

  // Responsible-person colour band (leaf nodes only). Background is set via a
  // CSS variable so an active diff highlight can still override it, while the
  // left-edge band stays visible either way.
  if (node.kind === 'leaf' && ctx.ccColors) {
    const c = ctx.ccColors.get(node.code);
    if (c) {
      nodeRow.classList.add('rp-tinted');
      nodeRow.style.setProperty('--rp-bg', c.bg);
      nodeRow.style.setProperty('--rp-edge', c.edge);
      if (c.name) nodeRow.title = `Responsible: ${c.name}`;
    }
  }

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
          if (code) addLeafUnder(tree, node.id, { code, name, source: 'manual' });
          else addParentUnder(tree, node.id, { name, source: 'manual' });
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

function beginEdit(target, tree, node, field, onChange) {
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
        renameNode(tree, node.id, { [field]: v });
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
  // Native HTML5 drag-and-drop, wired via delegation on the container.
  // We REBIND fresh listeners on every render so the closures always
  // reference the current tree. Previously we used a sentinel attribute to
  // bind once, but that captured a stale tree reference once state.working
  // was replaced (load A then B, restore session, reset, etc.) and drops on
  // any leaf whose id wasn't in the original tree silently no-op'd.
  let draggedId = null;
  let blocked = new Set();

  const collectDescendants = (id, out = new Set()) => {
    out.add(id);
    for (const n of tree.nodes.values()) {
      if (n.parentId === id) collectDescendants(n.id, out);
    }
    return out;
  };

  const clearHighlights = () => {
    container.querySelectorAll('.drag-over, .drag-block').forEach((el) => {
      el.classList.remove('drag-over');
      el.classList.remove('drag-block');
    });
  };

  // Mark every LI draggable on this render.
  for (const li of container.querySelectorAll('li[data-id]')) {
    li.setAttribute('draggable', 'true');
  }

  // Detach previously attached handlers (if any) before adding new ones, so
  // we don't accumulate duplicate listeners across renders.
  const prev = container._dndCleanup;
  if (typeof prev === 'function') prev();

  const onDragStart = (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li || !container.contains(li)) return;
    draggedId = li.dataset.id;
    blocked = collectDescendants(draggedId);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', draggedId); } catch (_) {}
    li.classList.add('drag-source');
    container.classList.add('dragging');
    for (const ul of container.querySelectorAll('ul')) {
      const tp = ul.dataset.parentId === '__root__' ? null : ul.dataset.parentId;
      if (tp && blocked.has(tp)) ul.classList.add('drag-block');
    }
  };
  const onDragEnd = () => {
    container.classList.remove('dragging');
    container.querySelectorAll('.drag-source').forEach((el) => el.classList.remove('drag-source'));
    clearHighlights();
    draggedId = null;
    blocked = new Set();
  };
  const onDragOver = (e) => {
    if (!draggedId) return;
    const ul = e.target.closest('ul');
    if (!ul || !container.contains(ul)) return;
    const targetParent = ul.dataset.parentId === '__root__' ? null : ul.dataset.parentId;
    if (targetParent && blocked.has(targetParent)) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const onDragEnter = (e) => {
    if (!draggedId) return;
    const ul = e.target.closest('ul');
    if (!ul || !container.contains(ul)) return;
    const targetParent = ul.dataset.parentId === '__root__' ? null : ul.dataset.parentId;
    if (targetParent && blocked.has(targetParent)) return;
    container.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    ul.classList.add('drag-over');
  };
  const onDragLeave = (e) => {
    const ul = e.target.closest('ul');
    if (!ul || !container.contains(ul)) return;
    if (e.target === ul) ul.classList.remove('drag-over');
  };
  const onDrop = (e) => {
    if (!draggedId) return;
    const ul = e.target.closest('ul');
    if (!ul || !container.contains(ul)) return;
    const targetParent = ul.dataset.parentId === '__root__' ? null : ul.dataset.parentId;
    if (targetParent && blocked.has(targetParent)) return;
    e.preventDefault();
    e.stopPropagation();
    const movedId = draggedId;
    moveNode(tree, movedId, targetParent);
    draggedId = null;
    blocked = new Set();
    container.classList.remove('dragging');
    clearHighlights();
    onChange(movedId);
  };

  container.addEventListener('dragstart', onDragStart);
  container.addEventListener('dragend', onDragEnd);
  container.addEventListener('dragover', onDragOver);
  container.addEventListener('dragenter', onDragEnter);
  container.addEventListener('dragleave', onDragLeave);
  container.addEventListener('drop', onDrop);
  container._dndCleanup = () => {
    container.removeEventListener('dragstart', onDragStart);
    container.removeEventListener('dragend', onDragEnd);
    container.removeEventListener('dragover', onDragOver);
    container.removeEventListener('dragenter', onDragEnter);
    container.removeEventListener('dragleave', onDragLeave);
    container.removeEventListener('drop', onDrop);
  };
}

// Briefly highlight a node after a re-render so the user can see where their
// drag landed. Called by app.js on each onChange that supplies the moved id.
function flashMoved(container, nodeId) {
  if (!nodeId || !container) return;
  const li = container.querySelector(`li[data-id="${cssEscape(nodeId)}"]`);
  if (!li) return;
  const node = li.querySelector('.node');
  if (!node) return;
  node.classList.add('drag-flash');
  // bring into view if it's scrolled off
  if (typeof node.scrollIntoView === 'function') {
    node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  setTimeout(() => node.classList.remove('drag-flash'), 900);
}
