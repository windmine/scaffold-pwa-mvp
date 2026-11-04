// Public installation only. Only the two shared presentation preferences may be
// accessed; never import auth, read stored Reports, or replay queues here.
const translations = {
  en: {
    title: 'Install ReportFlow', eyebrow: 'ON YOUR PHONE', heading: 'Install ReportFlow',
    intro: 'Add it to your home screen, or use it in your browser.',
    genericHint: 'Tap Install ReportFlow for the prompt or steps for your device.',
    iosHint: 'On iPhone or iPad, follow the Safari steps below.',
    androidHint: 'On Android, use Chrome and follow the steps below.',
    readyHint: 'Your browser can install ReportFlow. Tap the button to continue.',
    openBrowser: 'Continue in browser', install: 'Install ReportFlow', installing: 'Waiting for browser...',
    confirmation: 'Your browser will ask you to confirm. If no prompt is available, this button shows the steps.',
    iosManual: 'In Safari, tap Share, then Add to Home Screen. Keep Open as Web App on if shown, then tap Add.',
    androidManual: 'In Chrome, open More > Install and create shortcut > Install. Some versions show Install app or Add to Home screen. Confirm the prompt.',
    firefoxManual: 'In Firefox, open the three-dot menu, tap Install, then confirm Add to Home Screen.',
    desktopManual: 'In Chrome or Edge, use the address-bar Install icon or the browser menu. If installation is unavailable, continue in your browser.',
    desktopOne: 'In Chrome or Edge, select the Install icon in the address bar if available.',
    desktopHeading: 'Computer',
    desktopTwo: 'In Chrome, you can also use More > Cast, save, and share > Install page as app, then confirm.',
    firefoxOne: 'Open this page in Firefox.', firefoxThree: 'Open the three-dot menu and tap Install, then confirm Add to Home Screen.',
    accepted: 'Installation accepted. Check your home screen, or finish any steps shown by your browser.',
    dismissed: 'Installation was cancelled. You can try the browser menu or continue without installing.',
    failed: 'The install prompt could not open. Use the steps below, or open ReportFlow in your browser.',
    installed: 'ReportFlow is installed. Open it from its app icon, or continue in your browser.',
    waitingUpdate: 'An app update is waiting. Open ReportFlow, finish your current Report, then use Update App. This page will not update an app you are using.',
    embeddedHint: 'Open this page in your phone’s browser to install ReportFlow.',
    embeddedHelp: 'This may be an in-app browser. Use its menu to open this page in Safari or Chrome. You can also copy the installation link below.',
    iosOne: 'Open this page in Safari.', iosTwo: 'Tap Share (or More, then Share).',
    iosThree: 'Choose Add to Home Screen.', iosFour: 'Keep Open as Web App on if shown, then tap Add.',
    androidOne: 'Open this page in Chrome.', androidTwo: 'Tap Install ReportFlow above.',
    androidThree: "Otherwise, open Chrome's menu and choose Install or Add to Home screen. Some versions list it under Install and create shortcut.",
    androidFour: 'Confirm installation, then open ReportFlow from its icon.',
    accessTitle: 'Have your sign-in details ready',
    accessBody: 'Use the account provided by your supervisor. Installing the app does not create an account.',
    shareHeading: 'Share with your team', scanHelp: 'Scan with your phone camera, then tap the link to open this page.',
    linkLabel: 'Installation link', copyLink: 'Copy link', copied: 'Installation link copied.',
    copyFailed: 'Select and copy the link above using your browser.',
    printPdf: 'Download A4 print sheet (PDF)', pngDownload: 'QR image (PNG)', svgDownload: 'Vector QR (SVG)',
    safetyNote: 'Already using ReportFlow? Keep the same app. Do not uninstall or clear browser data while Reports are waiting to sync.',
    installNote: 'Installation needs your confirmation. You can use ReportFlow without installing it.',
    qrAlt: 'QR code for the ReportFlow installation page'
  },
  zh: {
    confirmation: '浏览器会请您确认安装。如果没有安装提示，此按钮会显示操作步骤。',
    iosManual: '在 Safari 中点“分享”，选择“添加到主屏幕”。如有“作为网页 App 打开”，请保持开启，然后点“添加”。',
    androidManual: '在 Chrome 中打开“更多” > “安装和创建快捷方式” > “安装”。部分版本显示“安装应用”或“添加到主屏幕”。请确认安装。',
    firefoxManual: '在 Firefox 中打开三点菜单，点“安装”，然后确认添加到主屏幕。',
    desktopManual: '在 Chrome 或 Edge 中使用地址栏的安装图标或浏览器菜单。如果无法安装，可继续在浏览器中使用。',
    desktopOne: '在 Chrome 或 Edge 中，如地址栏显示安装图标，请点击它。',
    desktopHeading: '电脑',
    desktopTwo: '在 Chrome 中也可使用“更多” > “投放、保存和分享” > “将网页安装为应用”，然后确认。',
    firefoxOne: '在 Firefox 中打开此页面。', firefoxThree: '打开三点菜单，点“安装”，然后确认添加到主屏幕。',
    title: '安装 ReportFlow', eyebrow: '在手机上使用', heading: '安装 ReportFlow',
    intro: '添加到手机主屏幕，或直接在浏览器中使用。',
    genericHint: '点击安装 ReportFlow，打开安装提示或查看适合您设备的步骤。', iosHint: '使用 iPhone 或 iPad 时，请按照下方 Safari 步骤操作。',
    androidHint: '使用 Android 手机时，请在 Chrome 中按照下方步骤操作。',
    readyHint: '您的浏览器支持安装 ReportFlow。点击按钮继续。',
    openBrowser: '继续在浏览器中使用', install: '安装 ReportFlow', installing: '等待浏览器确认…',
    accepted: '已确认安装。请查看手机主屏幕，或完成浏览器提示的剩余步骤。',
    dismissed: '已取消安装。您可以使用浏览器菜单安装，也可以直接在浏览器中使用。',
    failed: '无法打开安装提示。请按照下方步骤操作，或在浏览器中打开 ReportFlow。',
    installed: 'ReportFlow 已安装。请点击应用图标打开，或继续在浏览器中使用。',
    waitingUpdate: '有一个应用更新正在等待。请打开 ReportFlow，完成当前报告后再点击“更新应用”。此页面不会强制更新正在使用的应用。',
    embeddedHint: '请在手机浏览器中打开此页面以安装 ReportFlow。',
    embeddedHelp: '您可能正在使用其他应用内的浏览器。请从其菜单中选择用 Safari 或 Chrome 打开，也可以复制下方安装链接。',
    iosOne: '在 Safari 中打开此页面。', iosTwo: '点击“分享”（或先点击“更多”，再点击“分享”）。',
    iosThree: '选择“添加到主屏幕”。', iosFour: '如有“作为网页 App 打开”选项，请保持开启，然后点击“添加”。',
    androidOne: '在 Chrome 中打开此页面。', androidTwo: '点击上方的安装 ReportFlow 按钮。',
    androidThree: '否则，请打开 Chrome 菜单，选择“安装”或“添加到主屏幕”。某些版本会将此选项放在“安装和创建快捷方式”中。',
    androidFour: '确认安装，然后通过应用图标打开 ReportFlow。',
    accessTitle: '请准备好登录信息', accessBody: '请使用主管提供的账号登录。安装应用不会创建新账号。',
    shareHeading: '分享给您的团队', scanHelp: '使用手机相机扫描二维码，然后点击链接打开此页面。',
    linkLabel: '安装链接', copyLink: '复制链接', copied: '安装链接已复制。', copyFailed: '请选中上方链接并使用浏览器复制。',
    printPdf: '下载 A4 打印页（PDF）', pngDownload: '二维码图片（PNG）', svgDownload: '矢量二维码（SVG）',
    safetyNote: '已经在使用 ReportFlow？请保留现有应用。如果有报告等待同步，请勿卸载应用或清除浏览器数据。',
    installNote: '安装需要您确认。无需安装也可以使用 ReportFlow。', qrAlt: 'ReportFlow 安装页面二维码'
  }
};

