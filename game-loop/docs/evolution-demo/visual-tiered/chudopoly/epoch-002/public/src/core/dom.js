// core/dom.js — element building and GUARDED writes.
//
// Guarded: every setter compares before it writes. Unguarded style/text writes
// on the HUD were the measurable cost in the old client — the turn timer alone
// wrote textContent 60×/s on a node whose text changes once a second, and each
// write invalidates layout for the whole header row.
//
// Nothing here ever produces HTML from a string: text goes in as text (§0.4).

/**
 * el('div', {class, id, text, attrs, style, dataset}, children)
 * `text` is set with textContent — the only way text enters the DOM here.
 */
export function el(tag, props = null, children = null) {
  const node = document.createElement(tag);
  if (props) {
    if (props.class) node.className = props.class;
    if (props.id) node.id = props.id;
    if (props.text != null) node.textContent = String(props.text);
    if (props.attrs) for (const k in props.attrs) {
      const v = props.attrs[k];
      if (v === false || v == null) continue;
      node.setAttribute(k, v === true ? '' : String(v));
    }
    if (props.dataset) for (const k in props.dataset) node.dataset[k] = String(props.dataset[k]);
    if (props.style) for (const k in props.style) node.style.setProperty(k, props.style[k]);
  }
  if (children) append(node, children);
  return node;
}

export function append(parent, children) {
  if (children == null) return parent;
  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) append(parent, children[i]);
    return parent;
  }
  parent.appendChild(typeof children === 'string' ? document.createTextNode(children) : children);
  return parent;
}

export function $(id) { return document.getElementById(id); }
export function qs(sel, root = document) { return root.querySelector(sel); }
export function qsa(sel, root = document) { return root.querySelectorAll(sel); }

/** Remove all children. Never innerHTML — card nodes must survive (§0.4). */
export function clear(node) {
  if (!node) return node;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function setText(node, text) {
  if (!node) return false;
  const value = text == null ? '' : String(text);
  if (node.textContent === value) return false;
  node.textContent = value;
  return true;
}

export function setAttr(node, name, value) {
  if (!node) return false;
  if (value == null || value === false) {
    if (!node.hasAttribute(name)) return false;
    node.removeAttribute(name);
    return true;
  }
  const v = value === true ? '' : String(value);
  if (node.getAttribute(name) === v) return false;
  node.setAttribute(name, v);
  return true;
}

export function setStyle(node, prop, value) {
  if (!node) return false;
  const v = value == null ? '' : String(value);
  if (node.style.getPropertyValue(prop) === v) return false;
  node.style.setProperty(prop, v);
  return true;
}

export function setClass(node, name, on) {
  if (!node) return false;
  const has = node.classList.contains(name);
  if (has === !!on) return false;
  node.classList.toggle(name, !!on);
  return true;
}

export function setHidden(node, hidden) {
  if (!node) return false;
  const value = !!hidden;
  if (node.hidden === value) return false;
  node.hidden = value;
  return true;
}

/** Reorder `nodes` inside `parent` touching only the positions that are wrong. */
export function orderChildren(parent, nodes) {
  if (!parent) return 0;
  let moves = 0;
  let ref = null;                       // walk backwards; ref is the next sibling
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.parentNode === parent && node.nextSibling === ref) { ref = node; continue; }
    parent.insertBefore(node, ref);
    ref = node;
    moves++;
  }
  return moves;
}

export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
