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