const installButton = document.getElementById('installAppButton');
const installStatus = document.getElementById('installStatus');
const deviceHint = document.getElementById('installDeviceHint');
const copyStatus = document.getElementById('copyStatus');
const displayMode = window.matchMedia('(display-mode: standalone)');
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /android/i.test(navigator.userAgent);
const isFirefoxAndroid = isAndroid && /Firefox\//i.test(navigator.userAgent);
const isEmbedded = /FBAN|FBAV|Instagram|MicroMessenger|Line\/|\bwv\b/i.test(navigator.userAgent);
let language = /^zh/i.test(navigator.language) ? 'zh' : 'en';
try {
  const preference = localStorage.getItem('leader-language');
  if (['en', 'zh'].includes(preference)) language = preference;
} catch { /* Installation guidance also works when storage is unavailable. */ }
let deferredPrompt = null;
let prompting = false;
let accepted = false;
let installed = displayMode.matches || navigator.standalone === true;
let statusKey = installed ? 'installed' : '';
let copyStatusKey = '';

function renderState() {
  const text = translations[language];
  document.body.dataset.installState = installed ? 'installed' : prompting ? 'prompting'
    : deferredPrompt ? 'ready' : accepted ? 'accepted' : 'manual';
  // Keep one discoverable action even when the browser does not offer a prompt.
  installButton.hidden = installed;
  installButton.disabled = prompting;
  installButton.setAttribute('aria-busy', String(prompting));
  installButton.textContent = prompting ? text.installing : text.install;
  deviceHint.textContent = deferredPrompt && !installed ? text.readyHint
    : isEmbedded ? text.embeddedHint : isIos ? text.iosHint
      : isFirefoxAndroid ? text.firefoxManual : isAndroid ? text.androidHint : text.genericHint;
  installStatus.hidden = !statusKey;
  installStatus.textContent = text[statusKey] || '';
  document.getElementById('embeddedBrowserHelp').hidden = !isEmbedded || statusKey === 'embeddedHelp';
  copyStatus.hidden = !copyStatusKey;
  copyStatus.textContent = text[copyStatusKey] || '';
}

