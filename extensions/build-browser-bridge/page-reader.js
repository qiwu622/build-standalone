// Loaded as a classic isolated-world content script and imported by the worker.
// Keep this function self-contained: the executor serializes the same reader.
globalThis.buildStandaloneReadIdentity = function readBuildIdentity() {
  const pattern = /Google\s*(?:Account\b|账号|帐号|账户|帳戶|帳號)/i;
  const attributes = node => ['aria-label', 'title', 'data-tooltip'].map(name => node.getAttribute(name) || '').join(' ');
  const visible = node => typeof node.checkVisibility !== 'function' || node.checkVisibility();
  const controls = [...document.querySelectorAll('button[aria-label],a[aria-label],[role="button"][aria-label],button[title],a[title],[role="button"][title],[data-tooltip]')]
    .filter(node => visible(node) && pattern.test(attributes(node)));
  // Only use explicitly labelled Google account controls. Never infer identity
  // from arbitrary emails in a conversation, file preview, or account list.
  // Google may render aria-label="Google Account: ()" while placing the
  // active email in a visible child span inside this exact account control.
  const emails = [...new Set(controls.flatMap(node => (attributes(node) + ' ' + (node.innerText || '')).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map(value => value.toLowerCase()))];
  const planPattern = /\b(?:PRO|ULTRA)\b/i;
  const hasPlan = controls.some(node => planPattern.test(attributes(node) + ' ' + (node.innerText || '') + ' ' + (node.parentElement?.innerText || '')))
    || [...document.querySelectorAll('header span,[role="banner"] span')].some(node => visible(node) && /^(?:Google AI\s+)?(?:PRO|ULTRA)$/i.test((node.innerText || '').trim()));
  const field = placeholder => !!document.querySelector(`:is(textarea,[contenteditable="true"],[contenteditable="plaintext-only"])[placeholder="${placeholder}"]`);
  const introNoticeVisible = [...document.querySelectorAll('img[alt="An updated flow for using Gemini in your apps"]')].some(visible);
  return {
    url: location.href, path: location.pathname,
    authUser: /^\/u\/(\d+)\//.exec(location.pathname)?.[1] || new URL(location.href).searchParams.get('authuser') || '0',
    email: emails.length === 1 ? emails[0] : null,
    accountControlFound: controls.length > 0, accountAmbiguous: emails.length > 1, hasPlan, introNoticeVisible,
    ready: field('Make changes, add new features, ask for anything'),
    initializing: field('Describe an app and let Gemini do the rest')
  };
};
