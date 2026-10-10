// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { ElementRegistry, normalizeLabel, readLabel, selectorHint } from '../../src/content/registry';
import { formPage } from '../fixtures/pages';
import { mount } from '../helpers/fixtureReader';

describe('normalizeLabel', () => {
  it('collapses whitespace and truncates to 60 chars', () => {
    expect(normalizeLabel('  Get \n\t started  ')).toBe('Get started');
    const long = normalizeLabel('x'.repeat(200))!;
    expect(long.length).toBe(60);
    expect(long.endsWith('…')).toBe(true);
    expect(normalizeLabel('   ')).toBeUndefined();
  });
});

describe('ElementRegistry', () => {
  beforeEach(() => mount('<button id="a">One</button><button id="b">Two</button>'));

  it('maps the same element to the same ref and different elements to different refs', () => {
    const reg = new ElementRegistry();
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    const r1 = reg.register(a, { kind: 'control' });
    const r2 = reg.register(a, { kind: 'control' });
    const r3 = reg.register(b, { kind: 'control' });
    expect(r1.id).toBe(r2.id);
    expect(r3.id).not.toBe(r1.id);
    expect(reg.get(a)?.id).toBe(r1.id);
    expect(reg.resolve(r3.id)).toBe(b);
  });

  it('resolve returns null for detached elements', () => {
    const reg = new ElementRegistry();
    const a = document.getElementById('a')!;
    const ref = reg.register(a, { kind: 'control' });
    a.remove();
    expect(reg.resolve(ref.id)).toBeNull();
  });

  it('reset forgets elements and never reuses ids', () => {
    const reg = new ElementRegistry();
    const a = document.getElementById('a')!;
    const before = reg.register(a, { kind: 'control' });
    reg.reset();
    expect(reg.get(a)).toBeUndefined();
    expect(reg.resolve(before.id)).toBeNull();
    expect(reg.register(a, { kind: 'control' }).id).toBeGreaterThan(before.id);
  });

  it('label modes', () => {
    mount('<nav aria-label="Main menu"><a href="/">Home page link</a></nav><p id="p">Private paragraph text</p>');
    const reg = new ElementRegistry();
    expect(reg.register(document.querySelector('nav')!, { kind: 'landmark', labelMode: 'aria-only' }).label).toBe('Main menu');
    expect(reg.register(document.getElementById('p')!, { kind: 'text', labelMode: 'none' }).label).toBeUndefined();
  });
});

describe('labels never contain form values', () => {
  beforeEach(() => mount(formPage));

  it('uses labels, never values', () => {
    const reg = new ElementRegistry();
    const labelOf = (sel: string) => reg.register(document.querySelector(sel)!, { kind: 'control' }).label;
    expect(labelOf('#email')).toBe('Email address');
    expect(labelOf('#pw')).toBe('Password');
    expect(labelOf('#notes')).toBe('Order notes');
    expect(labelOf('#terms')).toBe('Accept terms');
    expect(labelOf('input[type=submit]')).toBe('Submit');

    const all = JSON.stringify([...document.querySelectorAll('input, textarea, select, form')].map((el) => readLabel(el)));
    expect(all).not.toContain('private@example.com');
    expect(all).not.toContain('hunter2');
    expect(all).not.toContain('secret');
    expect(all).not.toContain('$99');
  });

  it('password fields without a label get a generic label', () => {
    mount('<input type="password" value="hunter2">');
    expect(readLabel(document.querySelector('input')!)).toBe('Password field');
  });

  it('textContent is not used for subtrees containing form fields', () => {
    mount('<div id="d" role="button">Edit <textarea>secret draft</textarea></div>');
    expect(readLabel(document.getElementById('d')!)).toBeUndefined();
  });
});

describe('selectorHint', () => {
  it('is short and skips generated-looking tokens', () => {
    mount('<a id="cta" class="btn primary css-1x2y3z4 x123456" href="/">Go</a>');
    expect(selectorHint(document.querySelector('a')!)).toBe('a#cta.btn.primary');
  });
});

describe('label text (Phase 9 real-site finding)', () => {
  it('text from separate elements or line breaks is not glued together', () => {
    const host = document.createElement('div');
    host.innerHTML = '<a id="a">Releases<span>244</span></a><h2 id="b">Intake<br>and integrations</h2><button id="c">Sav<b>e</b></button>';
    document.body.append(host);
    expect(readLabel(host.querySelector('#a')!)).toBe('Releases 244');
    expect(readLabel(host.querySelector('#b')!)).toBe('Intake and integrations');
    host.remove();
  });

});

describe('privacy: labels never carry text typed into editable regions', () => {
  it('aria-labelledby and <label> skip contenteditable / form-field text', () => {
    document.body.innerHTML = `
      <div id="ed" contenteditable="true">secret typed text</div>
      <button id="b1" aria-labelledby="ed">x</button>
      <div id="wrap"><span>Notes</span><div contenteditable="true">secret draft</div></div>
      <button id="b2" aria-labelledby="wrap">x</button>
      <label>Bio <div contenteditable="true">secret bio</div><input id="i1" /></label>`;
    for (const id of ['b1', 'b2', 'i1']) {
      expect(readLabel(document.getElementById(id)!) ?? '').not.toContain('secret');
    }
  });
});

describe('privacy: wrapping labels keep their own text', () => {
  it('names a select / editable-adjacent field from the label text only', () => {
    document.body.innerHTML = `
      <label>Country <select id="s"><option>Turkey</option></select></label>
      <div id="lb">Notes <div contenteditable="true">secret</div></div><button id="b" aria-labelledby="lb">x</button>`;
    expect(readLabel(document.getElementById('s')!)).toBe('Country');
    expect(readLabel(document.getElementById('b')!)).toBe('Notes');
  });
});

describe('privacy: text inside an editing host never becomes a label', () => {
  it('aria-labelledby into editor content, and controls in non-editable islands of an editor', () => {
    document.body.innerHTML = `
      <div contenteditable="true"><p id="p1">secret one</p>
        <span contenteditable="false"><a id="chip" href="/u">@secret three</a></span></div>
      <button id="b1" aria-labelledby="p1">x</button>
      <span id="who">Reply</span><div contenteditable="plaintext-only"><span id="draft">secret two</span></div>
      <button id="b2" aria-labelledby="who draft">x</button>`;
    for (const id of ['b1', 'b2', 'chip']) {
      expect(readLabel(document.getElementById(id)!) ?? '').not.toContain('secret');
    }
    expect(readLabel(document.getElementById('b2')!)).toBe('Reply');
  });

  it('a designMode document is editable everywhere', () => {
    document.body.innerHTML = `<p id="p">secret</p><button id="b" aria-labelledby="p">x</button>`;
    document.designMode = 'on';
    try {
      expect(readLabel(document.getElementById('b')!) ?? '').not.toContain('secret');
    } finally {
      document.designMode = 'off';
    }
  });

  it('contenteditable="false" outside any editor keeps its own text', () => {
    document.body.innerHTML = `<div contenteditable="false"><button id="b">Save</button></div>`;
    expect(readLabel(document.getElementById('b')!)).toBe('Save');
  });
});
