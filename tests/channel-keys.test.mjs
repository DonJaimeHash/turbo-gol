// CH+ / CH− and PgUp / PgDn however a remote names them (src/ui/channelKeys.ts): the menus' and
// the pause-time Ajustes' tab steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { channelStep } = await import('../src/ui/channelKeys.ts');

test('channelStep: code PageUp / PageDown, key PageUp / PageDown with no code, ChannelUp / ChannelDown, Tizen XF86 keys and keyCodes', () => {
  const k = (key, code = '', keyCode = 0) => channelStep({ key, code, keyCode });
  assert.equal(k('PageUp', 'PageUp', 33), -1, 'a keyboard');
  assert.equal(k('PageDown', 'PageDown', 34), 1);
  assert.equal(k('PageUp'), -1, 'a remote: the key without a code');
  assert.equal(k('PageDown'), 1);
  assert.equal(k('ChannelUp'), -1);
  assert.equal(k('ChannelDown'), 1);
  assert.equal(k('XF86RaiseChannel', '', 427), -1, 'Tizen');
  assert.equal(k('XF86LowerChannel', '', 428), 1);
  assert.equal(k('Unidentified', '', 427), -1, 'Tizen by its keyCode alone');
  assert.equal(k('Unidentified', '', 428), 1);
  for (const [key, code, kc] of [['ArrowUp', 'ArrowUp', 38], ['!', 'Digit1', 49], ['Home', 'Home', 36], ['End', 'End', 35], ['GoBack', '', 0], ['Unidentified', '', 0]]) assert.equal(k(key, code, kc), 0, key);
});
