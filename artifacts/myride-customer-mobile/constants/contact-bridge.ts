export function normalizeContactUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(tel:|whatsapp:\/\/send\?phone=|https:\/\/wa\.me\/)([^?#]+)$/i.exec(value.trim());
  if (!match) return null;
  let phone: string;
  try {
    phone = decodeURIComponent(match[2]).trim().replace(/[\s().-]/g, '');
  } catch {
    return null;
  }
  const number = /^(?:\+?92|0092|0)?(3\d{9})$/.exec(phone);
  if (!number) return null;
  const digits = `92${number[1]}`;
  return match[1].toLowerCase() === 'tel:' ? `tel:+${digits}` : `whatsapp://send?phone=${digits}`;
}

export const contactBridgeScript = `
  (function() {
    if (window.__myRideContactBridgeInstalled) return;
    window.__myRideContactBridgeInstalled = true;
    document.addEventListener('click', function(event) {
      var target = event.target;
      if (target && target.nodeType === 3) target = target.parentElement;
      var anchor = target && target.closest ? target.closest('a') : null;
      var url = anchor && anchor.href ? anchor.href : '';
      // The Customer page's handler fetches fresh ride contact before posting.
      // Let it own tagged actions; otherwise capture legacy/direct anchors.
      if (anchor && anchor.dataset && anchor.dataset.contactAction
          && typeof window.openCustomerRideContact === 'function') return;
      if (/^(tel:|whatsapp:\\/\\/send\\?phone=|https:\\/\\/wa\\.me\\/)/i.test(url)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'contact', url: url }));
      }
    }, true);
  })();
  true;
`;