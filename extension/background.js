// content script 自己做不到的浏览器级操作。

// 1. 工具栏图标点击 → 转成一条消息，让面板开合。
chrome.action.onClicked.addListener((tab) => {
  if (tab.id != null) chrome.tabs.sendMessage(tab.id, { type: 'fbe-toggle' }).catch(() => {
    // 页面上没有 content script（比如还停在非飞书页面），忽略即可
  });
});

const fileNameRequests = new Map();

function fileNameRequestKey(msg, sender) {
  const tabId = sender && sender.tab && sender.tab.id;
  const requestId = String((msg && msg.requestId) || '');
  return Number.isInteger(tabId) && /^\d+$/.test(requestId) ? `${tabId}:${requestId}` : '';
}

// 2. 手动选语言时把对应的 messages.json 读出来给 content script。
// chrome.i18n 只认浏览器语言、没有运行时覆盖的 API，所以手动切换只能自己读文件；
// 而 MV3 里 content script 直接 fetch 自己的 _locales 要声明 web_accessible_resources，
// 由 service worker 代读就省掉那份声明（也就不会把语言文件暴露给页面）。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'fbe-locale') {
    fetch(chrome.runtime.getURL(`_locales/${msg.lang}/messages.json`))
      .then((r) => (r.ok ? r.json() : null))
      .then(sendResponse)
      .catch(() => sendResponse(null));
    return true; // 异步回复
  }

  // 3. file 直链只给 content script 一个 token。后台从消息发送者确定租户域名，
  // 再用已有 host_permissions 发 HEAD；不接受任意 URL，避免把扩展权限变成请求代理。
  if (msg.type === 'fbe-file-name-cancel') {
    const controller = fileNameRequests.get(fileNameRequestKey(msg, sender));
    if (controller) controller.abort();
    sendResponse({ cancelled: !!controller });
    return;
  }
  if (msg.type !== 'fbe-file-name') return;
  const token = String(msg.token || '');
  const requestKey = fileNameRequestKey(msg, sender);
  let page;
  try { page = new URL(sender && (sender.url || (sender.tab && sender.tab.url))); }
  catch (error) { page = null; }
  const allowedHost = page && (/\.(?:feishu\.cn|larksuite\.com)$/i.test(page.hostname));
  if (!page || page.protocol !== 'https:' || !allowedHost
    || !/^[A-Za-z0-9]+$/.test(token) || !requestKey) {
    sendResponse({ error: 'invalid file request' });
    return;
  }

  const controller = new AbortController();
  fileNameRequests.set(requestKey, controller);
  const timer = setTimeout(() => controller.abort(), 30000);
  const url = `${page.origin}/space/api/box/stream/download/all/${token}`;
  fetch(url, { method: 'HEAD', credentials: 'include', signal: controller.signal })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const header = response.headers.get('content-disposition');
      if (!header) throw new Error('Content-Disposition missing');
      return { contentDisposition: header };
    })
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message || String(error) }))
    .finally(() => {
      clearTimeout(timer);
      fileNameRequests.delete(requestKey);
    });
  return true; // 异步回复
});
