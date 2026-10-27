// Navigation only: never remount fields or bypass the normal review/validation path.
export function createReportFormNavigation({ toolbar, fields, submit, enabled, canNavigate }) {
  const sectionSelect = toolbar?.querySelector('#reportFormSection');
  const go = toolbar?.querySelector('#reportFormSectionGo');
  const review = toolbar?.querySelector('#reportFormReviewShortcut');
  let headings = [];
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
