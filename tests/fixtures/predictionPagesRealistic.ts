/**
 * More realistic prediction fixtures (viewport 1280×800): sticky headers without landmarks,
 * product grids, landmark-free apps, a blog with a sticky table of contents, a short signup form.
 * Used for page-wide invariants (explanations, confidence), not for page-specific expectations.
 */
const BTN = 'background-color: rgb(29, 78, 216); color: rgb(255, 255, 255); font-weight: 600; padding: 14px 24px';
const GHOST = 'color: rgb(17, 17, 17); border: 1px solid rgb(17, 17, 17); padding: 10px 16px';
const LINK = 'color: rgb(29, 78, 216)';
const GREY = 'color: rgb(75, 85, 99)';
const r = (n: number) => Array.from({ length: n }, (_, i) => i);
export const realisticPages = {
  /** Real-world-ish landing: sticky header (div, no landmark), hero, feature cards, long body. */
  stickyLanding: `
    <div style="position: sticky" data-rect="0 0 1280 64">
      <a id="sl-logo" href="/" style="${LINK}; font-weight: 700" data-rect="24 20 90 24">Brand</a>
      ${r(7).map((i) => `<a id="sl-nav-${i}" href="/n${i}" style="${GREY}" data-rect="${300 + i * 90} 22 72 20">Item</a>`).join('')}
      <a id="sl-signin" href="/login" style="${GREY}" data-rect="1040 22 60 20">Sign in</a>
      <a id="sl-trial" href="/trial" style="${BTN}; padding: 8px 14px" data-rect="1120 14 136 36">Start trial</a>
    </div>
    <div data-rect="0 64 1280 5200">
      <h1 data-rect="160 160 960 120">Big promise</h1>
      <p data-rect="240 300 800 60">Subtitle</p>
      <a id="sl-hero" href="/go" style="${BTN}; font-size: 18px" data-rect="460 400 200 56">Get started</a>
      <a id="sl-demo" href="/demo" style="${GHOST}" data-rect="680 404 160 48">Book a demo</a>
      ${r(6).map((i) => `<h3 data-rect="${80 + (i % 3) * 400} ${1000 + Math.floor(i / 3) * 400} 320 32">F</h3><p data-rect="${80 + (i % 3) * 400} ${1040 + Math.floor(i / 3) * 400} 320 80">x</p><a id="sl-card-${i}" href="/c${i}" style="${LINK}" data-rect="${80 + (i % 3) * 400} ${1130 + Math.floor(i / 3) * 400} 100 20">Learn more</a>`).join('')}
      <h2 data-rect="160 2400 960 60">Pricing</h2>
      ${r(3).map((i) => `<button id="sl-plan-${i}" style="${i === 1 ? BTN : GHOST}" data-rect="${120 + i * 360} 2900 300 48">Choose</button>`).join('')}
      <h2 data-rect="160 3600 960 60">Ready?</h2>
      <a id="sl-final" href="/go2" style="${BTN}; font-size: 18px" data-rect="540 3700 200 56">Get started</a>
    </div>
    <div data-rect="0 5264 1280 400">${r(20).map((i) => `<a id="sl-foot-${i}" href="/f${i}" style="${GREY}; font-size: 13px" data-rect="${40 + (i % 5) * 240} ${5300 + Math.floor(i / 5) * 30} 120 16">f</a>`).join('')}</div>`,

  /** E-commerce category grid: filter sidebar + 24 product cards with title link and add button. */
  shopGrid: `
    <header data-rect="0 0 1280 72"><a id="sg-logo" href="/" style="${LINK}" data-rect="24 24 100 24">Shop</a>
      <input id="sg-search" type="search" style="border: 1px solid rgb(156, 163, 175); padding: 8px" data-rect="300 16 500 40">
      <a id="sg-cart" href="/cart" style="${GREY}" data-rect="1180 24 60 24">Cart</a></header>
    <aside data-rect="0 72 260 3000">${r(16).map((i) => `<label data-rect="16 ${100 + i * 32} 220 24"><input id="sg-f-${i}" type="checkbox" data-rect="16 ${104 + i * 32} 16 16"> f</label>`).join('')}</aside>
    <main data-rect="260 72 1020 3000"><h1 data-rect="280 90 400 40">Shoes</h1>
      ${r(24).map((i) => { const x = 280 + (i % 4) * 250, y = 160 + Math.floor(i / 4) * 420; return `<a id="sg-p-${i}" href="/p${i}" style="${LINK}" data-rect="${x} ${y} 230 300">img</a><a id="sg-t-${i}" href="/p${i}" style="color: rgb(17,17,17)" data-rect="${x} ${y + 310} 230 20">Name</a><button id="sg-add-${i}" style="${GHOST}; padding: 6px 10px" data-rect="${x} ${y + 340} 120 32">Add</button>`; }).join('')}
    </main>`,

  /** App dashboard without landmarks: fixed top bar, sidebar of divs with role=link, data table. */
  appNoLandmarks: `
    <div style="position: fixed" data-rect="0 0 1280 56"><div id="ap-menu" role="button" tabindex="0" data-rect="12 12 32 32"></div>
      <button id="ap-new" style="${BTN}; padding: 6px 12px" data-rect="1120 10 140 36">Create</button></div>
    <div data-rect="0 56 220 744">${r(12).map((i) => `<div id="ap-side-${i}" role="link" tabindex="0" style="${GREY}" data-rect="12 ${70 + i * 36} 196 28">s</div>`).join('')}</div>
    <div data-rect="220 56 1060 2400"><div role="heading" aria-level="1" data-rect="240 72 300 32">Projects</div>
      ${r(30).map((i) => `<a id="ap-row-${i}" href="/r${i}" style="${LINK}" data-rect="240 ${130 + i * 44} 300 24">Row</a><button id="ap-act-${i}" aria-label="more" style="${GREY}" data-rect="1220 ${130 + i * 44} 28 28"></button>`).join('')}
    </div>`,

  /** Blog post with a sticky table of contents and inline links. */
  blog: `
    <header data-rect="0 0 1280 64"><a id="bl-logo" href="/" style="${LINK}" data-rect="24 20 80 24">Blog</a>
      <nav data-rect="800 0 480 64">${r(4).map((i) => `<a id="bl-nav-${i}" href="/n${i}" style="${GREY}" data-rect="${820 + i * 100} 22 80 20">n</a>`).join('')}</nav></header>
    <main data-rect="0 64 1280 6000"><article data-rect="320 64 640 6000"><h1 data-rect="320 100 640 100">Post</h1>
      ${r(10).map((i) => `<p data-rect="320 ${240 + i * 560} 640 500">Para <a id="bl-in-${i}" href="/x${i}" style="${LINK}" data-rect="${400 + (i % 3) * 120} ${300 + i * 560} 90 20">ref</a></p>`).join('')}
      <button id="bl-share" style="${GHOST}" data-rect="320 5900 120 40">Share</button></article>
      <aside style="position: sticky" data-rect="1000 100 240 400">${r(8).map((i) => `<a id="bl-toc-${i}" href="#s${i}" style="${GREY}; font-size: 14px" data-rect="1000 ${110 + i * 26} 220 20">toc</a>`).join('')}</aside></main>`,

  /** Simple vs dense nav, isolated primary in a form with many fields at mobile-ish width. */
  signup: `
    <main data-rect="0 0 1280 900"><h1 data-rect="440 60 400 48">Create account</h1><form data-rect="440 120 400 600">
      ${r(4).map((i) => `<input id="su-f-${i}" type="text" style="border: 1px solid rgb(156, 163, 175); padding: 8px" data-rect="440 ${140 + i * 70} 400 44">`).join('')}
      <button id="su-submit" type="submit" style="${BTN}" data-rect="440 440 400 52">Sign up</button>
      <a id="su-login" href="/login" style="${LINK}; font-size: 14px" data-rect="560 520 160 18">Have an account?</a></form></main>`,
} as const;
