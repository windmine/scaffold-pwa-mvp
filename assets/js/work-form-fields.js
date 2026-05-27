import { escapeHtml } from './utils.js';

function fieldInputId(field) {
  return `workFormField_${field.id}`;
}

function resetSignatureCanvas(canvas) {
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#111111';
  context.lineWidth = 4;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  canvas.dataset.signed = 'false';
}

function signaturePoint(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (canvas.width / rect.width),
    y: (event.clientY - rect.top) * (canvas.height / rect.height)
  };
}

function setupSignaturePads(container) {
  container.querySelectorAll('[data-signature-canvas]').forEach((canvas) => {
    resetSignatureCanvas(canvas);
    let drawing = false;
    let lastPoint = null;

    canvas.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      drawing = true;
      lastPoint = signaturePoint(canvas, event);
      canvas.setPointerCapture?.(event.pointerId);
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!drawing || !lastPoint) return;
      event.preventDefault();
      const point = signaturePoint(canvas, event);
      const context = canvas.getContext('2d');
      context.beginPath();
      context.moveTo(lastPoint.x, lastPoint.y);
      context.lineTo(point.x, point.y);
      context.stroke();
      canvas.dataset.signed = 'true';
      lastPoint = point;
    });

    ['pointerup', 'pointercancel', 'pointerleave'].forEach((eventName) => {
      canvas.addEventListener(eventName, () => {
        drawing = false;
        lastPoint = null;
      });
    });
  });

  container.querySelectorAll('[data-signature-clear]').forEach((button) => {
    button.addEventListener('click', () => {
      const canvas = Array.from(container.querySelectorAll('[data-signature-canvas]'))
        .find((item) => item.dataset.signatureCanvas === button.dataset.signatureClear);
      if (canvas) resetSignatureCanvas(canvas);
    });
  });
}

function renderField(field) {
  const required = field.required ? ' required' : '';
  const label = `${field.label}${field.required ? ' *' : ''}`;

  if (field.type === 'textarea') {
    return `
      <label>
        ${escapeHtml(label)}
        <textarea id="${fieldInputId(field)}" rows="4"${required}></textarea>
      </label>
    `;
  }

  if (field.type === 'select') {
    return `
      <label>
        ${escapeHtml(label)}
        <select id="${fieldInputId(field)}"${required}>
          <option value="">Select</option>
          ${(field.options || []).map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('')}
        </select>
      </label>
    `;
  }

  if (field.type === 'checkbox') {
    return `
      <label class="checkbox-field">
        <input id="${fieldInputId(field)}" type="checkbox" />
        <span>${escapeHtml(label)}</span>
      </label>
    `;
  }

  if (field.type === 'signature') {
    return `
      <div class="signature-field" data-signature-field="${escapeHtml(field.id)}" data-signature-required="${field.required ? 'true' : 'false'}">
        <div class="signature-toolbar">
          <strong>${escapeHtml(label)}</strong>
          <button type="button" class="ghost" data-signature-clear="${escapeHtml(field.id)}">Clear</button>
        </div>
        <canvas id="${fieldInputId(field)}" class="signature-canvas" width="720" height="220" data-signature-canvas="${escapeHtml(field.id)}" aria-label="${escapeHtml(label)}"></canvas>
        <p class="muted">Write your signature inside the box.</p>
      </div>
    `;
  }

  const inputType = field.type === 'number' || field.type === 'date' ? field.type : 'text';
  const step = field.type === 'number' ? ' step="0.01"' : '';
  return `
    <label>
      ${escapeHtml(label)}
      <input id="${fieldInputId(field)}" type="${inputType}"${step}${required} />
    </label>
  `;
}

export function renderWorkFormFields(container, form) {
  if (!form) {
    container.innerHTML = '<div class="empty-state">Select a form to show its fields.</div>';
    return;
  }

  container.innerHTML = (form.fields || []).map(renderField).join('');
  setupSignaturePads(container);
}

function collectSignatureAnswer(field) {
  const canvas = document.getElementById(fieldInputId(field));
  if (!canvas || canvas.dataset.signed !== 'true') {
    if (field.required) {
      throw new Error(`${field.label} is required.`);
    }
    return '';
  }

  return canvas.toDataURL('image/png');
}

export function collectWorkFormAnswers(form) {
  const answers = {};

  for (const field of form.fields || []) {
    const input = document.getElementById(fieldInputId(field));
    if (field.type === 'signature') {
      answers[field.id] = collectSignatureAnswer(field);
      continue;
    }
    if (!input) continue;
    answers[field.id] = field.type === 'checkbox' ? input.checked : input.value;
  }

  return answers;
}

export function parseWorkFormFieldsInput(value) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [typeRaw, labelRaw, requiredRaw = '', optionsRaw = ''] = line.split('|').map((part) => part.trim());
      const label = labelRaw || `Field ${index + 1}`;
      const id = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || `field_${index + 1}`;

      return {
        id,
        label,
        type: (typeRaw || 'text').toLowerCase(),
        required: requiredRaw.toLowerCase() === 'required',
        options: optionsRaw
          ? optionsRaw.split(',').map((option) => option.trim()).filter(Boolean)
          : []
      };
    });
}

export function serialiseWorkFormFields(fields = []) {
  return fields.map((field) => {
    const parts = [field.type || 'text', field.label || field.id || 'Field'];
    const options = field.options || [];

    if (field.required || options.length) {
      parts.push(field.required ? 'required' : '');
    }
    if (options.length) {
      parts.push(options.join(','));
    }

    return parts.join('|');
  }).join('\n');
}
