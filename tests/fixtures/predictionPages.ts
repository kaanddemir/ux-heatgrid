/**
 * Cross-page-type prediction fixtures (viewport 1280×800). Rects via data-rect (x y w h).
 * Styles are inline so the test DOM computes them. Element ids are used by assertions only —
 * the predictor never sees ids, labels or wording.
 */

const BTN = 'background-color: rgb(29, 78, 216); color: rgb(255, 255, 255); font-weight: 600; padding: 14px 24px';
const GHOST = 'color: rgb(17, 17, 17); border: 1px solid rgb(17, 17, 17); padding: 10px 16px';
const LINK = 'color: rgb(29, 78, 216)';

export const pages = {
  /** 1. Landing page with one clear primary action. */
  landing: `
    <header data-rect="0 0 1280 64">
      <a id="logo" href="/" style="${LINK}" data-rect="24 20 80 24">Acme</a>
      <nav data-rect="700 0 580 64">
        ${['f', 'p', 'd', 'b'].map((x, i) => `<a id="nav-${x}" href="/${x}" style="${LINK}" data-rect="${720 + i * 90} 22 70 20">${x}</a>`).join('')}
      </nav>
    </header>
    <main data-rect="0 64 1280 2000">
      <h1 data-rect="100 160 800 64">Title</h1>
      <p data-rect="100 240 700 60">Intro</p>
      <a id="cta" href="/go" style="${BTN}; font-size: 18px" data-rect="100 330 240 60">Go</a>
      <button id="secondary" style="${GHOST}" data-rect="360 336 160 48">More</button>
      <h2 data-rect="100 1000 600 40">Section</h2>
      <a id="body-link" href="/x" style="${LINK}" data-rect="100 1060 120 20">Read</a>
    </main>
    <footer data-rect="0 2064 1280 120">
      ${Array.from({ length: 6 }, (_, i) => `<a id="foot-${i}" href="/f${i}" style="${LINK}" data-rect="${24 + i * 100} 2100 80 18">f</a>`).join('')}
    </footer>`,

  /** 2. Dashboard: many similar controls, one filled primary in a toolbar. */
  dashboard: `
    <header data-rect="0 0 1280 56"><button id="new" style="${BTN}" data-rect="1120 10 140 36">New</button></header>
    <main data-rect="0 56 1280 1400">
      <h1 data-rect="24 72 300 32">Overview</h1>
      ${Array.from({ length: 40 }, (_, i) => `<button id="row-${i}" style="color: rgb(55, 65, 81)" data-rect="${1000 + (i % 2) * 80} ${140 + Math.floor(i / 2) * 40} 64 24">Edit</button>`).join('')}
      ${Array.from({ length: 20 }, (_, i) => `<a id="cell-${i}" href="/r${i}" style="${LINK}" data-rect="24 ${140 + i * 40} 200 24">Row</a>`).join('')}
    </main>`,

  /** 3. Documentation: links in text, a sidebar, a copy button. */
  docs: `
    <aside data-rect="0 0 260 3000">
      ${Array.from({ length: 30 }, (_, i) => `<a id="side-${i}" href="/d${i}" style="${LINK}" data-rect="16 ${20 + i * 28} 220 20">Page</a>`).join('')}
    </aside>
    <main data-rect="260 0 1020 3000">
      <h1 data-rect="300 20 600 48">Guide</h1>
      <p data-rect="300 90 700 120">Text <a id="inline-1" href="/a" style="${LINK}" data-rect="420 110 80 20">ref</a></p>
      <h2 data-rect="300 400 600 36">Install</h2>
      <button id="copy" style="${GHOST}" data-rect="900 460 72 32">Copy</button>
      <h2 data-rect="300 1400 600 36">API</h2>
      <a id="inline-2" href="/b" style="${LINK}" data-rect="300 1460 120 20">spec</a>
    </main>`,

  /** 4. Dense navigation: 60 nav links and one content action. */
  denseNav: `
    <header data-rect="0 0 1280 140"><nav data-rect="0 0 1280 140">
      ${Array.from({ length: 60 }, (_, i) => `<a id="n-${i}" href="/c${i}" style="${LINK}" data-rect="${(i % 15) * 84 + 8} ${8 + Math.floor(i / 15) * 30} 76 22">c</a>`).join('')}
    </nav></header>
    <main data-rect="0 140 1280 1200"><h1 data-rect="24 170 500 40">Category</h1>
      <button id="filter" style="${BTN}" data-rect="24 240 160 44">Filter</button></main>`,

  /** 5. Long article: content links spread over many screens. */
  article: `
    <main data-rect="0 0 1280 12000">
      <h1 data-rect="200 40 880 80">Headline</h1>
      ${Array.from({ length: 12 }, (_, i) => `<p data-rect="200 ${200 + i * 950} 700 600">Para</p><a id="a-${i}" href="/l${i}" style="${LINK}" data-rect="200 ${820 + i * 950} 140 20">link</a>`).join('')}
      <button id="subscribe" style="${BTN}" data-rect="200 11700 200 48">Subscribe</button>
    </main>`,

  /** 6. Form-heavy page. */
  form: `
    <main data-rect="0 0 1280 1400"><form aria-label="Signup" data-rect="320 40 640 1200">
      ${Array.from({ length: 10 }, (_, i) => `<input id="f-${i}" type="text" style="border: 1px solid rgb(156, 163, 175); padding: 8px" data-rect="340 ${80 + i * 90} 600 40">`).join('')}
      <button id="submit" type="submit" style="${BTN}" data-rect="340 1000 600 52">Create</button>
      <a id="terms" href="/t" style="${LINK}" data-rect="340 1070 120 18">terms</a>
    </form></main>`,

  /** 7. E-commerce product page. */
  product: `
    <main data-rect="0 0 1280 2400">
      <img data-rect="40 40 600 600" alt="">
      <h1 data-rect="680 40 560 60">Product</h1>
      <button id="add" style="${BTN}; font-size: 18px" data-rect="680 300 400 60">Add</button>
      <button id="wish" style="${GHOST}" data-rect="1100 306 140 48">Save</button>
      ${Array.from({ length: 5 }, (_, i) => `<button id="size-${i}" style="${GHOST}" data-rect="${680 + i * 70} 200 60 40">S</button>`).join('')}
      <h2 data-rect="40 900 400 36">Related</h2>
      ${Array.from({ length: 8 }, (_, i) => `<a id="rel-${i}" href="/p${i}" style="${LINK}" data-rect="${40 + (i % 4) * 300} ${960 + Math.floor(i / 4) * 300} 260 260">rel</a>`).join('')}
    </main>`,

  /** 8. Several equal-weight controls and nothing else. */
  equal: `
    <main data-rect="0 0 1280 800">
      ${Array.from({ length: 6 }, (_, i) => `<button id="eq-${i}" style="${GHOST}" data-rect="${100 + i * 180} 300 160 48">Opt</button>`).join('')}
    </main>`,

  /** 9. Important control below the fold (only clearly emphasized control on the page). */
  belowFold: `
    <main data-rect="0 0 1280 3000">
      <h1 data-rect="100 40 800 60">Story</h1>
      ${Array.from({ length: 5 }, (_, i) => `<a id="top-${i}" href="/t${i}" style="${LINK}" data-rect="100 ${160 + i * 40} 100 18">t</a>`).join('')}
      <h2 data-rect="100 2000 600 40">Ready?</h2>
      <a id="deep-cta" href="/go" style="${BTN}; font-size: 20px" data-rect="100 2080 320 64">Start</a>
    </main>`,

  /** 10. Footer-heavy page: tiny content, huge footer. */
  footerHeavy: `
    <main data-rect="0 0 1280 400"><h1 data-rect="40 40 400 40">Hi</h1><a id="main-link" href="/m" style="${LINK}" data-rect="40 120 140 20">more</a></main>
    <footer data-rect="0 400 1280 1200">
      ${Array.from({ length: 48 }, (_, i) => `<a id="ft-${i}" href="/x${i}" style="${LINK}" data-rect="${40 + (i % 6) * 200} ${440 + Math.floor(i / 6) * 40} 160 20">x</a>`).join('')}
    </footer>`,

  /** 11. Icon-button toolbar: many tiny square buttons. */
  toolbar: `
    <main data-rect="0 0 1280 800">
      <div role="toolbar" data-rect="0 0 1280 48">
        ${Array.from({ length: 14 }, (_, i) => `<button id="icon-${i}" aria-label="tool" style="padding: 4px" data-rect="${8 + i * 30} 10 22 22"></button>`).join('')}
      </div>
      <h1 data-rect="24 80 400 40">Doc</h1>
      <button id="share" style="${BTN}" data-rect="1100 6 140 36">Share</button>
    </main>`,

  /** 12. Heuristic cursor:pointer controls only (div-soup). */
  heuristic: `
    <div data-rect="0 0 1280 800">
      ${Array.from({ length: 4 }, (_, i) => `<div id="h-${i}" style="cursor: pointer; padding: 8px; background-color: rgb(238, 238, 255)" data-rect="${40 + i * 220} 200 200 48">Tile</div>`).join('')}
      <button id="real" style="${BTN}" data-rect="40 400 180 48">Real</button>
    </div>`,
} as const;

export type PageName = keyof typeof pages;
