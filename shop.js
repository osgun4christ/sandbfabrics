/* Online shop — customers browse, build a cart and send the order to the shop on WhatsApp.
 * Talks to the Apps Script backend (shopList, shopCatalog, shopOrder, shopTrack). No login, no payment gateway.
 * Prices, photos, banners, delivery areas, pickup places and opening hours all come from the Google Sheet,
 * set by staff in the Store Manager app (Admin → Online shop).
 */
'use strict';
(function () {
  const GAS = typeof google !== 'undefined' && google.script && google.script.run;
  const CFG = Object.assign({}, window.SHOP_CONFIG || {});
  try { const qp = new URLSearchParams(location.search); if (!CFG.api && qp.get('api')) CFG.api = qp.get('api'); } catch (e) { /* ignore */ }
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
  const usd = (n) => '$' + num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lrd = (n) => 'L$' + Math.round(num(n)).toLocaleString('en-US');
  const money = (n, c) => (c === 'LRD' ? lrd(n) : usd(n));
  const qtyFmt = (q) => (Math.round(num(q) * 100) / 100).toLocaleString('en-US');
  const uuid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'o' + Date.now() + Math.random().toString(16).slice(2));
  const keep = { get: (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode / full */ } } };

  const IC = {
    bag: '<path d="M6 7h12l-1 13H7L6 7z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
    truck: '<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
    pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    back: '<path d="M15 5l-7 7 7 7"/>', check: '<path d="M5 12l5 5 9-10"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
    chat: '<path d="M21 12a8.5 8.5 0 0 1-12.6 7.4L3 21l1.6-5.2A8.5 8.5 0 1 1 21 12z"/>', zoom: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5M11 8v6M8 11h6"/>',
    store: '<path d="M4 10v10h16V10M3 10l2-6h14l2 6M3 10h18M9 20v-6h6v6"/>', track: '<path d="M3 12h4l3 8 4-16 3 8h4"/>'
  };
  const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${IC[n]}</svg>`;

  const S = { data: null, ref: '', multi: false, links: null, view: { name: 'home' }, cart: [], customer: {}, layer: null,
    pp: null, done: null, track: null, error: '', sending: false, slide: 0, offline: false, list: null };

  /* ---------- API ---------- */
  function call(action, body) {
    const payload = Object.assign({ action }, body);
    if (GAS) {
      return new Promise((res, rej) => google.script.run
        .withSuccessHandler((t) => { const j = JSON.parse(t); j.ok ? res(j) : rej(Object.assign(new Error(j.message || j.error), { code: j.error })); })
        .withFailureHandler(() => rej(new Error(navigator.onLine ? 'The shop is busy, please try again' : 'No internet connection')))
        .apiCall(JSON.stringify(payload)));
    }
    if (!CFG.api) return Promise.reject(new Error('Shop not connected yet: put your web app address in config.js'));
    return fetch(CFG.api, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) })
      .catch(() => { throw new Error('No internet connection — please try again'); })
      .then((r) => r.json()).then((j) => { if (!j.ok) throw Object.assign(new Error(j.message || j.error), { code: j.error }); return j; });
  }
  function params() {
    if (GAS) return new Promise((res) => google.script.url.getLocation((l) => res(l.parameter || {})));
    const p = new URLSearchParams(location.search);
    return Promise.resolve({ shop: p.get('shop') || p.get('s') || '', p: p.get('p') || '', track: p.get('track') || '' });
  }
  function base() {
    if (!GAS) return location.origin + location.pathname;
    return (S.links && (S.links.shopUrl || S.links.webAppUrl)) || '';
  }
  function link(code, extra) {
    const b = base();
    if (!b) return '';
    let u = b + (b.indexOf('?') >= 0 ? '&' : '?') + 'shop=' + encodeURIComponent(code || 'all');
    Object.keys(extra || {}).forEach((k) => { u += '&' + k + '=' + encodeURIComponent(extra[k]); });
    if (!GAS && CFG.api && /[?&]api=/.test(location.search)) u += '&api=' + encodeURIComponent(CFG.api);
    return u;
  }
  function share(title, text, url) {
    if (navigator.share) { navigator.share({ title, text, url }).catch(() => {}); return; }
    window.open('https://wa.me/?text=' + encodeURIComponent(text + '\n' + url), '_blank', 'noopener');
  }
  const waLink = (text) => (S.data && S.data.store.whatsapp ? 'https://wa.me/' + S.data.store.whatsapp + (text ? '?text=' + encodeURIComponent(text) : '') : '#');

  /* ---------- look ---------- */
  function theme(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); const n = m ? parseInt(m[1], 16) : 0xd1217e;
    const r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    const mix = (t, w) => '#' + [r, g, b].map((x) => Math.round(x + (w - x) * t).toString(16).padStart(2, '0')).join('');
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const st = document.documentElement.style;
    // very light colours are darkened so prices and buttons stay readable
    const main = lum > 0.55 ? mix(0.35, 0) : '#' + n.toString(16).padStart(6, '0');
    st.setProperty('--brand', main);
    st.setProperty('--brand-ink', mix(lum > 0.55 ? 0.5 : 0.2, 0));
    st.setProperty('--brand-soft', mix(0.93, 255));
    st.setProperty('--on-brand', '#fff');
  }
  /** Google Drive photos come in the size we ask for — small on phones saves data. */
  function img(u, w) {
    if (!u) return '';
    if (/lh3\.googleusercontent\.com\/d\/[\w-]+$/.test(u)) return u + '=w' + Math.round(w * Math.min(2, window.devicePixelRatio || 1));
    return u;
  }
  const initials = (t) => String(t || '?').replace(/[^A-Za-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  function photo(p, w, attrs) {
    return p.image ? `<img src="${esc(img(p.image, w))}" alt="${esc(p.name)}" loading="lazy" decoding="async" ${attrs || ''}>`
      : `<div class="ph" aria-hidden="true">${esc(initials(p.name))}</div>`;
  }

  /* ---------- data helpers ---------- */
  const product = (id) => S.data && S.data.products.find((p) => p.id === id);
  const rate = () => num(S.data && S.data.rate) || 1;
  const toUSD = (n, c) => (c === 'LRD' ? num(n) / rate() : num(n));
  const unitWord = (p) => (/yard/i.test(p.unit) ? 'per yard' : (p.unit && p.unit !== 'piece' ? 'per ' + p.unit : ''));
  const isYard = (p) => /yard/i.test(p.unit);
  function cartLines() { return S.cart.map((l) => ({ l, p: product(l.id) })).filter((x) => x.p && x.p.availability !== 'OUT'); }
  function totals(method, optId) {
    let u = 0, l = 0, count = 0;
    cartLines().forEach(({ l: c, p }) => { const t = p.price * c.qty; if (p.currency === 'LRD') l += t; else u += t; count += 1; });
    let fee = 0, feeCur = 'USD', opt = null;
    if (method === 'DELIVERY' && S.data) { opt = S.data.options.delivery.find((o) => o.id === optId); if (opt) { fee = opt.fee; feeCur = opt.currency; } }
    const U = u + (feeCur === 'USD' ? fee : 0), L = l + (feeCur === 'LRD' ? fee : 0);
    const parts = []; if (U || !L) parts.push(usd(U)); if (L) parts.push(lrd(L));
    return { u, l, count, fee, feeCur, opt, U, L, text: parts.join(' + '), mixed: U > 0 && L > 0, allUSD: U + L / rate(), allLRD: U * rate() + L };
  }
  function saveCart() { keep.set('shop-cart:' + S.ref, S.cart); }
  function addToCart(p, qty, custom) {
    const key = p.id + '|' + (custom ? custom.name + '|' + custom.colours : '');
    const ex = S.cart.find((c) => c.key === key);
    if (ex) ex.qty = Math.round((ex.qty + qty) * 100) / 100; else S.cart.push({ key, id: p.id, qty, custom: custom || null });
    saveCart();
  }
  function priceHTML(p) {
    const sale = p.was > p.price;
    return `<div class="pr"><b class="${sale ? 'sale' : ''}">${money(p.price, p.currency)}</b>${sale ? `<s>${money(p.was, p.currency)}</s>` : ''}${unitWord(p) ? `<small>${unitWord(p)}</small>` : ''}</div>`;
  }
  function tagsHTML(p) {
    const t = [];
    if (p.availability === 'OUT') t.push('<span class="pill out">Sold out</span>');
    else if (p.was > p.price) t.push(`<span class="pill sale">−${Math.round((1 - p.price / p.was) * 100)}%</span>`);
    else if (p.personalise) t.push('<span class="pill custom">Add your name</span>');
    else if (p.tag === 'NEW') t.push('<span class="pill">New</span>');
    else if (p.availability === 'LOW') t.push('<span class="pill low">Few left</span>');
    return t.length ? `<div class="tags">${t.join('')}</div>` : '';
  }
  function card(p) {
    const inCart = S.cart.some((c) => c.id === p.id);
    const quick = p.availability !== 'OUT';
    return `<a class="pcard${p.availability === 'OUT' ? ' soldout' : ''}" href="#" data-pid="${esc(p.id)}">
      <div class="media">${photo(p, 400)}${tagsHTML(p)}
        ${quick ? `<button type="button" class="qadd${inCart ? ' in' : ''}" data-add="${esc(p.id)}" aria-label="${p.personalise ? 'Choose name for' : 'Add to cart:'} ${esc(p.name)}">${inCart ? icon('check') : icon('plus')}</button>` : ''}</div>
      <span class="cat-l">${esc(p.category)}</span><span class="nm">${esc(p.name)}</span>${priceHTML(p)}</a>`;
  }
  function sortList(list, how) {
    const v = (p) => toUSD(p.price, p.currency);
    const a = list.slice();
    if (how === 'low') a.sort((x, y) => v(x) - v(y));
    else if (how === 'high') a.sort((x, y) => v(y) - v(x));
    else if (how === 'new') a.sort((x, y) => (y.tag === 'NEW') - (x.tag === 'NEW') || y.updated - x.updated);
    else if (how === 'best') a.sort((x, y) => (x.best || 99) - (y.best || 99));
    else a.sort((x, y) => (y.tag === 'FEATURED') - (x.tag === 'FEATURED') || (y.tag === 'NEW') - (x.tag === 'NEW') || (x.best || 99) - (y.best || 99));
    return a.sort((x, y) => (x.availability === 'OUT') - (y.availability === 'OUT'));
  }
  const COLL = { new: 'New in', sale: 'On sale', best: 'Best sellers', custom: 'Made for you', all: 'All products' };
  function collection(name) {
    const P = S.data.products.filter((p) => p.availability !== 'OUT');
    if (name === 'new') { const t = P.filter((p) => p.tag === 'NEW'); return t.length ? t : sortList(P, 'new'); }
    if (name === 'sale') return P.filter((p) => p.was > p.price);
    if (name === 'best') return sortList(P.filter((p) => p.best), 'best');
    if (name === 'custom') return P.filter((p) => p.personalise);
    if (name === 'featured') return P.filter((p) => p.tag === 'FEATURED');
    return S.data.products;
  }

  /* ---------- navigation ---------- */
  function go(view, replace) {
    S.view = view; S.error = '';
    if (view.name === 'product') S.pp = { img: 0, qty: (product(view.id) || {}).step || 1, name: '', colours: '', added: false, err: '' };
    try { history[replace ? 'replaceState' : 'pushState']({ view }, ''); } catch (e) { /* sandboxed */ }
    S.layer = null; render(); window.scrollTo(0, 0);
  }
  window.addEventListener('popstate', (e) => { if (e.state && e.state.view) { S.view = e.state.view; if (S.view.name === 'product') S.pp = { img: 0, qty: 1, name: '', colours: '' }; S.layer = null; render(); } });

  /* ---------- page parts ---------- */
  function announcement() {
    const d = S.data || S.list || {};
    const b = d.brand || {};
    let t = b.announcement;
    if (!t && S.data) {
      const o = S.data.options; const bits = [];
      if (o.delivery.length) bits.push('Delivery available'); if (o.pickup.length) bits.push('Pickup at agreed places');
      bits.push('Order on WhatsApp'); t = bits.join(' · ');
    }
    return (S.offline ? '<div class="offline">You are offline — showing the last saved prices. Orders need internet.</div>' : '') +
      (t ? `<div class="announce">${esc(t)}</div>` : '');
  }
  function logo() {
    const d = S.data || S.list || {};
    const b = d.brand || {};
    const name = d.business || (d.store && d.store.name) || 'Shop';
    return `<a class="logo" href="#" data-home aria-label="${esc(name)} home">${b.logo ? `<img src="${esc(img(b.logo, 360))}" alt="${esc(name)}">` : `<span class="txt">${esc(name)}</span>`}</a>`;
  }
  function header() {
    const t = totals();
    if (!S.data) return `<header class="head"><div class="wrap row">${logo()}</div></header>`;
    const cats = S.data.categories;
    const sale = S.data.products.some((p) => p.was > p.price);
    const v = S.view;
    return `<header class="head"><div class="wrap row">
      <button type="button" class="iconbtn menu-btn" data-menu aria-label="Menu">${icon('menu')}</button>
      ${logo()}
      <form class="search" role="search" data-search>${icon('search')}<label for="q" class="sr">Search the shop</label>
        <input id="q" type="search" placeholder="Search ${esc((cats.slice(0, 2).join(', ') || 'products').toLowerCase())}…" value="${esc(v.q || '')}" autocomplete="off"></form>
      <div class="acts">
        <a class="chat" href="${esc(waLink('Hello ' + (S.data.business || S.data.store.name) + ', '))}" target="_blank" rel="noopener">${icon('chat')} Chat with us</a>
        <button type="button" class="iconbtn dark" data-cart aria-label="Cart, ${t.count} items">${icon('bag')}${t.count ? `<span class="badge">${t.count}</span>` : ''}</button>
      </div></div>
      <nav class="wrap nav" aria-label="Categories">
        ${cats.slice(0, 7).map((c) => `<a href="#" data-cat="${esc(c)}" class="${v.name === 'list' && v.cat === c ? 'on' : ''}">${esc(c)}</a>`).join('')}
        ${sale ? '<a href="#" data-coll="sale" class="hot">Sale</a>' : ''}
      </nav></header>`;
  }
  function emph(title) {
    const w = String(title).trim().split(/\s+/);
    if (w.length < 4) return esc(title);
    return esc(w.slice(0, -2).join(' ')) + ' <em>' + esc(w.slice(-2).join(' ')) + '</em>';
  }
  function hero() {
    const d = S.data;
    let banners = d.banners && d.banners.length ? d.banners : [{ title: d.store.message || ('Shop ' + (d.business || d.store.name) + ' online'),
      text: 'Order on WhatsApp — delivery or pickup, pay with MoMo or cash.', button: 'Shop now', link: '' }];
    const pics = collection('featured').concat(collection('new'), d.products).filter((p) => p.image);
    const uniq = []; pics.forEach((p) => { if (uniq.indexOf(p) < 0) uniq.push(p); });
    const slides = banners.map((b, i) => {
      const kick = (d.brand && d.brand.tagline) || d.store.name;
      const H = i === 0 ? 'h1' : 'h2';
      const txt = `<div class="txt"><span class="pill">${esc(kick)}</span>
        <${H} class="${H === 'h2' ? 'h1' : ''}">${emph(b.title)}</${H}>${b.text ? `<p>${esc(b.text)}</p>` : ''}
        <div class="cta">${b.button !== '' ? `<a href="#" class="btn pri" data-banner="${esc(b.link || '')}">${esc(b.button || 'Shop now')}</a>` : ''}
        ${i === 0 && collection('custom').length ? '<a href="#" class="btn ghost" data-coll="custom">Made for you</a>' : ''}</div></div>`;
      let art = '';
      if (b.image) {
        const chip = uniq[i] || uniq[0];
        art = `<div class="art"><img class="full" src="${esc(img(b.image, 900))}" alt="" ${i ? 'loading="lazy"' : ''}>
          ${chip ? `<a href="#" class="chip-card" data-pid="${esc(chip.id)}"><img src="${esc(img(chip.image, 120))}" alt=""><div><span>${esc(chip.name)}</span><b>${money(chip.price, chip.currency)}</b></div></a>` : ''}</div>`;
      } else if (uniq.length) {
        const three = [uniq[(i * 3) % uniq.length], uniq[(i * 3 + 1) % uniq.length], uniq[(i * 3 + 2) % uniq.length]];
        art = `<div class="art collage">${three.map((p, k) => `<a href="#" class="c c${k + 1}" data-pid="${esc(p.id)}" aria-label="${esc(p.name)}"><img src="${esc(img(p.image, 500))}" alt="" ${i ? 'loading="lazy"' : ''}></a>`).join('')}</div>`;
      }
      return `<div class="slide">${txt}${art}</div>`;
    }).join('');
    return `<section class="hero" aria-label="Promotions"><div class="slides" id="slides">${slides}</div>
      ${banners.length > 1 ? `<div class="dots">${banners.map((b, i) => `<button type="button" data-slide="${i}" class="${i === S.slide ? 'on' : ''}" aria-label="Banner ${i + 1}"></button>`).join('')}</div>` : ''}</section>`;
  }
  function categories() {
    const d = S.data;
    if (d.categories.length < 2) return '';
    return `<section class="sec"><div class="sec-h"><h2>Shop by category</h2></div><div class="cats">
      ${d.categories.map((c) => { const p = d.products.find((x) => x.category === c && x.image);
        return `<a href="#" class="cat" data-cat="${esc(c)}"><span class="ring">${p ? `<img src="${esc(img(p.image, 300))}" alt="" loading="lazy">` : `<b>${esc(initials(c))}</b>`}</span>${esc(c)}</a>`; }).join('')}
      </div></section>`;
  }
  function row(title, kicker, list, coll, band, max) {
    if (!list.length) return '';
    const n = max || 8;
    const head = `<div class="sec-h"><div>${kicker ? `<span class="kicker${band === 'pink' ? ' pink' : ''}">${esc(kicker)}</span>` : ''}<h2>${esc(title)}</h2></div>
      ${list.length > n || coll ? `<a href="#" data-coll="${coll}">View all →</a>` : ''}</div>`;
    const grid = `<div class="grid${band ? ' tight' : ''}">${list.slice(0, n).map(card).join('')}</div>`;
    return band ? `<section class="band ${band}">${head}${grid}</section>` : `<section class="sec">${head}${grid}</section>`;
  }
  function stepsHTML() {
    const d = S.data; const o = d.options;
    return `<section class="sec"><div class="sec-h" style="justify-content:center;text-align:center;flex-direction:column;align-items:center">
      <h2>Ordering is easy</h2><p style="margin:0;color:var(--ink-2)">No account, no card needed. You order on WhatsApp and talk to a real person.</p></div>
      <div class="steps">
        <div class="step"><span class="n" style="background:var(--brand-soft);color:var(--brand)">1</span><div><h3>Pick what you love</h3><p>Add items to your cart${collection('custom').length ? ' — for made-to-order items, type the name and colours you want' : ''}.</p></div></div>
        <div class="step"><span class="n" style="background:var(--accent-soft);color:var(--accent)">2</span><div><h3>${o.delivery.length && o.pickup.length ? 'Delivery or pickup' : o.delivery.length ? 'We deliver' : 'Pick it up'}</h3><p>${o.delivery.length ? 'We deliver to your area for a small fee' : ''}${o.delivery.length && o.pickup.length ? ', or you collect at an agreed place.' : o.pickup.length ? 'Collect at one of our pickup places.' : '.'}</p></div></div>
        <div class="step"><span class="n" style="background:#e8f5ec;color:var(--wa)">3</span><div><h3>Send on WhatsApp</h3><p>Your order opens in WhatsApp. We confirm, then you pay by MoMo or cash.</p></div></div>
      </div></section>`;
  }
  function footer() {
    const d = S.data; if (!d) return '';
    const b = d.brand || {}; const st = d.store;
    const wa = st.whatsapp ? '+' + st.whatsapp.replace(/^(\d{3})(\d{2})(\d{3})(\d+)$/, '$1 $2 $3 $4') : '';
    const social = [['Facebook', b.facebook], ['Instagram', b.instagram], ['TikTok', b.tiktok]].filter((x) => x[1]);
    return `<footer><div class="wrap cols">
      <div class="col">${logo()}<p style="margin:4px 0 0">${esc(st.message || b.tagline || '')}</p></div>
      <div class="col"><h3>Talk to us</h3>${wa ? `<a class="wa" href="${esc(waLink())}" target="_blank" rel="noopener">WhatsApp ${esc(wa)}</a>` : ''}
        ${st.phone ? `<span>Call ${esc(st.phone)}</span>` : ''}${social.map((s) => `<a href="${esc(s[1])}" target="_blank" rel="noopener">${s[0]}</a>`).join('')}
        <a href="#" data-share-shop>Share this shop</a></div>
      <div class="col"><h3>Find us</h3><span>${esc(st.name)}</span>${st.address ? `<span>${esc(st.address)}</span>` : ''}${st.hours ? `<span>${esc(st.hours)}</span>` : ''}
        ${S.multi ? `<a class="allshops" href="${esc(link('all'))}" target="_top">All our shops →</a>` : ''}</div>
      <div class="col"><h3>Shop</h3>${d.categories.slice(0, 5).map((c) => `<a href="#" data-cat="${esc(c)}" style="color:var(--ink-2);font-weight:500">${esc(c)}</a>`).join('')}
        <a href="#" data-track>Track my order</a></div>
    </div><div class="wrap base">© ${new Date().getFullYear()} ${esc(d.business || st.name)}${b.tagline ? ' · ' + esc(b.tagline) : ''}</div></footer>`;
  }

  /* ---------- views ---------- */
  function home() {
    return `<main class="wrap">${hero()}${categories()}
      ${row('New in', '', collection('new'), 'new')}
      ${row('On sale this week', 'Limited time', collection('sale'), 'sale', 'blue', 4)}
      ${row('Best sellers', '', collection('best'), 'best', '', 4)}
      ${row('Made for you — your name, your colours', 'Made to order', collection('custom'), 'custom', 'pink', 4)}
      ${row('Our picks', '', collection('featured'), 'featured', '', 4)}
      ${row('Shop everything', '', sortList(S.data.products, ''), 'all', '', 12)}
      ${stepsHTML()}</main>`;
  }
  function listView() {
    const v = S.view; const d = S.data;
    let list = v.coll ? collection(v.coll) : d.products;
    if (v.cat) list = list.filter((p) => p.category === v.cat);
    if (v.q) { const q = v.q.toLowerCase(); list = list.filter((p) => (p.name + ' ' + p.category + ' ' + p.description).toLowerCase().indexOf(q) >= 0); }
    if (v.stock) list = list.filter((p) => p.availability !== 'OUT');
    if (v.onsale) list = list.filter((p) => p.was > p.price);
    list = sortList(list, v.sort || '');
    const title = v.q ? `Results for “${v.q}”` : (v.cat || COLL[v.coll] || 'All products');
    return `<main class="wrap"><div class="lp-head"><nav class="crumbs" aria-label="Breadcrumb"><a href="#" data-home>Home</a><span>/</span><span>${esc(title)}</span></nav>
      <h1>${esc(title)}</h1><span style="color:var(--muted)">${list.length} item${list.length === 1 ? '' : 's'}</span></div>
      <div class="tools"><div class="chips" role="group" aria-label="Category">
        <button type="button" class="${!v.cat ? 'on' : ''}" data-fcat="">All</button>${d.categories.map((c) => `<button type="button" class="${v.cat === c ? 'on' : ''}" data-fcat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
        <label class="toggle"><input type="checkbox" data-f="stock" ${v.stock ? 'checked' : ''}> In stock</label>
        ${d.products.some((p) => p.was > p.price) ? `<label class="toggle"><input type="checkbox" data-f="onsale" ${v.onsale ? 'checked' : ''}> On sale</label>` : ''}
        <div class="sel"><label for="sort" class="sr">Sort</label><select id="sort" data-sort>
          ${[['', 'Featured'], ['new', 'Newest'], ['best', 'Best selling'], ['low', 'Price: low to high'], ['high', 'Price: high to low']].map((o) => `<option value="${o[0]}" ${(v.sort || '') === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}
        </select></div></div>
      ${list.length ? `<div class="grid">${list.map(card).join('')}</div>` : `<div class="empty"><h3>Nothing found</h3><p>Try another word, or <a href="${esc(waLink('Hello, do you have '))}" target="_blank" rel="noopener">ask us on WhatsApp</a>.</p></div>`}
      </main>`;
  }
  function productView() {
    const p = product(S.view.id);
    if (!p) return `<main class="wrap"><div class="empty"><h3>This item is no longer available</h3><p><a href="#" data-home>Back to the shop</a></p></div></main>`;
    const d = S.data; const pp = S.pp;
    const pics = [p.image].concat(p.images || []).filter(Boolean);
    const total = p.price * pp.qty;
    const out = p.availability === 'OUT';
    const o = d.options; const minFee = o.delivery.length ? o.delivery.slice().sort((a, b) => toUSD(a.fee, a.currency) - toUSD(b.fee, b.currency))[0] : null;
    const related = d.products.filter((x) => x.id !== p.id && x.category === p.category && x.availability !== 'OUT')
      .concat(d.products.filter((x) => x.id !== p.id && x.category !== p.category && x.availability !== 'OUT')).slice(0, 4);
    const avail = p.personalise ? `<span class="avail made">${icon('clock')} Made for you${p.leadDays ? ` — ready in about ${p.leadDays} day${p.leadDays === 1 ? '' : 's'}` : ''}</span>`
      : out ? '<span class="avail out"><i></i>Sold out at the moment</span>' : p.availability === 'LOW' ? '<span class="avail low"><i></i>Only a few left</span>' : '<span class="avail in"><i></i>In stock</span>';
    const kick = [p.category, p.personalise ? 'Personalised' : isYard(p) ? 'Sold by the yard' : ''].filter(Boolean).join(' · ');
    const askText = `Hello ${d.business || d.store.name}, I'm interested in: ${p.name} (${money(p.price, p.currency)})\n${link(S.ref, { p: p.id })}`;
    const addLabel = pp.added ? 'Added — view cart' : 'Add to cart';
    return `<main class="wrap"><nav class="crumbs" aria-label="Breadcrumb" style="padding-top:20px"><a href="#" data-home>Home</a><span>/</span><a href="#" data-cat="${esc(p.category)}">${esc(p.category)}</a><span>/</span><span>${esc(p.name)}</span></nav>
      <div class="pp">
        <div class="gal">
          ${pics.length > 1 ? `<div class="thumbs">${pics.map((u, i) => `<button type="button" class="${i === pp.img ? 'on' : ''}" data-img="${i}" aria-label="Photo ${i + 1}"><img src="${esc(img(u, 170))}" alt=""></button>`).join('')}</div>` : ''}
          <div class="main-img"><div class="track" id="track">${pics.length ? pics.map((u, i) => `<img src="${esc(img(u, 900))}" alt="${esc(p.name)}${pics.length > 1 ? ', photo ' + (i + 1) : ''}" data-zoom="${i}" ${i ? 'loading="lazy"' : ''}>`).join('') : `<div class="ph">${esc(initials(p.name))}</div>`}</div>
            ${tagsHTML(p).replace('class="tags"', 'class="tags"')}
            ${p.personalise ? `<div class="namebar"><span>Your name will read</span><b id="nameshow">${esc((pp.name || 'YOUR NAME').toUpperCase())}</b></div>` : (pics.length ? `<span class="zoom">${icon('zoom')} Tap to zoom</span>` : '')}
            ${pics.length > 1 ? `<div class="pdots">${pics.map((u, i) => `<span class="${i === pp.img ? 'on' : ''}"></span>`).join('')}</div>` : ''}
          </div></div>
        <div class="info">
          <div style="display:flex;flex-direction:column;gap:10px"><span class="kicker">${esc(kick)}</span><h1>${esc(p.name)}</h1>
            <div class="bigprice"><b>${money(p.price, p.currency)}</b>${p.was > p.price ? `<s>${money(p.was, p.currency)}</s>` : ''}${unitWord(p) ? `<small>${unitWord(p)}</small>` : ''}</div>${avail}</div>
          ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}
          ${p.personalise ? `<div class="fld"><label for="cn">Name to knit in <small>(up to 30 letters)</small></label><input id="cn" data-pp="name" maxlength="30" value="${esc(pp.name)}" placeholder="e.g. SARAH" autocomplete="off"></div>
            <div class="fld"><label for="cc">Colours you want</label><input id="cc" data-pp="colours" maxlength="80" value="${esc(pp.colours)}" placeholder="e.g. purple, peach and cream"></div>` : ''}
          ${out ? '' : `<div class="qtyrow"><span style="font-weight:600">${isYard(p) ? 'How many yards?' : 'Quantity'}</span>
            <div class="stepper"><button type="button" data-q="-1" aria-label="Less">−</button><label for="pq" class="sr">Quantity</label><input id="pq" type="number" inputmode="decimal" min="${p.step}" step="${p.step}" value="${qtyFmt(pp.qty)}"><button type="button" data-q="1" aria-label="More">+</button></div>
            <span style="color:var(--ink-2)">Total <b id="pptotal" style="color:var(--ink);font-size:17px">${money(total, p.currency)}</b></span></div>`}
          ${isYard(p) ? '<div class="tip"><b>Half yards are fine.</b> Not sure how many yards you need? Ask us on WhatsApp and we\'ll help.</div>' : ''}
          ${p.personalise ? '<div class="tip"><b>Ordering for a group?</b> Class, choir or team sets with different names — send the list on WhatsApp and we\'ll quote you.</div>' : ''}
          ${pp.err ? `<div class="err" role="alert">${esc(pp.err)}</div>` : ''}
          <div class="buy">
            ${out ? '' : `<button type="button" class="btn ${pp.added ? 'dark' : 'pri'}" data-addp>${pp.added ? icon('check') : ''}${addLabel}</button>`}
            <a class="btn wa-o" href="${esc(waLink(askText))}" target="_blank" rel="noopener">${icon('chat')} ${out ? 'Ask when it’s back' : 'Ask about this on WhatsApp'}</a>
            <button type="button" class="iconbtn" data-share-product aria-label="Share this product">${icon('share')}</button></div>
          <div class="perks">
            ${o.delivery.length ? `<div class="perk">${icon('truck')}<div><b>Delivery</b>${minFee && minFee.fee ? 'From ' + money(minFee.fee, minFee.currency) + ' — by area' : 'Ask for the fee to your area'}</div></div>` : ''}
            ${o.pickup.length ? `<div class="perk">${icon('pin')}<div><b>Pickup</b>${o.pickup.length === 1 ? esc(o.pickup[0].name) : o.pickup.length + ' places to collect'}</div></div>` : ''}
          </div></div></div>
      ${related.length ? `<section class="sec" style="padding-top:64px"><div class="sec-h"><h2>You may also like</h2></div><div class="grid">${related.map(card).join('')}</div></section>` : ''}
      </main>
      ${out ? '' : `<div class="stickybuy"><div class="tt"><span id="sbq">${qtyFmt(pp.qty)}${isYard(p) ? ' yards' : ' × ' + esc(p.unit || 'item')}</span><b id="sbt">${money(total, p.currency)}</b></div>
        <button type="button" class="btn ${pp.added ? 'dark' : 'pri'}" data-addp>${addLabel}</button></div>`}`;
  }
  function checkoutView() {
    const d = S.data; const c = S.customer;
    const lines = cartLines();
    if (!lines.length) return `<main class="narrow"><div class="empty"><h3>Your cart is empty</h3><p><a href="#" data-home>Start shopping</a></p></div></main>`;
    const del = c.method === 'DELIVERY';
    const opts = del ? d.options.delivery : d.options.pickup;
    const t = totals(c.method, c.optionId);
    const hasD = d.options.delivery.length, hasP = d.options.pickup.length;
    return `<main class="narrow"><a href="#" data-back style="text-decoration:none;font-weight:600;display:inline-flex;gap:6px;align-items:center">${icon('back')} Keep shopping</a>
      <h1>Checkout</h1>
      <section class="card2"><div style="display:flex;justify-content:space-between;align-items:center"><h2>Your order (${lines.length})</h2><a href="#" data-cart>Edit</a></div>
        ${lines.map(({ l, p }) => `<div class="mini">${p.image ? `<img src="${esc(img(p.image, 100))}" alt="">` : '<span class="ph"></span>'}<span>${qtyFmt(l.qty)}${isYard(p) ? ' yd' : ' ×'} ${esc(p.name)}${l.custom ? `<small>${esc(customText(l.custom))}</small>` : ''}</span><b>${money(p.price * l.qty, p.currency)}</b></div>`).join('')}</section>
      <section class="card2"><h2>How do you want it?</h2>
        ${hasD || hasP ? `<div class="seg" role="group" aria-label="Delivery or pickup">
          ${hasD ? `<button type="button" class="${del ? 'on' : ''}" data-method="DELIVERY">Delivery</button>` : ''}
          ${hasP ? `<button type="button" class="${c.method === 'PICKUP' ? 'on' : ''}" data-method="PICKUP">Pickup${d.options.pickup.every((o) => !o.fee) ? ' — free' : ''}</button>` : ''}</div>` : ''}
        ${opts.map((o) => `<button type="button" class="opt${c.optionId === o.id ? ' on' : ''}" data-opt="${esc(o.id)}"><span class="rad"></span><span class="t"><b>${esc(o.name)}</b>${o.details ? `<span>${esc(o.details)}</span>` : ''}</span><b>${del ? (o.fee ? money(o.fee, o.currency) : 'Free') : 'Free'}</b></button>`).join('')}
      </section>
      <section class="card2"><h2>Your details</h2>
        <div class="fld"><label for="f-name">Name</label><input id="f-name" name="name" autocomplete="name" value="${esc(c.name)}" required></div>
        <div class="fld"><label for="f-phone">Phone (WhatsApp)</label><input id="f-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" value="${esc(c.phone)}" placeholder="0777 000 000" required></div>
        ${del ? `<div class="fld"><label for="f-addr">Delivery address or landmark</label><input id="f-addr" name="address" autocomplete="street-address" value="${esc(c.address)}" placeholder="e.g. opposite the Total station"></div>` : ''}
        <div class="fld"><label for="f-note">Note <small>(optional)</small></label><input id="f-note" name="note" value="${esc(c.note)}" placeholder="e.g. call me when you reach"></div>
      </section>
      <section class="card2" style="background:var(--paper);border:0"><div class="sum" id="sum">${sumHTML(t, del)}</div></section>
      ${S.error ? `<div class="err" role="alert" style="margin-bottom:14px">${esc(S.error)}</div>` : ''}
      <button type="button" class="btn wa block send-btn" data-send ${S.sending ? 'disabled' : ''} style="min-height:58px;font-size:17px">${icon('chat')} ${S.sending ? 'Saving your order…' : 'Send order on WhatsApp'}</button>
      <p style="text-align:center;color:var(--ink-2);font-size:14px;line-height:1.5">WhatsApp opens with your order written out. Press send — we reply to confirm and share payment details.</p>
      </main>`;
  }
  function sumHTML(t, del) {
    const rows = [];
    if (t.u || !t.l) rows.push(`<div><span>Items${t.l ? ' in US$' : ''}</span><b>${usd(t.u)}</b></div>`);
    if (t.l) rows.push(`<div><span>Items${t.u ? ' in L$' : ''}</span><b>${lrd(t.l)}</b></div>`);
    if (del) rows.push(`<div><span>Delivery${t.opt ? ' — ' + esc(t.opt.name) : ''}</span><b>${t.opt ? (t.fee ? money(t.fee, t.feeCur) : 'Free') : 'Choose area'}</b></div>`);
    else if (S.customer.method === 'PICKUP') rows.push('<div><span>Pickup</span><b>Free</b></div>');
    rows.push(`<div class="tot"><span style="color:var(--ink);font-weight:700">To pay</span><b>${t.text}</b></div>`);
    if (t.mixed) rows.push(`<span class="note">You can pay all in US$ (about ${usd(t.allUSD)}) or all in L$ (about ${lrd(t.allLRD)}) at today's rate — we confirm the amount on WhatsApp.</span>`);
    return rows.join('');
  }
  const customText = (c) => [c.name ? 'Name: ' + c.name : '', c.colours ? 'Colours: ' + c.colours : ''].filter(Boolean).join(' · ');
  function doneView() {
    const r = S.done;
    if (!r) return home();
    return `<main class="narrow"><div class="done"><span class="tick">${icon('check')}</span><h1>Almost done!</h1>
      <span class="no">Order ${esc(r.orderNo)}</span>
      <p>Your order is saved. Now send it to us on WhatsApp so we can confirm it and tell you how to pay.</p>
      <a class="btn wa block wa-btn" href="${esc(r.whatsappUrl)}" target="_blank" rel="noopener" data-sent style="min-height:58px;font-size:17px">${icon('chat')} Open WhatsApp &amp; send</a>
      <details style="width:100%;text-align:left"><summary style="cursor:pointer;font-weight:600;padding:8px 0">See the message</summary><pre>${esc(r.message)}</pre></details>
      <div class="buy" style="width:100%"><a href="#" class="btn ghost" data-track="${esc(r.orderNo)}">${icon('track')} Track my order</a><a href="#" class="btn ghost" data-home>Continue shopping</a></div>
      </div></main>`;
  }
  const STEPS = [['NEW', 'Order received', 'We have your order'], ['CONFIRMED', 'Confirmed', 'The shop confirmed your order'], ['PAID', 'Paid', 'Payment received — thank you!'], ['DELIVERED', 'Delivered', '']];
  function trackView() {
    const tr = S.track || {}; const r = tr.result;
    const last = keep.get('shop-orders', [])[0] || {};
    let res = '';
    if (r) {
      const at = STEPS.findIndex((s) => s[0] === r.status);
      const steps = r.status === 'CANCELLED'
        ? `<div class="tl cancel"><span class="dot">${icon('x')}</span><div><b>Cancelled</b><span>Message us on WhatsApp if this is a mistake.</span></div></div>`
        : STEPS.map((s, i) => `<div class="tl${i <= at ? ' done' : ''}${i === at ? ' now' : ''}"><span class="dot">${i <= at ? icon('check') : ''}</span><div><b>${s[0] === 'DELIVERED' && r.method === 'PICKUP' ? 'Collected' : s[1]}</b><span>${i === at ? (s[2] || '') + (i === 0 ? ' · ' + new Date(r.createdAt).toLocaleString() : '') : ''}</span></div></div>`).join('');
      res = `<section class="card2"><div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline"><h2>Order ${esc(r.orderNo)}</h2><span style="color:var(--muted);font-size:14px">${esc(r.storeName)}</span></div>
        <div class="timeline">${steps}</div>
        ${r.items.map((l) => `<div class="mini"><span>${qtyFmt(l.qty)} × ${esc(l.name)}${l.custom ? `<small>${esc(customText(l.custom))}</small>` : ''}</span><b>${money(l.total, l.currency)}</b></div>`).join('')}
        <div class="sum"><div class="tot"><span style="color:var(--ink);font-weight:700">Total</span><b>${usd(r.totalUSD)} <span style="font-weight:600;font-size:14px;color:var(--muted)">/ ${lrd(r.totalLRD)}</span></b></div></div>
        ${r.whatsapp ? `<a class="btn wa-o" href="https://wa.me/${esc(r.whatsapp)}?text=${encodeURIComponent('Hello, about my order ' + r.orderNo)}" target="_blank" rel="noopener">${icon('chat')} Ask about this order</a>` : ''}</section>`;
    }
    return `<main class="narrow"><a href="#" data-home style="text-decoration:none;font-weight:600;display:inline-flex;gap:6px;align-items:center">${icon('back')} Shop</a>
      <h1>Track my order</h1>
      <form class="card2" data-trackform>
        <div class="fld"><label for="t-no">Order number</label><input id="t-no" name="orderNo" value="${esc(tr.no || last.no || '')}" placeholder="e.g. ST-01-0042" required autocapitalize="characters"></div>
        <div class="fld"><label for="t-ph">Phone number you ordered with</label><input id="t-ph" name="phone" type="tel" value="${esc(tr.phone || last.phone || S.customer.phone || '')}" required></div>
        ${tr.err ? `<div class="err" role="alert">${esc(tr.err)}</div>` : ''}
        <button class="btn dark" type="submit" ${tr.busy ? 'disabled' : ''}>${tr.busy ? 'Checking…' : 'Check status'}</button></form>${res}</main>`;
  }
  function directory() {
    const d = S.list; const b = d.brand || {};
    return `${announcement()}<header class="head"><div class="wrap row">${logo()}</div></header>
      <main class="wrap"><div class="lp-head" style="padding-top:34px"><span class="kicker">${esc(b.tagline || 'Shop online')}</span><h1>Choose a shop</h1>
        <p style="margin:0;color:var(--ink-2)">${d.productCount} products · order on WhatsApp · delivery or pickup</p></div>
        <div class="dir">${d.shops.map((s) => `<a class="shopcard" href="${esc(link(s.code))}" target="_top"><span class="bar" style="background:${esc(s.color)}"></span><h2>${esc(s.name)}</h2>
          ${s.address ? `<p>${icon('pin')} ${esc(s.address)}</p>` : ''}${s.hours ? `<p>${icon('clock')} ${esc(s.hours)}</p>` : ''}${s.message ? `<p>${esc(s.message)}</p>` : ''}<span class="go">Shop here →</span></a>`).join('')}</div></main>`;
  }

  /* ---------- layers: cart, menu, zoom ---------- */
  function layerHTML() {
    if (S.layer === 'cart') {
      const lines = cartLines(); const t = totals();
      return `<div class="scrim" data-close></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="Your cart">
        <div class="dh"><h2>Your cart <small>(${lines.length})</small></h2><button type="button" class="iconbtn" data-close aria-label="Close">${icon('x')}</button></div>
        <div class="db">${lines.length ? lines.map(({ l, p }) => `<div class="line"><div class="th">${photo(p, 160)}</div>
          <div class="mid"><b>${esc(p.name)}</b>${l.custom ? `<span class="cu">${esc(customText(l.custom))}</span>` : ''}<span class="meta">${money(p.price, p.currency)} ${unitWord(p)}</span>
            <div class="stepper sm"><button type="button" data-lq="${esc(l.key)}" data-d="-1" aria-label="Less">−</button><input type="number" inputmode="decimal" data-lqi="${esc(l.key)}" value="${qtyFmt(l.qty)}" aria-label="Quantity"><button type="button" data-lq="${esc(l.key)}" data-d="1" aria-label="More">+</button></div></div>
          <div class="end">${money(p.price * l.qty, p.currency)}<button type="button" class="rm" data-rm="${esc(l.key)}">Remove</button></div></div>`).join('')
          : `<div class="empty"><h3>Your cart is empty</h3><p>Add something you love.</p></div>`}</div>
        ${lines.length ? `<div class="df"><div class="sum"><div class="tot"><span style="color:var(--ink);font-weight:700">Subtotal</span><b>${t.text}</b></div><span class="note">Delivery fee, if any, is added at checkout.</span></div>
          <button type="button" class="btn pri block" data-act="checkout">Checkout</button></div>` : ''}</aside>`;
    }
    if (S.layer === 'menu') {
      const d = S.data;
      return `<div class="scrim" data-close></div><aside class="drawer left" role="dialog" aria-modal="true" aria-label="Menu">
        <div class="dh">${logo()}<button type="button" class="iconbtn" data-close aria-label="Close" style="margin-left:auto">${icon('x')}</button></div>
        <nav class="db menu">${d.categories.map((c) => `<a href="#" data-cat="${esc(c)}">${esc(c)}</a>`).join('')}
          ${d.products.some((p) => p.was > p.price) ? '<a href="#" data-coll="sale" class="hot">Sale</a>' : ''}
          ${collection('custom').length ? '<a href="#" data-coll="custom">Made for you</a>' : ''}
          <a href="#" data-track>${icon('track')} Track my order</a>
          <a href="${esc(waLink())}" target="_blank" rel="noopener" style="color:var(--wa)">${icon('chat')} Chat on WhatsApp</a>
          ${S.multi ? `<a href="${esc(link('all'))}" target="_top" class="allshops">${icon('store')} All our shops</a>` : ''}</nav></aside>`;
    }
    if (S.layer && S.layer.zoom) {
      return `<div class="lightbox" data-close role="dialog" aria-modal="true" aria-label="Photo"><img src="${esc(img(S.layer.zoom, 1600))}" alt=""><button type="button" class="iconbtn" data-close aria-label="Close">${icon('x')}</button></div>`;
    }
    return '';
  }
  function renderLayer() {
    $('#layer').innerHTML = layerHTML();
    document.body.style.overflow = S.layer ? 'hidden' : '';
    const f = $('#layer [data-close].iconbtn'); if (f) f.focus();
  }

  /* ---------- render ---------- */
  function render() {
    const app = $('#app');
    if (!S.data) { if (S.list) app.innerHTML = directory(); return; }
    const v = S.view.name;
    const body = v === 'list' ? listView() : v === 'product' ? productView() : v === 'checkout' ? checkoutView() : v === 'done' ? doneView() : v === 'track' ? trackView() : home();
    const t = totals();
    const showBar = t.count && (v === 'home' || v === 'list');
    app.innerHTML = announcement() + header() + body + (v === 'checkout' || v === 'done' ? '' : footer()) +
      (v === 'product' || v === 'checkout' || v === 'done' ? '' : `<a class="fab${showBar ? ' up' : ''}" href="${esc(waLink())}" target="_blank" rel="noopener" aria-label="Chat with us on WhatsApp">${icon('chat')}</a>`) +
      `<button type="button" class="cartbar${showBar ? ' show' : ''}" data-cart><span class="n">${t.count}</span><span class="t">View cart</span><span>${t.text}</span></button>`;
    document.body.classList.toggle('has-sticky', v === 'product');
    const title = v === 'product' && product(S.view.id) ? product(S.view.id).name + ' — ' : '';
    document.title = title + (S.data.business || S.data.store.name) + ' — order on WhatsApp';
    renderLayer();
    wireScroll();
  }
  function wireScroll() {
    const sl = $('#slides');
    if (sl) sl.onscroll = () => { const i = Math.round(sl.scrollLeft / sl.clientWidth); if (i !== S.slide) { S.slide = i; $$('.dots button').forEach((b, k) => b.classList.toggle('on', k === i)); } };
    const tr = $('#track');
    if (tr) tr.onscroll = () => { const i = Math.round(tr.scrollLeft / tr.clientWidth); if (S.pp && i !== S.pp.img) { S.pp.img = i; $$('.pdots span').forEach((b, k) => b.classList.toggle('on', k === i)); $$('.thumbs button').forEach((b, k) => b.classList.toggle('on', k === i)); } };
  }
  let autoplay = null;
  function startAutoplay() {
    clearInterval(autoplay);
    autoplay = setInterval(() => {
      const sl = $('#slides'); if (!sl || S.layer || document.hidden) return;
      const n = sl.children.length; if (n < 2) return;
      sl.scrollTo({ left: ((S.slide + 1) % n) * sl.clientWidth, behavior: 'smooth' });
    }, 6000);
  }
  function toast(msg, act) {
    $$('.toast').forEach((t) => t.remove());
    const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status');
    t.innerHTML = icon('check') + esc(msg) + (act ? ` <a href="#" data-cart style="color:#7dd3fc;margin-left:6px">${esc(act)}</a>` : '');
    document.body.appendChild(t); setTimeout(() => t.remove(), 2600);
  }
  function updateProductTotals() {
    const p = product(S.view.id); if (!p) return;
    const tt = money(p.price * S.pp.qty, p.currency);
    const a = $('#pptotal'); if (a) a.textContent = tt;
    const b = $('#sbt'); if (b) b.textContent = tt;
    const c = $('#sbq'); if (c) c.textContent = qtyFmt(S.pp.qty) + (isYard(p) ? ' yards' : ' × ' + (p.unit || 'item'));
  }

  /* ---------- events ---------- */
  document.addEventListener('click', (e) => {
    const t = e.target.closest('a, button, [data-close]');
    if (!t) return;
    const ds = t.dataset;
    const href = t.getAttribute('href');
    if (t.tagName === 'A' && href && href !== '#') { if ('sent' in ds) afterSent(); return; } // real links (WhatsApp, other shops, social)
    if (t.type === 'submit') return; // forms handle their own submit
    if (t.tagName === 'A' || t.tagName === 'BUTTON') e.preventDefault();
    if ('close' in ds) { if (t.classList.contains('lightbox') && e.target.tagName === 'IMG') return; S.layer = null; renderLayer(); return; }
    if ('add' in ds) {
      e.stopPropagation();
      const p = product(ds.add);
      if (p.personalise) { go({ name: 'product', id: p.id }); return; }
      addToCart(p, p.step); render(); toast('Added to cart', 'View cart'); return;
    }
    if ('pid' in ds) { go({ name: 'product', id: ds.pid }); return; }
    if ('home' in ds) { go({ name: 'home' }); return; }
    if ('cat' in ds) { go({ name: 'list', cat: ds.cat }); return; }
    if ('coll' in ds) { go({ name: 'list', coll: ds.coll }); return; }
    if ('banner' in ds) {
      const l = ds.banner;
      if (/^https?:\/\//.test(l)) { window.open(l, '_blank', 'noopener'); return; }
      if (product(l)) { go({ name: 'product', id: l }); return; }
      if (S.data.categories.indexOf(l) >= 0) { go({ name: 'list', cat: l }); return; }
      if (COLL[l]) { go({ name: 'list', coll: l }); return; }
      go({ name: 'list', coll: 'all', q: l || '' }); return;
    }
    if ('slide' in ds) { const sl = $('#slides'); sl.scrollTo({ left: Number(ds.slide) * sl.clientWidth, behavior: 'smooth' }); startAutoplay(); return; }
    if ('fcat' in ds) { S.view = Object.assign({}, S.view, { cat: ds.fcat || '' }); render(); return; }
    if ('menu' in ds) { S.layer = 'menu'; renderLayer(); return; }
    if ('cart' in ds) { S.layer = 'cart'; renderLayer(); return; }
    if ('back' in ds) { history.length > 1 ? history.back() : go({ name: 'home' }); return; }
    if (ds.act === 'checkout') { if (!S.customer.method) defaultMethod(); go({ name: 'checkout' }); return; }
    if ('track' in ds) { S.track = { no: ds.track || '', phone: S.customer.phone || '' }; go({ name: 'track' }); return; }
    if ('img' in ds) { S.pp.img = Number(ds.img); const tr = $('#track'); tr.scrollTo({ left: S.pp.img * tr.clientWidth, behavior: 'smooth' }); $$('.thumbs button').forEach((b, k) => b.classList.toggle('on', k === S.pp.img)); return; }
    if ('q' in ds) {
      const p = product(S.view.id); S.pp.qty = Math.max(p.step, Math.round((S.pp.qty + Number(ds.q) * p.step) * 100) / 100); S.pp.added = false;
      $('#pq').value = qtyFmt(S.pp.qty); updateProductTotals(); return;
    }
    if ('addp' in ds) {
      if (S.pp.added) { S.layer = 'cart'; renderLayer(); return; }
      const p = product(S.view.id);
      let custom = null;
      if (p.personalise) {
        const n = S.pp.name.trim(), c = S.pp.colours.trim();
        if (!n && !c) { S.pp.err = 'Please type the name and colours you want.'; render(); const f = $('#cn'); if (f) f.focus(); return; }
        custom = { name: n.toUpperCase(), colours: c };
      }
      addToCart(p, S.pp.qty, custom); S.pp.added = true; S.pp.err = ''; render(); toast('Added to cart', 'View cart'); return;
    }
    if ('shareProduct' in ds) { const p = product(S.view.id); share(p.name, p.name + ' — ' + money(p.price, p.currency), link(S.ref, { p: p.id })); return; }
    if ('shareShop' in ds) { share(S.data.business || S.data.store.name, 'Shop ' + (S.data.business || S.data.store.name) + ' online — order on WhatsApp', link(S.ref)); return; }
    if ('lq' in ds) {
      const l = S.cart.find((c) => c.key === ds.lq); const p = product(l.id);
      l.qty = Math.round((l.qty + Number(ds.d) * p.step) * 100) / 100;
      if (l.qty <= 0) S.cart = S.cart.filter((c) => c !== l);
      saveCart(); render(); return;
    }
    if ('rm' in ds) { S.cart = S.cart.filter((c) => c.key !== ds.rm); saveCart(); render(); return; }
    if ('method' in ds) { S.customer.method = ds.method; S.customer.optionId = ''; defaultOption(); saveCustomer(); render(); return; }
    if ('opt' in ds) { S.customer.optionId = ds.opt; saveCustomer(); render(); return; }
    if ('send' in ds) { send(); return; }
    if ('zoom' in ds) { const p = product(S.view.id); const pics = [p.image].concat(p.images || []).filter(Boolean); S.layer = { zoom: pics[Number(ds.zoom)] }; renderLayer(); return; }
  });
  document.addEventListener('click', (e) => { const z = e.target.closest('[data-zoom]'); if (z) { const p = product(S.view.id); const pics = [p.image].concat(p.images || []).filter(Boolean); S.layer = { zoom: pics[Number(z.dataset.zoom)] }; renderLayer(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.layer) { S.layer = null; renderLayer(); } });
  document.addEventListener('submit', (e) => {
    e.preventDefault();
    if (e.target.matches('[data-search]')) { const q = $('#q').value.trim(); go({ name: 'list', q }); return; }
    if (e.target.matches('[data-trackform]')) { doTrack(e.target.orderNo.value, e.target.phone.value); }
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.pp) { S.pp[t.dataset.pp] = t.value; S.pp.added = false; S.pp.err = ''; if (t.dataset.pp === 'name') { const s = $('#nameshow'); if (s) s.textContent = (t.value.trim() || 'YOUR NAME').toUpperCase(); } return; }
    if (t.id === 'pq') { const p = product(S.view.id); const v = num(t.value); if (v > 0) { S.pp.qty = v; S.pp.added = false; updateProductTotals(); } return; }
    if (t.dataset.lqi) { const l = S.cart.find((c) => c.key === t.dataset.lqi); const v = num(t.value); if (l && v > 0) { l.qty = v; saveCart(); } return; }
    if (S.view.name === 'checkout' && t.name && ['name', 'phone', 'address', 'note'].indexOf(t.name) >= 0) { S.customer[t.name] = t.value; saveCustomer(); }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.sort !== undefined) { S.view = Object.assign({}, S.view, { sort: t.value }); render(); return; }
    if (t.dataset.f) { S.view = Object.assign({}, S.view, { [t.dataset.f]: t.checked }); render(); return; }
    if (t.dataset.lqi) { render(); }
  });

  function saveCustomer() { keep.set('shop-customer', S.customer); }
  function defaultMethod() {
    const o = S.data.options;
    if (!S.customer.method || (S.customer.method === 'DELIVERY' && !o.delivery.length) || (S.customer.method === 'PICKUP' && !o.pickup.length)) {
      S.customer.method = o.delivery.length ? 'DELIVERY' : 'PICKUP';
    }
    defaultOption();
  }
  function defaultOption() {
    const opts = S.customer.method === 'DELIVERY' ? S.data.options.delivery : S.data.options.pickup;
    if (!opts.some((o) => o.id === S.customer.optionId)) S.customer.optionId = opts.length === 1 ? opts[0].id : '';
  }
  async function send() {
    const c = S.customer; const d = S.data;
    const opts = c.method === 'DELIVERY' ? d.options.delivery : d.options.pickup;
    const fail = (m) => { S.error = m; render(); const el = $('.err'); if (el) el.scrollIntoView({ block: 'center' }); };
    if (!String(c.name || '').trim()) return fail('Please enter your name.');
    if (String(c.phone || '').replace(/\D/g, '').length < 7) return fail('Please enter a phone number we can reach you on.');
    if (opts.length && !opts.some((o) => o.id === c.optionId)) return fail(c.method === 'DELIVERY' ? 'Please choose your delivery area.' : 'Please choose where you will pick up.');
    if (c.method === 'DELIVERY' && !String(c.address || '').trim()) return fail('Please give the delivery address or a landmark.');
    S.sending = true; S.error = ''; render();
    try {
      S.orderRef = S.orderRef || uuid();
      const r = await call('shopOrder', { store: S.ref, clientRef: S.orderRef, name: c.name, phone: c.phone, method: c.method, optionId: c.optionId,
        address: c.address, note: c.note, items: cartLines().map(({ l }) => ({ id: l.id, qty: l.qty, custom: l.custom || undefined })) });
      S.done = r; S.orderRef = null;
      const hist = keep.get('shop-orders', []); hist.unshift({ no: r.orderNo, phone: c.phone, at: Date.now() }); keep.set('shop-orders', hist.slice(0, 10));
      S.cart = []; saveCart();
      S.sending = false; go({ name: 'done' }, true);
    } catch (err) {
      S.sending = false; fail(err.message);
    }
  }
  function afterSent() { /* the WhatsApp link opened; nothing else to do — the cart is already empty */ }
  async function doTrack(no, phone) {
    S.track = { no, phone, busy: true }; render();
    try { const r = await call('shopTrack', { orderNo: no, phone }); S.track = { no, phone, result: r }; }
    catch (err) { S.track = { no, phone, err: err.message }; }
    render();
  }

  /* ---------- start ---------- */
  async function boot() {
    try {
      const prm = await params();
      const asked = String(prm.shop || '').trim();
      S.ref = asked && asked.toLowerCase() !== 'all' ? asked : (asked ? '' : CFG.store || '');
      if (!S.ref) {
        const l = await call('shopList', {});
        S.list = l; S.links = l.links; theme(l.color);
        if (l.shops.length === 1) S.ref = l.shops[0].code;
        else if (!l.shops.length) { $('#app').innerHTML = '<div class="empty"><h3>The online shop is closed right now</h3><p>Please check back soon.</p></div>'; return; }
        else { theme((l.brand && l.brand.color) || l.color); render(); return; }
      }
      S.multi = true;
      const cacheKey = 'shop-cat:' + S.ref.toUpperCase();
      const cached = keep.get(cacheKey, null);
      const start = (d) => {
        S.data = d; S.links = d.links; theme(d.store.color);
        S.cart = keep.get('shop-cart:' + S.ref, []).filter((l) => product(l.id)).map((l) => Object.assign({ key: l.id + '|' }, l));
        S.customer = Object.assign({ name: '', phone: '', method: '', optionId: '', address: '', note: '' }, keep.get('shop-customer', {}));
      };
      let view = { name: 'home' };
      if (prm.track) { view = { name: 'track' }; S.track = { no: prm.track }; }
      if (cached) { start(cached); S.view = prm.p && product(prm.p) ? { name: 'product', id: prm.p } : view; if (S.view.name === 'product') go(S.view, true); else render(); }
      try {
        const fresh = await call('shopCatalog', { store: S.ref });
        keep.set(cacheKey, fresh);
        const firstPaint = !S.data;
        start(fresh); S.offline = false;
        if (firstPaint) { S.view = prm.p && product(prm.p) ? { name: 'product', id: prm.p } : view; go(S.view, true); }
        else if (S.view.name !== 'checkout') render();
      } catch (err) {
        if (!S.data) throw err;
        S.offline = true; render();
      }
      startAutoplay();
      try { const l = await call('shopList', {}); S.multi = l.shops.length > 1; S.list = l; if (!S.multi) render(); } catch (e) { S.multi = false; }
    } catch (err) {
      $('#app').innerHTML = `<div class="empty wrap"><h3>${esc(err.code === 'SHOP_CLOSED' ? 'This shop is not taking online orders right now' : 'Could not open the shop')}</h3><p>${esc(err.message)}</p>
        <p><button class="btn dark" onclick="location.reload()">Try again</button></p></div>`;
    }
  }
  boot();
})();
