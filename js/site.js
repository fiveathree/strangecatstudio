// 奇怪貓工作室 — light/black theme switch and product option controls.
(function () {
  var root = document.documentElement;

  function isDark() {
    return root.getAttribute('data-theme') === 'dark';
  }

  function syncToggle() {
    var dark = isDark();
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
      var label = dark ? '切換至淺色版本' : '切換至黑色版本';
      btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    });
  }

  document.querySelectorAll('.theme-toggle').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var next = isDark() ? 'light' : 'dark';
      if (next === 'dark') root.setAttribute('data-theme', 'dark');
      else root.removeAttribute('data-theme');
      // Remembered so the choice follows the visitor from page to page.
      try { localStorage.setItem('ssc-theme', next); } catch (e) {}
      syncToggle();
    });
  });
  syncToggle();

  // Chinese line breaking. Browsers may break a Chinese sentence after any
  // character, which on a phone leaves stray single characters. Wrapping each
  // clause (text up to its punctuation mark) in an inline-block makes a line
  // break fall between clauses whenever the clause fits on one line.
  (function keepClausesTogether() {
    var SKIP = { SCRIPT: 1, STYLE: 1, NAV: 1, BUTTON: 1, SELECT: 1, OPTION: 1, TEXTAREA: 1, INPUT: 1, VIDEO: 1, SVG: 1 };
    var CLAUSE = /[^，。；：！？、／]+[，。；：！？、／」）]*/g;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (node) {
      var text = node.nodeValue;
      if (text.trim().length < 8 || !/[，。；：！？、／]/.test(text)) return;
      for (var el = node.parentNode; el && el !== document.body; el = el.parentNode) {
        if (SKIP[el.tagName.toUpperCase()] || (el.classList && el.classList.contains('nw'))) return;
      }
      var parts = text.match(CLAUSE);
      if (!parts || parts.length < 2) return;
      var frag = document.createDocumentFragment();
      parts.forEach(function (part) {
        var span = document.createElement('span');
        span.className = 'clause';
        span.textContent = part;
        frag.appendChild(span);
      });
      node.parentNode.replaceChild(frag, node);
    });
  })();

  // Homepage menu: transparent over the film, solid once scrolled past it.
  var header = document.querySelector('.home .site-header');
  var hero = document.querySelector('.hero');
  if (header && hero) {
    var syncHeader = function () {
      var past = window.scrollY > hero.offsetHeight - header.offsetHeight;
      header.classList.toggle('is-solid', past);
    };
    window.addEventListener('scroll', syncHeader, { passive: true });
    window.addEventListener('resize', syncHeader);
    syncHeader();
  }

  // Homepage video. It opens on black, so the still photo is only used when
  // the film cannot or should not play: reduced-motion, or a load failure.
  var heroVideo = document.querySelector('.hero-video');
  if (heroVideo) {
    var showStill = function () { heroVideo.poster = 'assets/galaxy.jpg'; };
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) {
      heroVideo.removeAttribute('autoplay');
      heroVideo.pause();
      showStill();
    }
    heroVideo.addEventListener('error', showStill, true);
  }

  // Product page: single-choice option groups, swatches and the plating add-on.
  var BASE_PRICE = 3980;
  var PLATING_PRICE = 900;
  var plating = document.getElementById('plating');
  var colorBox = document.getElementById('color-box');
  var colorName = document.getElementById('color-name');

  function updatePrice() {
    var price = BASE_PRICE + (plating && plating.checked ? PLATING_PRICE : 0);
    document.querySelectorAll('.js-price').forEach(function (el) {
      el.textContent = price.toLocaleString('en-US');
    });
  }

  document.querySelectorAll('[data-group]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var group = btn.getAttribute('data-group');
      document.querySelectorAll('[data-group="' + group + '"]').forEach(function (other) {
        other.setAttribute('aria-pressed', other === btn ? 'true' : 'false');
      });
      if (group === 'mode' && colorBox) {
        colorBox.hidden = btn.getAttribute('data-value') !== 'self';
      }
      if (group === 'color' && colorName) {
        colorName.textContent = btn.getAttribute('data-value');
      }
      refresh();
    });
  });

  function pressed(group) {
    return document.querySelector('[data-group="' + group + '"][aria-pressed="true"]');
  }

  // Blocks marked data-show-group / data-show-value are only visible while
  // that option is the chosen one in its group (e.g. settings for "ring").
  function refresh() {
    document.querySelectorAll('[data-show-group]').forEach(function (el) {
      var cur = pressed(el.getAttribute('data-show-group'));
      el.hidden = !cur || cur.getAttribute('data-value') !== el.getAttribute('data-show-value');
    });
    // A choice hidden by the step above no longer applies: fall back to the
    // first visible option in the same group.
    var groups = {};
    document.querySelectorAll('[data-group]').forEach(function (b) { groups[b.getAttribute('data-group')] = true; });
    Object.keys(groups).forEach(function (g) {
      var cur = pressed(g);
      if (cur && cur.offsetParent !== null) return;
      var all = document.querySelectorAll('[data-group="' + g + '"]');
      var first = null;
      all.forEach(function (b) { if (!first && b.closest('[hidden]') === null) first = b; });
      if (!first) return;
      // Only re-point groups whose options sit in show/hide blocks.
      if (!first.closest('[data-show-group]') && !(cur && cur.closest('[data-show-group]'))) return;
      all.forEach(function (b) { b.setAttribute('aria-pressed', b === first ? 'true' : 'false'); });
    });
    document.querySelectorAll('[data-sum]').forEach(function (el) {
      var cur = pressed(el.getAttribute('data-sum'));
      if (cur) el.textContent = cur.getAttribute('data-label') || cur.textContent;
    });
  }

  // Builder: step tabs and "next" buttons.
  function goStep(n) {
    document.querySelectorAll('.step-panel').forEach(function (p) {
      p.hidden = p.getAttribute('data-panel') !== String(n);
    });
    document.querySelectorAll('.step-tab').forEach(function (tab) {
      tab.setAttribute('aria-pressed', tab.getAttribute('data-step') === String(n) ? 'true' : 'false');
    });
    refresh();
  }
  document.querySelectorAll('.step-tab').forEach(function (tab) {
    tab.addEventListener('click', function () { goStep(tab.getAttribute('data-step')); });
  });
  document.querySelectorAll('.step-next').forEach(function (btn) {
    btn.addEventListener('click', function () {
      goStep(btn.getAttribute('data-go'));
      var bar = document.querySelector('.steps-bar');
      if (bar) bar.scrollIntoView({ block: 'start' });
    });
  });
  var engrave = document.getElementById('engrave');
  var engraveOut = document.getElementById('engrave-out');
  if (engrave && engraveOut) {
    engrave.addEventListener('input', function () {
      engraveOut.textContent = engrave.value.trim() || '未填';
    });
  }
  if (document.querySelector('.step-panel')) refresh();

  // Shop: filter chips. One choice per filter; an empty value means "all".
  var grid = document.getElementById('product-grid');
  if (grid) {
    var applyFilters = function () {
      var want = {};
      document.querySelectorAll('.chip[data-filter][aria-pressed="true"]').forEach(function (c) {
        want[c.getAttribute('data-filter')] = c.getAttribute('data-value');
      });
      var shown = 0;
      grid.querySelectorAll('.p-card').forEach(function (card) {
        var ok = Object.keys(want).every(function (k) {
          return !want[k] || card.getAttribute('data-' + k) === want[k];
        });
        card.hidden = !ok;
        if (ok) shown += 1;
      });
      document.getElementById('result-count').textContent = shown;
      document.getElementById('no-result').hidden = shown !== 0;
    };
    var setFilter = function (name, value) {
      document.querySelectorAll('.chip[data-filter="' + name + '"]').forEach(function (c) {
        c.setAttribute('aria-pressed', c.getAttribute('data-value') === value ? 'true' : 'false');
      });
    };
    document.querySelectorAll('.chip[data-filter]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        setFilter(chip.getAttribute('data-filter'), chip.getAttribute('data-value'));
        applyFilters();
      });
    });
    // The catalogue comes from the studio's back office. The cards written into the
    // page stay as they are if the API cannot be reached.
    var STONE_NAME = { glass: '玻璃鑽石', lab: '實驗室鑽石', cosmic: '宇宙玻璃', crystal: '水晶鍊', glassware: '玻璃飾品' };
    var span = function (cls, text) {
      var el = document.createElement('span');
      el.className = cls;
      el.textContent = text;
      return el;
    };
    var productCard = function (p) {
      // The card is a box holding a link (photo and text) and, for pieces that can be
      // bought online, an add-to-cart button.
      var card = document.createElement('div');
      var a = document.createElement('a');
      var soldout = p.status === 'soldout';
      card.className = 'p-card' + (soldout ? ' is-soldout' : '');
      a.className = 'p-link';
      a.href = p.link || 'visit.html';
      if (/^https:/.test(a.getAttribute('href'))) { a.target = '_blank'; a.rel = 'noopener'; }
      card.setAttribute('data-stone', p.stone);
      card.setAttribute('data-cat', p.cat);
      card.setAttribute('data-supply', p.supply);
      if (p.image) {
        var img = document.createElement('img');
        img.loading = 'lazy';
        img.src = p.image;
        img.alt = p.name;
        a.appendChild(img);
      } else {
        a.appendChild(span('ph', '[產品相片]'));
      }
      var meta = span('p-meta', '');
      meta.appendChild(soldout ? span('badge badge-soldout', '已售完')
        : span('badge' + (p.supply === 'made' ? ' badge-premium' : ''), p.supply === 'made' ? '手工訂製' : '現貨'));
      meta.appendChild(span('p-stone', STONE_NAME[p.stone] || ''));
      a.appendChild(meta);
      a.appendChild(span('p-name', p.name));
      if (p.note) a.appendChild(span('p-note', p.note));
      a.appendChild(span('p-price', p.price == null ? '價錢請洽詢' : 'NT$' + Number(p.price).toLocaleString('en-US') + (p.priceFrom ? ' 起' : '')));
      card.appendChild(a);
      if (p.buyable && window.sscCart) {
        var buy = document.createElement('button');
        buy.type = 'button';
        buy.className = 'p-buy';
        buy.textContent = '加入購物車';
        buy.addEventListener('click', function () {
          window.sscCart.add(p.id, p.stock == null ? null : p.stock, p);
          buy.textContent = '已加入 ✓';
          setTimeout(function () { buy.textContent = '加入購物車'; }, 1400);
        });
        card.appendChild(buy);
      }
      return card;
    };
    if (window.SSC_API) {
      fetch(window.SSC_API + '/api/products').then(function (res) {
        if (!res.ok) throw new Error('catalogue unavailable');
        return res.json();
      }).then(function (data) {
        if (!data.products || !data.products.length) return;
        // Filter buttons follow the categories the studio keeps in the back office,
        // leaving out any that have nothing to show.
        var chipRow = function (filter, items, allLabel) {
          var first = document.querySelector('.chip[data-filter="' + filter + '"]');
          if (!first || !items || !items.length) return;
          var row = first.parentNode;
          var current = (row.querySelector('[aria-pressed="true"]') || first).getAttribute('data-value');
          row.textContent = '';
          [{ slug: '', name: allLabel }].concat(items.filter(function (c) {
            return data.products.some(function (p) { return p[filter] === c.slug; });
          })).forEach(function (c) {
            var chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'chip';
            chip.textContent = c.name;
            chip.setAttribute('data-filter', filter);
            chip.setAttribute('data-value', c.slug);
            chip.setAttribute('aria-pressed', c.slug === current ? 'true' : 'false');
            chip.addEventListener('click', function () { setFilter(filter, c.slug); applyFilters(); });
            row.appendChild(chip);
          });
          if (!row.querySelector('[aria-pressed="true"]')) row.firstChild.setAttribute('aria-pressed', 'true');
        };
        if (data.categories) {
          data.categories.stone.forEach(function (c) { STONE_NAME[c.slug] = c.name; });
          chipRow('stone', data.categories.stone, '全部主石');
          chipRow('cat', data.categories.cat, '全部');
        }
        grid.textContent = '';
        data.products.forEach(function (p) { grid.appendChild(productCard(p)); });
        // Tell search engines what is for sale (name, photo, price, in stock or not).
        var listed = data.products.filter(function (p) { return p.price != null; }).map(function (p, i) {
          var item = { '@type': 'Product', name: p.name, description: p.note || p.name, brand: { '@type': 'Brand', name: '奇怪貓工作室' },
            offers: { '@type': 'Offer', priceCurrency: 'TWD', price: p.price, url: window.location.href.split('?')[0],
              availability: 'https://schema.org/' + (p.status === 'soldout' ? 'OutOfStock' : p.supply === 'made' ? 'MadeToOrder' : 'InStock') } };
          if (p.image) item.image = new URL(p.image, window.location.href).href;
          return { '@type': 'ListItem', position: i + 1, item: item };
        });
        if (listed.length) {
          var ld = document.createElement('script');
          ld.type = 'application/ld+json';
          ld.textContent = JSON.stringify({ '@context': 'https://schema.org', '@type': 'ItemList', itemListElement: listed });
          document.head.appendChild(ld);
        }
        applyFilters();
      }).catch(function () {});
    }
    // Links such as shop.html?stone=glass open with that stone pre-selected.
    var m = /[?&]stone=([\w-]+)/.exec(window.location.search);
    if (m) setFilter('stone', m[1]);
    applyFilters();
  }

  // Booking: Calendly's inline calendar, coloured to match the current theme.
  // Only used until the site's own booking API is switched on in js/config.js.
  var cal = document.getElementById('calendly');
  if (cal && !window.SSC_API) {
    var dark = isDark();
    var url = cal.getAttribute('data-url') + '?hide_gdpr_banner=1' +
      '&background_color=' + (dark ? '1c1c20' : 'ffffff') +
      '&text_color=' + (dark ? 'f3efe7' : '141b2d') +
      '&primary_color=' + (dark ? 'eeb58a' : '5e3418');
    cal.className = 'calendly-inline-widget';
    cal.setAttribute('data-url', url);
    var tag = document.createElement('script');
    tag.src = 'https://assets.calendly.com/assets/external/widget.js';
    tag.async = true;
    document.body.appendChild(tag);
  }

  if (plating) {
    plating.addEventListener('change', updatePrice);
    updatePrice();
  }
})();
