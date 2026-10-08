// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { discover, semanticBasis } from '../../src/content/analyzer/discover';
import { fixtureReader, mount } from '../helpers/fixtureReader';
import { formPage, unsemantic } from '../fixtures/pages';

const run = (html: string, cursorHeuristic = true) => {
  mount(html);
  return discover({ reader: fixtureReader(), cursorHeuristic });
};
const tags = (list: { el: Element }[]) => list.map((f) => f.el.tagName.toLowerCase());

describe('discovery', () => {
  it('finds semantic interactive elements', () => {
    const d = run(
      '<a href="/x">link</a><a>no href</a><button>b</button><details><summary>s</summary></details>' +
        '<input type="text"><input type="hidden"><select><option>o</option></select><textarea></textarea>',
    );
    expect(tags(d.interactive)).toEqual(['a', 'button', 'summary', 'input', 'select', 'textarea']);
    expect(d.interactive.every((f) => f.interactive === 'native')).toBe(true);
  });

  it('finds ARIA, tabindex, contenteditable and onclick controls', () => {
    const d = run(
      '<div role="button">r</div><div role="bogus tab">t</div><span tabindex="0">t</span><span tabindex="-1">no</span>' +
        '<div contenteditable="true">e</div><div contenteditable="false">no</div><div onclick="x()">c</div>',
    );
    expect(d.interactive.map((f) => f.interactive)).toEqual(['aria-role', 'aria-role', 'tabindex', 'contenteditable', 'onclick']);
    expect(d.interactive[1]!.role).toBe('tab'); // malformed role list: first recognized token
  });

  it('marks cursor:pointer as a heuristic and does not re-check its descendants', () => {
    const d = run('<div style="cursor: pointer"><span style="cursor: pointer">inner</span></div>');
    expect(d.interactive).toHaveLength(1);
    expect(d.interactive[0]!.interactive).toBe('cursor');
    expect(run('<div style="cursor: pointer">x</div>', false).interactive).toHaveLength(0);
  });

  it('classifies context elements', () => {
    const d = run('<header></header><nav></nav><main><h1>t</h1><div role="heading" aria-level="3">h</div><p>p</p><img alt=""></main><section></section>');
    expect(d.context.map((f) => [f.kind, f.landmark ?? f.headingLevel])).toEqual([
      ['landmark', 'header'],
      ['landmark', 'nav'],
      ['landmark', 'main'],
      ['heading', 1],
      ['heading', 3],
      ['text', null],
      ['media', null],
      ['landmark', 'section'],
    ]);
  });

  it('still discovers hidden elements (render facts decide later)', () => {
    const d = run('<button hidden>h</button><button style="display:none">n</button>');
    expect(d.interactive).toHaveLength(2);
  });

  it('skips script/style/template subtrees and counts frames', () => {
    const d = run('<template><button>t</button></template><script>var a</script><iframe></iframe><button>ok</button>');
    expect(tags(d.interactive)).toEqual(['button']);
    expect(d.frames).toBe(1);
  });

  it('traverses open shadow roots', () => {
    mount('<div id="host"></div><button>light</button>');
    const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>in shadow</button><h2>Shadow heading</h2>';
    const d = discover({ reader: fixtureReader() });
    expect(d.openShadowRoots).toBe(1);
    expect(d.interactive.map((f) => f.el.textContent)).toEqual(['in shadow', 'light']);
    expect(d.context.some((f) => f.kind === 'heading')).toBe(true);
  });

  it('collects scroll candidates by extent', () => {
    const d = run('<div data-rect="0 0 100 100" data-scroll="100 100 100 500"></div><div data-rect="0 0 100 100"></div>');
    expect(d.scrollCandidates).toHaveLength(1);
  });

  it('form fixture: every field is a candidate, hidden inputs are not', () => {
    const d = run(formPage);
    expect(tags(d.interactive)).toEqual(['input', 'input', 'textarea', 'select', 'input', 'input']);
    expect(semanticBasis(document.querySelector('input[type=hidden]')!, undefined)).toBeNull();
  });

  it('unsemantic fixture finds the cursor heuristic control', () => {
    const d = run(unsemantic);
    expect(d.interactive.map((f) => f.interactive)).toEqual(['cursor']);
  });
});
