// 奇怪貓工作室 — light/black theme switch and product option controls.
(function () {
  var root = document.documentElement;

  function isDark() {
    return root.getAttribute('data-theme') === 'dark';
  }

  function syncToggle() {
    var dark = isDark();
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
      btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
      var label = btn.querySelector('.theme-toggle-label');
      if (label) label.textContent = dark ? '淺色版' : '黑色版';
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
    });
  });

  if (plating) {
    plating.addEventListener('change', updatePrice);
    updatePrice();
  }
})();
