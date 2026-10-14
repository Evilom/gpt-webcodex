// Runs inside isolated renderer fixtures, not the user's app or ChatGPT session.
module.exports = function probeLayout(selectors) {
  const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const name = el => el.id || el.className || el.tagName;
  const issues = [];
  for (const group of document.querySelectorAll(selectors)) {
    if (!visible(group)) continue;
    const rect = group.getBoundingClientRect();
    const children = Array.from(group.children).filter(el => visible(el) && !['absolute','fixed'].includes(getComputedStyle(el).position));
    if (group.scrollWidth > group.clientWidth + 2) issues.push({kind:'overflow',group:name(group),width:group.clientWidth,content:group.scrollWidth});
    for (const child of children) {
      const box = child.getBoundingClientRect();
      if (box.left < rect.left - 2 || box.right > rect.right + 2 || box.top < rect.top - 2 || box.bottom > rect.bottom + 2) issues.push({kind:'outside',group:name(group),child:name(child),bounds:[rect.left,rect.top,rect.right,rect.bottom],childBounds:[box.left,box.top,box.right,box.bottom]});
    }
    for (let i=0;i<children.length;i++) for (let j=i+1;j<children.length;j++) {
      const a=children[i].getBoundingClientRect(),b=children[j].getBoundingClientRect();
      if (Math.min(a.right,b.right)-Math.max(a.left,b.left)>2 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>2) issues.push({kind:'overlap',group:name(group),children:[name(children[i]),name(children[j])]});
    }
  }
  for (const row of document.querySelectorAll('.setting-row:not(.setting-column)')) {
    if (!visible(row)) continue;
    const label=row.querySelector('span:first-child'),control=row.querySelector('select');
    if (label && control && label.getBoundingClientRect().width < 140 && row.getBoundingClientRect().width > 260) issues.push({kind:'cramped-label',control:name(control),width:label.getBoundingClientRect().width});
  }
  const scrollbars=Array.from(document.querySelectorAll('body *')).filter(el=>visible(el)&&/auto|scroll/.test(getComputedStyle(el).overflow)).map(el=>({
    width:getComputedStyle(el,'::-webkit-scrollbar').width,
    track:getComputedStyle(el,'::-webkit-scrollbar-track').backgroundColor,
    buttons:getComputedStyle(el,'::-webkit-scrollbar-button').display,
    nativeWidth:getComputedStyle(el).scrollbarWidth
  }));
  return {issues,scrollbars,viewport:{width:innerWidth,height:innerHeight},bodyOverflow:document.documentElement.scrollWidth>innerWidth+2};
};
