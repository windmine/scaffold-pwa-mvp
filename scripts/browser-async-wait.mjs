function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitForAsyncCondition(page, predicate, value, { timeout = 30000, polling = 50 } = {}) {
  const deadline = Date.now() + timeout;
  const timeoutError = () => new Error('Timeout waiting for an asynchronous browser condition');
  while (Date.now() < deadline) {
    let timer;
    try {
      // This Playwright build treats a Promise as truthy before its boolean
      // resolves. Evaluate explicitly and never accept a resolved false handle.
      const matched = await Promise.race([
        page.evaluate(predicate, value),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(timeoutError()), Math.max(1, deadline - Date.now()));
        })
      ]);
      if (matched === true) return;
    } finally { clearTimeout(timer); }
    await delay(Math.min(polling, Math.max(0, deadline - Date.now())));
  }
  throw timeoutError();
}
