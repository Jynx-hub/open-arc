// Clicking the toolbar button opens a tab through chrome.tabs.create, so the test sees the whole round trip.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'about:blank#opened-by-extension' });
});