function renderLanguage() {
  document.documentElement.lang = language === 'zh' ? 'zh-Hans' : 'en';
  document.title = translations[language].title;
  document.querySelectorAll('[data-install-text]').forEach((element) => {
    element.textContent = translations[language][element.dataset.installText];
  });
  document.querySelectorAll('[data-language]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.language === language));
  });
  document.querySelector('.install-qr').alt = translations[language].qrAlt;
  if (isFirefoxAndroid && !isEmbedded) {
    document.querySelector('[data-install-text="androidOne"]').textContent = translations[language].firefoxOne;
    document.querySelector('[data-install-text="androidThree"]').textContent = translations[language].firefoxThree;
  }
  renderTheme();
  renderState();
}

function renderTheme() {
  const dark = document.documentElement.dataset.theme !== 'light';
  const button = document.getElementById('installThemeButton');
  button.textContent = language === 'zh' ? (dark ? '浅色模式' : '深色模式') : (dark ? 'Light mode' : 'Dark mode');
  button.setAttribute('aria-pressed', String(dark));
  document.querySelector('meta[name="theme-color"]').content = dark ? '#000000' : '#f4f7fb';
}
document.getElementById('installThemeButton').addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('leader-theme', theme); } catch { /* Optional preference. */ }
  renderTheme();
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  if (installed || prompting) return;
  deferredPrompt = event;
  accepted = false;
  statusKey = '';
  renderState();
});

function showInstallSteps() {
  if (!accepted) {
    statusKey = isEmbedded ? 'embeddedHelp' : isIos ? 'iosManual'
      : isFirefoxAndroid ? 'firefoxManual' : isAndroid ? 'androidManual' : 'desktopManual';
  }
  const section = isIos ? 'iosInstructions' : isAndroid ? 'androidInstructions' : 'desktopInstructions';
  document.getElementById(section).open = true;
  renderState();
  // Announce guidance and keep keyboard users at the action they requested.
  installStatus.focus();
}

installButton.addEventListener('click', async () => {
  if (prompting || installed) return;
  if (!deferredPrompt) {
    showInstallSteps();
    return;
  }
  // Browser prompts are single-use and must be invoked directly from this user gesture.
  const currentPrompt = deferredPrompt;
  deferredPrompt = null;
  prompting = true;
  statusKey = '';
  renderState();
  try {
    await currentPrompt.prompt();
    const choice = await currentPrompt.userChoice;
    if (!installed) {
      accepted = choice?.outcome === 'accepted';
      statusKey = accepted ? 'accepted' : 'dismissed';
    }
  } catch {
    if (!installed) statusKey = 'failed';
  } finally {
    prompting = false;
    renderState();
  }
});

function markInstalled() {
  installed = true;
  deferredPrompt = null;
  statusKey = 'installed';
  renderState();
}
window.addEventListener('appinstalled', markInstalled);
displayMode.addEventListener?.('change', (event) => { if (event.matches) markInstalled(); });

document.querySelectorAll('[data-language]').forEach((button) => {
  button.addEventListener('click', () => {
    language = button.dataset.language === 'zh' ? 'zh' : 'en';
    try { localStorage.setItem('leader-language', language); } catch { /* Optional preference. */ }
    renderLanguage();
  });
});
document.getElementById('languageControls').hidden = false;
document.getElementById('iosInstructions').open = isIos;
document.getElementById('androidInstructions').open = isAndroid;
document.getElementById('desktopInstructions').open = !isIos && !isAndroid;
if (isAndroid) document.querySelector('.phone-instructions').prepend(document.getElementById('androidInstructions'));
if (!isIos && !isAndroid) document.querySelector('.phone-instructions').prepend(document.getElementById('desktopInstructions'));

const copyButton = document.getElementById('copyInstallLink');
copyButton.hidden = false;
copyButton.addEventListener('click', async () => {
  if (copyButton.disabled) return;
  copyButton.disabled = true;
  const link = document.getElementById('installLink');
  try {
    await navigator.clipboard.writeText(link.value);
    copyStatusKey = 'copied';
  } catch {
    link.focus();
    link.select();
    copyStatusKey = 'copyFailed';
  } finally {
    copyButton.disabled = false;
    renderState();
  }
});

async function registerSharedWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    const showWaitingUpdate = () => {
      document.getElementById('installUpdateNotice').hidden = !registration.waiting;
    };
    showWaitingUpdate();
    registration.addEventListener('updatefound', () => {
      registration.installing?.addEventListener('statechange', showWaitingUpdate);
    });
    // Never activate a waiting worker here: the main app owns draft-safe updates.
  } catch {
    // Manual browser instructions remain usable if service workers are unavailable.
  }
}

renderLanguage();
void registerSharedWorker();
