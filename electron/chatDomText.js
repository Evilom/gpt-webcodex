// Self-contained: the same reader is injected into the page observers.
function readBoundedDomText(root, limit, skipSelector = '') {
  if (!root) return '';
  const rawLimit = limit * 4;
  let text = '', visited = 0, node = root.firstChild;
  while (node && visited++ < 4096 && text.length < rawLimit) {
    const skip = node.nodeType === 1 && skipSelector && node.matches(skipSelector);
    if (!skip && node.nodeType === 3) {
      text += node.substringData(0, rawLimit - text.length);
    } else if (!skip && node.firstChild) {
      node = node.firstChild;
      continue;
    }
    while (node !== root && !node.nextSibling) node = node.parentNode;
    if (node === root) break;
    node = node.nextSibling;
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}

module.exports = { readBoundedDomText };
