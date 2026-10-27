import { setTranslatableTextParts } from './i18n.js';
import { setButtonBusy } from './ui-feedback.js';

// Refresh reads current data. It deliberately has no submission, queue or reload dependency.
export function createSafeRefresh({ button, status, captureScope, scopeIsCurrent, tasks,
  online = () => navigator.onLine, timeoutMs = 30000 }) {
  let active = null;
  function feedback(parts, tone = 'info') {
    status.hidden = false;
    status.dataset.tone = tone;
    setTranslatableTextParts(status, parts);
  }
  async function refresh() {
    if (active) return;
    const scope = captureScope();
    if (!scope) return;
    if (!online()) {
      feedback(['You are offline. Reconnect to refresh. Your work is kept.'], 'warning');
      return;
    }
    const run = { scope };
    active = run;
    const current = () => active === run && scopeIsCurrent(scope);
    setButtonBusy(button, true, 'Refreshing...');
    feedback(['Refreshing data and checking for app updates...']);
    let timer;
    try {
      const results = await Promise.race([
        Promise.allSettled(tasks(scope, current).map(async ({ run: task }) => await task() !== false)),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); })
      ]);
      if (!current()) return;
      const complete = results?.every((result) => result.status === 'fulfilled' && result.value);
      feedback([complete ? 'Data refreshed. App update check complete.'
        : online() ? 'Some data or the app update check could not be refreshed. Try again.'
          : 'Connection lost. Some data could not be refreshed. Reconnect and try again.',
      'Your open form and queued Reports are kept. Refresh does not submit Reports.'], complete ? 'success' : 'warning');
    } finally {
      clearTimeout(timer);
      if (active === run) {
        if (!scopeIsCurrent(scope)) status.hidden = true;
        active = null;
        setButtonBusy(button, false);
      }
    }
  }
  function cancel() {
    active = null;
    status.hidden = true;
    setButtonBusy(button, false);
  }
  button.addEventListener('click', () => { void refresh(); });
  return { cancel };
}
