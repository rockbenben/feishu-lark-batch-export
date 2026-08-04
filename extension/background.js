// 两件事，都是 content script 自己做不到的。

// 1. 工具栏图标点击 → 转成一条消息，让面板开合。
chrome.action.onClicked.addListener((tab) => {
  if (tab.id != null) chrome.tabs.sendMessage(tab.id, { type: 'fbe-toggle' }).catch(() => {
    // 页面上没有 content script（比如还停在非飞书页面），忽略即可
  });
});

// 2. 手动选语言时把对应的 messages.json 读出来给 content script。
// chrome.i18n 只认浏览器语言、没有运行时覆盖的 API，所以手动切换只能自己读文件；
// 而 MV3 里 content script 直接 fetch 自己的 _locales 要声明 web_accessible_resources，
// 由 service worker 代读就省掉那份声明（也就不会把语言文件暴露给页面）。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'fbe-locale') return;
  fetch(chrome.runtime.getURL(`_locales/${msg.lang}/messages.json`))
    .then((r) => (r.ok ? r.json() : null))
    .then(sendResponse)
    .catch(() => sendResponse(null));
  return true; // 异步回复
});
