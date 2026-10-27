// Navigation only: never remount fields or bypass the normal review/validation path.
export function createReportFormNavigation({ toolbar, fields, submit, enabled, canNavigate }) {
  const sectionSelect = toolbar?.querySelector('#reportFormSection');
  const go = toolbar?.querySelector('#reportFormSectionGo');
  const review = toolbar?.querySelector('#reportFormReviewShortcut');
  let headings = [];
  let tabs;
  // The Report tabs sit at the bottom on phones and stick to the top on larger
  // screens. Measure their actual height, including translated/wrapped labels.
  function layout() {
    if (!toolbar || toolbar.hidden) return;
    const nextTabs = toolbar.closest('#workerView, .supervisor-self-submit')?.querySelector('.tabs');
    if (tabs !== nextTabs) {
      if (tabs) resizeObserver.unobserve(tabs);
      tabs = nextTabs;
      if (tabs) resizeObserver.observe(tabs);
    }
    const tabsStyle = tabs && getComputedStyle(tabs);
    const offset = tabsStyle?.position === 'sticky'
      ? tabs.getBoundingClientRect().height + (parseFloat(tabsStyle.top) || 0) + 4 : 0;
    toolbar.style.setProperty('--report-tabs-offset', `${Math.ceil(offset)}px`);
    const top = parseFloat(getComputedStyle(toolbar).top) || 0;
    fields.style.setProperty('--report-section-scroll-margin',
      `${Math.ceil(Math.max(170, top + toolbar.getBoundingClientRect().height + 16))}px`);
  }
  const resizeObserver = new ResizeObserver(layout);
  if (toolbar) resizeObserver.observe(toolbar);
  window.addEventListener('resize', layout);
  function render(form) {
    if (!toolbar) return;
    headings = [...fields.querySelectorAll(':scope > .work-form-section > h3')];
    toolbar.hidden = !enabled || !form || (headings.length < 3 && (form.fields?.length || 0) < 20);
    sectionSelect.replaceChildren(...headings.map((heading, index) => {
      heading.tabIndex = -1;
      return new Option(heading.textContent, String(index));
    }));
    sectionSelect.closest('label').hidden = !headings.length;
    go.hidden = !headings.length;
    sync();
  }
  function sync() {
    if (!toolbar) return;
    for (const control of [sectionSelect, go, review]) control.disabled = !canNavigate();
    layout();
  }
  go?.addEventListener('click', () => {
    if (!canNavigate()) return;
    const heading = headings[Number(sectionSelect.value)];
    if (!heading?.isConnected) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: 'start' });
  });
  review?.addEventListener('click', () => {
    if (canNavigate() && !submit.disabled) submit.click();
  });
  return { render, sync };
}
