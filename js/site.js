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
    // Links such as shop.html?stone=glass open with that stone pre-selected.
    var m = /[?&]stone=(glass|lab|cosmic)/.exec(window.location.search);
    if (m) setFilter('stone', m[1]);
    applyFilters();
  }

  if (plating) {
    plating.addEventListener('change', updatePrice);
    updatePrice();
  }
})();
