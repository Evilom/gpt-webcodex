(() => {
  const api = window.shellPopover;
  const root = document.getElementById('popoverRoot');
  let token = '';
  api.onRender(payload => {
    const focusId = document.activeElement?.id;
    const scroll = root.firstElementChild?.scrollTop || 0;
    const first = token !== payload.token;
    token = payload.token;
    const mode = ['light','dark','black'].includes(payload.theme) ? payload.theme : 'light';
    for (const node of [document.documentElement,document.body]) {
      node.dataset.theme = mode === 'black' ? 'dark' : mode;
      node.dataset.themeMode = mode;
      node.dataset.skin = payload.skin === 'glass' ? 'glass' : 'classic';
    }
    root.innerHTML = payload.html;
    root.classList.toggle('popover-enter',first);
    if (root.firstElementChild) root.firstElementChild.scrollTop = scroll;
    if (first) root.querySelector('button:not(:disabled),input:not(:disabled)')?.focus({preventScroll:true});
    else if (focusId) document.getElementById(focusId)?.focus({preventScroll:true});
    api.send({ type:'ready',token });
  });
  root.addEventListener('click',event => {
    const button = event.target.closest('button[id]');
    if (button && !button.disabled) api.send({ type:'action',token,id:button.id,kind:'click' });
  });
  root.addEventListener('change',event => {
    const input = event.target;
    if (input.matches('input[type=checkbox][id]') && !input.disabled) api.send({ type:'action',token,id:input.id,kind:'change',checked:input.checked });
  });
  document.addEventListener('keydown',event => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault(); api.send({ type:'close',token }); return;
    }
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    const controls = [...root.querySelectorAll('button:not(:disabled),input:not(:disabled)')].filter(node=>node.getClientRects().length);
    if (!controls.length) return;
    const index = controls.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length-1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + controls.length) % controls.length;
    event.preventDefault(); controls[next].focus();
  });
})();
