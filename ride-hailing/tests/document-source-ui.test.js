'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const documents = {
  customer: [
    ['r-cnic-front', 'r-cnic-front-preview'],
    ['r-cnic-back', 'r-cnic-back-preview'],
    ['r-student-id-image', 'r-student-id-image-preview']
  ],
  driver: [
    ['r-profile-photo', 'prev-profile', 'user'],
    ['r-license-photo', 'prev-license'],
    ['r-cnic-front', 'prev-cnic-f'],
    ['r-cnic-back', 'prev-cnic-b'],
    ['r-vehicle-reg', 'prev-vehicle-reg'],
    ['cv-vehicle-reg', 'cv-vehicle-preview']
  ]
};

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
}

function functionSource(html, name) {
  const start = html.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `${name} exists`);
  const rest = html.slice(start);
  const end = rest.search(/\n(?:\/\*\*|\/\/ ──|(?:async )?function )/);
  assert.notEqual(end, -1, `${name} has a known boundary`);
  return rest.slice(0, end);
}

for (const [role, fields] of Object.entries(documents)) {
  const html = fs.readFileSync(`${__dirname}/../public/${role}.html`, 'utf8');
  const inputTags = [...html.matchAll(/<input\b[^>]*>/g)].map(match => attributes(match[0]));
  const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map(match => attributes(match[0]))
    .filter(button => button.onclick?.startsWith('openDocumentSource('));

  function harness(pickerMode = 'available', transferMode = 'available') {
    const elements = new Map();
    for (const attrs of inputTags) {
      if (!attrs.id) continue;
      elements.set(attrs.id, {
        ...attrs, value: 'previous-selection', files: [], style: {}, clicks: 0, pickerCalls: 0,
        setAttribute(name, value) { this[name] = value; },
        removeAttribute(name) { delete this[name]; },
        click() { this.clicks++; },
        ...(pickerMode === 'missing' ? {} : {
          showPicker() {
            this.pickerCalls++;
            if (pickerMode === 'throws') throw new Error('Picker unavailable');
          }
        })
      });
    }
    for (const [, preview] of fields) {
      elements.set(preview, { style: {} });
      elements.set(`${preview}-status`, {});
      elements.set(`${preview.replace(/-preview$/, '')}-label`, {});
    }
    elements.set('auth-error', {});
    const context = vm.createContext({
      document: { getElementById: id => elements.get(id) },
      URL: { createObjectURL: file => `blob:${file.name}`, revokeObjectURL() {} },
      compressImage: async file => `compressed:${file.name}`,
      ...(transferMode === 'missing' ? {} : {
        DataTransfer: class {
          constructor() {
            if (transferMode === 'throws') throw new Error('FileList assignment unavailable');
            this.files = [];
            this.items = { add: file => this.files.push(file) };
          }
        }
      })
    });
    vm.runInContext('const _selectedDocumentFiles = {}; const _photos = {};', context);
    for (const name of ['openDocumentSource', 'rememberDocumentFile',
      role === 'customer' ? 'handleDocumentSelection' : 'previewPhoto']) {
      vm.runInContext(functionSource(html, name), context);
    }
    return { context, elements };
  }

  test(`${role}: every registration/replacement source button and input has correct wiring and capture`, () => {
    assert.equal(buttons.length, fields.length * 2);
    assert.equal(inputTags.filter(input => /-(camera|gallery)$/.test(input.id || '')).length, fields.length * 2);
    for (const [id, preview, facing = 'environment'] of fields) {
      const canonical = inputTags.filter(input => input.id === id);
      assert.equal(canonical.length, 1);
      assert.equal(canonical[0].type, 'file');
      assert.equal(canonical[0].capture, undefined);
      for (const source of ['camera', 'gallery']) {
        const matching = inputTags.filter(input => input.id === `${id}-${source}`);
        assert.equal(matching.length, 1);
        const input = matching[0];
        assert.equal(input.type, 'file');
        assert.match(input.accept, /image\//);
        assert.equal(input.capture, source === 'camera' ? facing : undefined);
        const expectedSelection = role === 'customer'
          ? `handleDocumentSelection(this,'${id}','${preview}','${id}-label')`
          : `previewPhoto(this,'${preview}','${id}')`;
        assert.equal(input.onchange, expectedSelection);
        const expectedClick = `openDocumentSource('${id}','${source}'${source === 'camera' && facing === 'user' ? ",'user'" : ''})`;
        const matchingButtons = buttons.filter(button => button.onclick === expectedClick);
        assert.equal(matchingButtons.length, 1);
        assert.equal(matchingButtons[0].type, 'button');
      }
    }
  });

  for (const mode of ['available', 'missing', 'throws']) {
    test(`${role}: actual buttons route to separate inputs with ${mode} showPicker`, () => {
      const { context, elements } = harness(mode);
      for (const [id, , facing = 'environment'] of fields) {
        for (const source of ['camera', 'gallery', 'camera']) {
          const button = buttons.find(button => button.onclick.startsWith(`openDocumentSource('${id}','${source}'`));
          vm.runInContext(button.onclick, context);
          const selected = elements.get(`${id}-${source}`);
          assert.equal(selected.value, '', 'same file can be selected again');
          assert.equal(selected.capture, source === 'camera' ? facing : undefined);
          assert.equal(elements.get(`${id}-gallery`).capture, undefined, 'gallery never inherits capture');
          assert.equal(elements.get(`${id}-camera`).capture, facing, 'camera retains its facing');
          assert.equal(elements.get(id).value, 'previous-selection', 'canonical input is not opened');
        }
        for (const source of ['camera', 'gallery']) {
          const input = elements.get(`${id}-${source}`);
          const count = source === 'camera' ? 2 : 1;
          assert.equal(input.pickerCalls, mode === 'missing' ? 0 : count);
          assert.equal(input.clicks, mode === 'available' ? 0 : count, 'fallback occurs exactly once');
        }
      }
      assert.doesNotThrow(() => context.openDocumentSource('missing-document', 'camera'));
    });
  }

  for (const transferMode of ['available', 'missing', 'throws']) {
    test(`${role}: all onchange handlers retain the correct document across source replacement (${transferMode} DataTransfer)`, async () => {
      const { context, elements } = harness('available', transferMode);
      for (const [id, preview] of fields) {
        for (const [selection, source] of ['camera', 'gallery', 'camera'].entries()) {
          const input = elements.get(`${id}-${source}`);
          const file = { name: `${id}-${source}-${selection}.jpg`, type: 'image/jpeg' };
          input.files = [file];
          context.selectedInput = input;
          await vm.runInContext(`(function() { return ${input.onchange}; }).call(selectedInput)`, context);
          assert.equal(vm.runInContext(`_selectedDocumentFiles['${id}']`, context), file);
          if (transferMode === 'available') assert.equal(elements.get(id).files[0], file);
          assert.equal(elements.get(preview).src, `${role === 'customer' ? 'blob' : 'compressed'}:${file.name}`);
          input.files = [];
          await vm.runInContext(`(function() { return ${input.onchange}; }).call(selectedInput)`, context);
          assert.equal(vm.runInContext(`_selectedDocumentFiles['${id}']`, context), file, 'cancelling does not discard a selected document');
        }
      }
    });
  }
}