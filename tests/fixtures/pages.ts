/** Small DOM fixtures. Rects are given explicitly via data-rect (x y w h, viewport-relative). */

export const landing = `
<header data-rect="0 0 1280 80">
  <a href="/" data-rect="20 20 120 40">Acme</a>
  <nav aria-label="Primary" data-rect="600 0 680 80">
    <a href="/features" data-rect="620 25 80 30">Features</a>
    <a href="/pricing" data-rect="720 25 80 30">Pricing</a>
  </nav>
</header>
<main data-rect="0 80 1280 1520">
  <h1 data-rect="100 150 800 60">Ship faster</h1>
  <p data-rect="100 230 700 50">A short intro paragraph about the product.</p>
  <a href="/signup" class="btn primary" data-rect="100 300 220 56">Get started</a>
  <button data-rect="340 300 160 56">Watch demo</button>
  <h2 data-rect="100 900 600 40">Features</h2>
  <p data-rect="100 960 700 80">Feature details.</p>
  <h2 data-rect="100 1200 600 40">Pricing</h2>
  <button data-rect="100 1280 160 48">Choose plan</button>
</main>
<footer data-rect="0 1600 1280 200"><a href="/privacy" data-rect="20 1650 80 20">Privacy</a></footer>`;

export function denseNav(n = 60): string {
  const links = Array.from({ length: n }, (_, i) => `<a href="/l${i}" data-rect="${(i % 20) * 60} ${Math.floor(i / 20) * 30} 55 25">Link ${i}</a>`).join('');
  return `<nav data-rect="0 0 1280 100">${links}</nav><main data-rect="0 100 1280 700"><h1 data-rect="20 120 600 40">Title</h1></main>`;
}

export const longPage = `
<main data-rect="0 0 1280 12000">
  ${Array.from({ length: 10 }, (_, i) => `<h2 data-rect="40 ${i * 1200 + 20} 600 40">Chapter ${i + 1}</h2><p data-rect="40 ${i * 1200 + 80} 700 300">Body ${i}</p><button data-rect="40 ${i * 1200 + 400} 140 40">Action ${i}</button>`).join('')}
</main>`;

export const formPage = `
<main data-rect="0 0 1280 900">
  <form aria-label="Checkout" data-rect="100 50 600 700">
    <label for="email" data-rect="100 60 200 20">Email address</label>
    <input id="email" type="email" value="private@example.com" data-rect="100 85 400 40">
    <label data-rect="100 140 400 60">Password <input id="pw" type="password" value="hunter2" data-rect="100 165 400 40"></label>
    <input type="hidden" name="csrf" value="secret-token">
    <textarea id="notes" aria-label="Order notes" data-rect="100 220 400 100">my secret note</textarea>
    <select id="country" data-rect="100 340 200 40"><option>Somewhere</option></select>
    <input type="checkbox" id="terms" data-rect="100 400 20 20"><label for="terms" data-rect="130 400 200 20">Accept terms</label>
    <input type="submit" value="Pay $99 now" data-rect="100 460 160 48">
  </form>
</main>`;

export const nestedScroll = `
<div id="app" data-rect="0 0 1280 800">
  <aside id="sidebar" style="overflow-y: auto" data-rect="0 0 300 800" data-scroll="300 800 300 3000">
    ${Array.from({ length: 5 }, (_, i) => `<a href="/s${i}" data-rect="10 ${i * 40 + 10} 280 30">Item ${i}</a>`).join('')}
  </aside>
  <div id="feed" style="overflow-y: auto" data-rect="300 0 980 800" data-scroll="980 800 980 9000"><p data-rect="320 20 900 100">Feed</p></div>
  <div id="clipped" style="overflow: hidden" data-rect="300 700 400 100" data-scroll="400 100 400 900"></div>
  <div id="tiny" style="overflow-y: auto" data-rect="900 700 100 60" data-scroll="100 60 100 400"></div>
</div>`;

export const transparentBackgrounds = `
<div id="outer" style="background-color: rgb(0, 0, 255)" data-rect="0 0 1280 800">
  <div id="mid" style="background-color: rgba(255, 255, 255, 0.5)" data-rect="0 0 1280 400">
    <button id="btn" style="background-color: transparent; color: rgb(255, 255, 255)" data-rect="20 20 120 40">Ghost</button>
    <p id="txt" style="color: rgba(0, 0, 0, 0.5)" data-rect="20 80 600 40">Half-opaque text</p>
  </div>
</div>`;

export const gradientBackground = `
<section aria-label="Hero" id="hero" style="background-image: linear-gradient(red, blue)" data-rect="0 0 1280 600">
  <h1 id="title" style="color: rgb(255, 255, 255)" data-rect="100 100 800 60">Hero title</h1>
  <a id="cta" href="/go" style="color: rgb(255, 255, 255)" data-rect="100 200 160 48">Go</a>
</section>
<div style="background-image: url(x.png)" data-rect="0 600 1280 200"><p id="onimage" data-rect="20 620 400 30">On image</p></div>
<div style="opacity: 0.5" data-rect="0 800 1280 100"><p id="faded" data-rect="20 820 400 30">Faded</p></div>`;

export function many(n: number): string {
  return `<main data-rect="0 0 1280 ${n * 30}">${Array.from({ length: n }, (_, i) => `<button data-rect="10 ${i * 30} 100 24">B${i}</button>`).join('')}</main>`;
}

export const unsemantic = `
<div id="wrap" data-rect="0 0 1280 2000">
  <div data-rect="0 0 1280 600"><span style="cursor: pointer" data-rect="10 10 100 30">Fake button</span></div>
  <div data-rect="0 600 1280 800"><div data-rect="10 610 300 40">Text</div></div>
  <div data-rect="0 1400 1280 600"></div>
</div>`;
