const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.resolve(__dirname, '../constants/contact-bridge.ts'), 'utf8');
const scope = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, scope);
const { normalizeContactUrl, contactBridgeScript } = scope.exports;
for (const phone of ['03001234567', '+923001234567', '00923001234567', '3001234567', '%2B92%20(300)%201234567']) {
  assert.equal(normalizeContactUrl(`tel:${phone}`), 'tel:+923001234567');
  assert.equal(normalizeContactUrl(`https://wa.me/${phone}`), 'whatsapp://send?phone=923001234567');
}
for (const url of ['tel:123', 'tel:+9203001234567', 'tel:abc03001234567', 'tel:03001234567;123', 'https://wa.me/923001234567?text=bad', 'https://wa.me.evil/923001234567', 'javascript:alert(1)', 'whatsapp://send?phone=123', 'tel:%ZZ']) {
  assert.equal(normalizeContactUrl(url), null);
}
let listener;
const messages = [];
let installations = 0;
const window = { ReactNativeWebView: { postMessage: data => messages.push(JSON.parse(data)) } };
const bridgeScope = { window, document: { addEventListener: (type, handler, capture) => {
  assert.equal(type, 'click'); assert.equal(capture, true);
  listener = handler; installations++;
} } };
vm.runInNewContext(contactBridgeScript, bridgeScope);
vm.runInNewContext(contactBridgeScript, bridgeScope);
assert.equal(installations, 1);
function click(url, tagged = false, textNode = false) {
  const anchor = { href: url, dataset: tagged ? { contactAction: 'call' } : {} };
  const target = { closest: () => anchor };
  const event = {
    target: textNode ? { nodeType: 3, parentElement: target } : target,
    preventDefault() { this.prevented = true; },
    stopImmediatePropagation() { this.stopped = true; },
  };
  listener(event);
  return event;
}
assert.equal(click('tel:+923001234567', false, true).stopped, true);
assert.equal(messages.length, 1);
assert.equal(click('https://wa.me/923001234567', true).prevented, true);
assert.equal(messages.length, 2); // Tagged legacy anchor without page handler.
window.openCustomerRideContact = () => {};
assert.equal(click('tel:+923001234567', true).prevented, undefined);
assert.equal(messages.length, 2); // Modern page handler owns fresh fetch/post.
assert.equal(click('https://example.com/').prevented, undefined);
async function testNativeHandlers() {
  const homeSource = fs.readFileSync(path.resolve(__dirname, '../app/index.tsx'), 'utf8');
  const handlerSource = homeSource.slice(homeSource.indexOf('  const openExternalUrl ='), homeSource.indexOf('  useEffect(() =>'));
  const opened = [];
  const alerts = [];
  const handlers = {
    normalizeContactUrl, URL, openingExternal: { current: false },
    allowedOrigin: 'https://customer.example',
    useCallback: fn => fn,
    Alert: { alert: (...args) => alerts.push(args) },
    Linking: { openURL: async url => {
      opened.push(url);
      if (url.startsWith('whatsapp:')) throw new Error('WhatsApp not installed');
    } },
  };
  vm.runInNewContext(ts.transpileModule(handlerSource + `
    globalThis.openExternal = openExternalUrl;
    globalThis.message = handleWebViewMessage;
    globalThis.navigate = allowNavigation;
  `, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, handlers);
  await handlers.openExternal('https://wa.me/923001234567');
  assert.deepEqual(opened, ['whatsapp://send?phone=923001234567', 'https://wa.me/923001234567']);
  await handlers.openExternal('tel:123');
  assert.equal(opened.length, 2);
  assert.equal(alerts.length, 1);
  handlers.message({ nativeEvent: { data: '{"type":"unrelated","url":"tel:+923001234567"}' } });
  handlers.message({ nativeEvent: { data: 'not-json' } });
  assert.equal(opened.length, 2);
  handlers.message({ nativeEvent: { data: '{"type":"contact","url":"tel:+923001234567"}' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened[2], 'tel:+923001234567');
  assert.equal(handlers.navigate({ url: 'https://customer.example/customer' }), true);
  assert.equal(handlers.navigate({ url: 'javascript:alert(1)' }), false);
  assert.equal(handlers.navigate({ url: 'intent://bad' }), false);
  assert.equal(handlers.navigate({ url: 'tel:123' }), false);
  assert.equal(opened.length, 3);
  assert.equal(handlers.navigate({ url: 'tel:03001234567' }), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened[3], 'tel:+923001234567');
}
testNativeHandlers().then(() => {
  console.log('Customer URL validation, capture ownership, idempotent injection, native message/navigation, and Linking tests passed.');
}).catch(error => { console.error(error); process.exitCode = 1; });