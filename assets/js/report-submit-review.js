import { setTranslatableAttribute, setTranslatableText } from './i18n.js';
import { formatWorkFormAnswer, summarizeWorkFormAnswers } from './work-form-fields.js';

// Display-only: never change the captured answers or create upload requests.
export function renderReportSubmitReview(container, { form, answers, workDate, siteName, photoCount }) {
  const document = container.ownerDocument;
  const fragment = document.createDocumentFragment();
  const summary = summarizeWorkFormAnswers(form, answers);

  function element(tag, className = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function literal(node, value) {
    node.setAttribute('data-no-i18n', '');
    node.textContent = String(value ?? '');
    return node;
  }

  function translated(node, value) {
    setTranslatableText(node, value);
    return node;
  }

  function item(list, label, literalLabel = false) {
    const group = element('div', 'report-review-item');
    const term = element('dt');
    (literalLabel ? literal : translated)(term, label);
    const description = element('dd');
    group.append(term, description);
    list.append(group);
    return description;
  }

  function missing(node) {
    node.classList.add('report-review-empty');
    translated(node, 'Not provided');
  }

  function renderValue(node, entry) {
    if (entry.type === 'repeat') {
      if (!entry.rows.length) return missing(node);
      const rows = element('ol', 'report-review-rows');
      entry.rows.forEach((row, index) => {
        const rowNode = element('li', 'report-review-row');
        rowNode.append(translated(element('p', 'report-review-row-label'), `Row ${index + 1}`));
        rowNode.append(renderAnswers(row));
        rows.append(rowNode);
      });
      node.append(rows);
      return;
    }

    if (entry.type === 'signature') {
      if (!entry.value) return missing(node);
      if (!entry.signatureSource) {
        translated(node, 'Signature preview unavailable');
        return;
      }
      const figure = element('figure', 'report-review-signature');
      const image = element('img');
      image.src = entry.signatureSource;
      image.decoding = 'async';
      setTranslatableAttribute(image, 'alt', 'Handwritten signature');
      figure.append(image, translated(element('figcaption'), 'Signed'));
      node.append(figure);
      return;
    }

    if (entry.type === 'time_range') {
      const { start, end, duration_hours: duration } = entry.value;
      if (!start && !end) return missing(node);
      // Keep the time range literal, but allow the generated duration to translate.
      node.append(literal(element('span'), `${start || '—'} – ${end || '—'}`));
      if (duration != null) {
        const durationLabel = translated(element('span', 'report-review-duration'), `${duration} hours`);
        node.append(document.createTextNode(' · '), durationLabel);
      }
      return;
    }

    if (entry.value === true || entry.value === false) {
      translated(node, entry.value ? 'Yes' : 'No');
      return;
    }
    const value = formatWorkFormAnswer(entry.value, entry.type);
    if (!value) return missing(node);
    literal(node, value);
  }

  function renderAnswers(entries) {
    const list = element('dl', 'report-review-answers');
    for (const entry of entries) renderValue(item(list, entry.label, true), entry);
    return list;
  }

  const metadata = element('dl', 'report-review-meta');
  literal(item(metadata, 'Report Template'), form?.name || '');
  if (workDate) literal(item(metadata, 'Report Date'), workDate);
  else missing(item(metadata, 'Report Date'));
  if (siteName) literal(item(metadata, 'Site'), siteName);
  else translated(item(metadata, 'Site'), 'No site selected');
  const count = Number(photoCount);
  literal(item(metadata, 'Photos'), Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0);
  fragment.append(metadata, translated(element('h4'), 'Answers'));
  if (summary.entries.length) fragment.append(renderAnswers(summary.entries));
  else fragment.append(translated(element('p', 'report-review-empty'), 'No answers required'));
  if (summary.hasCalculatedValues) {
    fragment.append(translated(element('p', 'muted report-review-calculation-note'), 'Calculated values are previews; the server confirms them on submission.'));
  }
  container.classList.add('report-submit-summary');
  container.replaceChildren(fragment);
}
