import { waitForAsyncCondition } from './browser-async-wait.mjs';

// Custom selection actions return the selected values just like selectOption.
// Node-side polling also works while a fixture pauses the browser clock.
export async function selectWorkFormWhenReady(page, option, {
  select = (value) => page.locator('#workFormSelect').selectOption(value),
  timeout = 30000
} = {}) {
  // Selection can first flush the previous draft. Wait for its old surface to
  // be replaced, then for native draft restoration to release the new editor.
  const previous = await page.locator('#workFormFields').evaluateHandle((fields) => fields.firstChild);
  try {
    const [selected] = await select(option);
    await waitForAsyncCondition(page, ({ previous, selected }) => {
      const form = document.querySelector('#workFormSubmissionForm');
      const fields = document.querySelector('#workFormFields');
      return document.querySelector('#workFormSelect')?.value === selected
        && fields && fields.firstChild !== previous && form && !form.inert;
    }, { previous, selected }, { timeout });
  } finally {
    await previous.dispose();
  }
}
