(() => {
  const views = [
    [document.getElementById('advisorModelsTab'), document.getElementById('advisorModelsView')],
    [document.getElementById('advisorImagesTab'), document.getElementById('imageJobsSection')]
  ];
  function select(index, focus = false) {
    views.forEach(([tab, panel], current) => {
      tab.setAttribute('aria-selected', String(current === index));
      tab.tabIndex = current === index ? 0 : -1;
      panel.hidden = current !== index;
    });
    document.querySelector('.workbench-content').scrollTop = 0;
    if (focus) views[index][0].focus();
  }
  views.forEach(([tab], index) => {
    tab.onclick = () => select(index);
    tab.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      select(event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index, true);
    };
  });
})();
