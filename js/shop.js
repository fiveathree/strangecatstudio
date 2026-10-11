// Cart (kept in this browser), the checkout page and order look-up.
(function () {
  var API = window.SSC_API;
  var KEY = 'ssc-cart';
  var $ = function (id) { return document.getElementById(id); };
  var money = function (n) { return 'NT$' + Number(n).toLocaleString('en-US'); };
  var STATUS = { pending: '待匯款', reported: '已回報末五碼，待工作室確認', paid: '已收款，準備出貨', shipped: '已出貨／可取貨', done: '已完成', cancelled: '已取消' };

  // The cart is { key: quantity }, where key is the product id, plus the chosen options
  // when the product has any: "12" or "12|戒圍:11、顏色:藍". Storage can be unavailable
  // (private windows), in which case the cart simply lasts until the page is closed.
  var idOf = function (key) { return String(key).split('|')[0]; };
  var optionsOf = function (key) { return String(key).split('|')[1] || ''; };
  // How many of one product are in the cart across all its option choices.
  var inCart = function (cart, id) {
    return Object.keys(cart).reduce(function (sum, k) { return sum + (idOf(k) === String(id) ? cart[k] : 0); }, 0);
  };
  var memory = {};
  function read() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return memory; }
  }
  function write(cart) {
    memory = cart;
    try { localStorage.setItem(KEY, JSON.stringify(cart)); } catch (e) {}
    badge();
  }
  function count() {
    var cart = read();
    return Object.keys(cart).reduce(function (sum, id) { return sum + cart[id]; }, 0);
  }
  function badge() {
    var pill = $('cart-pill');
    if (!pill) return;
    $('cart-count').textContent = count();
    pill.hidden = count() === 0;
  }

  window.sscCart = {
    // `stock` is how many are left (null when the studio doesn't count them).
    // `options` is the chosen options as text ("戒圍:11、顏色:藍"), empty when the product has none.
    // Returns false when no more can be added (the last piece is already in the cart).
    add: function (id, stock, item, options) {
      var cart = read();
      if (stock != null && inCart(cart, id) >= stock) return false;
      if (window.sscTrack && item) window.sscTrack('add_to_cart', { currency: 'TWD', value: item.priceNow, items: [{ item_id: String(id), item_name: item.name, price: item.priceNow, quantity: 1 }] });
      var key = options ? id + '|' + options : String(id);
      cart[key] = (cart[key] || 0) + 1;
      write(cart);
      return true;
    },
  };
  badge();

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function post(path, body) {
    return fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) { var err = new Error(data.error || '發生錯誤，請稍後再試'); err.data = data; throw err; }
          return data;
        });
      });
  }

  function orderLines(items) {
    var ul = el('ul', 'cart-lines');
    items.forEach(function (it) { ul.appendChild(el('li', '', it.name + (it.options ? '（' + it.options + '）' : '') + ' × ' + it.qty + '　' + money(it.price * it.qty))); });
    return ul;
  }

  // Shown after ordering and from the look-up: where to pay, and the last-five-digits form.
  function payForm(code, phone, onDone) {
    var form = el('form', 'bk-pay');
    var input = el('input');
    input.type = 'text'; input.inputMode = 'numeric'; input.maxLength = 5; input.placeholder = '末五碼';
    input.setAttribute('aria-label', '匯款帳號末五碼');
    var button = el('button', 'bk-submit', '回報匯款');
    button.type = 'submit';
    var error = el('p', 'bk-error');
    error.hidden = true;
    form.appendChild(input); form.appendChild(button);
    var box = el('div');
    box.appendChild(form); box.appendChild(error);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      error.hidden = true;
      button.disabled = true;
      post('/api/orders/payment', { code: code, phone: phone, last5: input.value.trim() }).then(function () {
        box.textContent = '';
        box.appendChild(el('p', '', '已收到你的回報，工作室核對後會出貨並通知你。'));
        if (onDone) onDone();
      }).catch(function (err) { error.textContent = err.message; error.hidden = false; button.disabled = false; });
    });
    return box;
  }

  function bankLine(info) {
    info = info || window.SSC_BANK_INFO;
    return el('p', '', info ? '請匯款至：' + info : '請加入官方 LINE（' + window.SSC_LINE_ID + '）取得匯款資料。');
  }

  // ---- Checkout page ----
  var form = $('cart-form');
  if (form && API) {
    var products = {};
    var shipping = {};
    var maxQty = 10;
    var method = null;
    var rules = { earnPer: 0, pointValue: 1 }; // loyalty points, from the API
    var have = null;       // points this customer can spend, once they have proved who they are
    var pointsCode = '';   // the past order code that proved it
    var freeOver = 0;      // goods total that earns free shipping; 0 = never
    var promo = null;      // the promo code in use: { code, kind, value, minSpend }

    var show = function (which) {
      $('cart-loading').hidden = true;
      $('cart-empty').hidden = which !== 'empty';
      form.hidden = which !== 'form';
      $('cart-done').hidden = which !== 'done';
    };

    var render = function () {
      var cart = read();
      var ids = Object.keys(cart);
      if (!ids.length) { show('empty'); return; }
      var list = $('cart-items');
      list.textContent = '';
      var subtotal = 0;
      var blocked = false;
      ids.forEach(function (key) {
        var p = products[idOf(key)];
        var chosen = optionsOf(key);
        var row = el('div', 'cart-item');
        if (p && p.image) { var img = el('img'); img.src = p.image; img.alt = ''; row.appendChild(img); }
        else row.appendChild(el('span', 'ph', '相片'));
        row.appendChild(el('span', 'cart-item-name', (p ? p.name : '這件貨品已下架') + (chosen ? '（' + chosen + '）' : '')));
        // Stock is shared by every option of a product, so the limit counts them together.
        var limit = p && p.buyable ? Math.min(maxQty, p.stock == null ? maxQty : p.stock) : 0;
        var total = inCart(cart, idOf(key));
        // A product that has gained options since it went in the cart needs choosing again.
        var needsOptions = p && p.options.length && chosen.split('、').length !== p.options.length;
        var problem = !p || !p.buyable ? '目前無法訂購，請移除' : needsOptions ? '請移除後到貨品頁重新選擇規格' : total > limit ? '只剩 ' + limit + ' 件，請調整數量' : '';
        if (problem) blocked = true;
        row.appendChild(el('span', 'cart-item-price', p && p.priceNow != null ? money(p.priceNow * cart[key]) : ''));
        var qty = el('span', 'cart-qty');
        var minus = el('button', '', '−'); minus.type = 'button'; minus.setAttribute('aria-label', '減少一件');
        var plus = el('button', '', '＋'); plus.type = 'button'; plus.setAttribute('aria-label', '增加一件');
        plus.disabled = total >= limit;
        minus.addEventListener('click', function () { var c = read(); c[key] -= 1; if (c[key] < 1) delete c[key]; write(c); render(); });
        plus.addEventListener('click', function () { var c = read(); c[key] += 1; write(c); render(); });
        qty.appendChild(minus); qty.appendChild(el('output', '', cart[key])); qty.appendChild(plus);
        row.appendChild(qty);
        var remove = el('button', 'cart-remove', '移除'); remove.type = 'button';
        remove.addEventListener('click', function () { var c = read(); delete c[key]; write(c); render(); });
        row.appendChild(remove);
        if (problem) row.appendChild(el('span', 'cart-item-problem', problem));
        list.appendChild(row);
        if (p && p.priceNow != null) subtotal += p.priceNow * cart[key];
      });
      // The promo code comes off first; a code that no longer fits the cart is dropped with a reason.
      var promoOff = 0;
      if (promo && subtotal < promo.minSpend) {
        $('cart-promo-status').textContent = '優惠碼 ' + promo.code + ' 要消費滿 ' + money(promo.minSpend) + ' 才能使用';
        promo = null;
      }
      if (promo) {
        promoOff = promo.kind === 'percent' ? Math.floor(subtotal * promo.value / 100) : Math.min(promo.value, subtotal);
        $('cart-promo-status').textContent = '已套用 ' + promo.code + '（' + (promo.kind === 'percent' ? '減 ' + promo.value + '%' : '減 ' + money(promo.value)) + '）';
      }
      var goods = subtotal - promoOff;
      var free = freeOver > 0 && goods >= freeOver;
      var fee = method && !free ? shipping[method].fee : 0;
      // Points can pay for goods but not for shipping.
      var use = have == null ? 0 : Math.max(0, Math.min(Math.floor(Number($('cart-points-n').value) || 0), have, Math.floor(goods / rules.pointValue)));
      var discount = use * rules.pointValue;
      form.pointsUse = use;
      $('cart-subtotal').textContent = money(subtotal);
      $('cart-promo-row').hidden = !promoOff;
      $('cart-promo-off').textContent = '−' + money(promoOff);
      $('cart-discount-row').hidden = !discount;
      $('cart-discount').textContent = '−' + money(discount);
      $('cart-fee').textContent = free ? '免運（已滿 ' + money(freeOver) + '）' : method ? (fee ? money(fee) : '免運') : '請先選擇取貨方式';
      $('cart-free-hint').textContent = freeOver > 0 && !free ? '再買 ' + money(freeOver - goods) + ' 即可免運。' : '';
      $('cart-grand').textContent = money(goods - discount + fee);
      var earn = rules.earnPer ? Math.floor((goods - discount) / rules.earnPer) : 0;
      $('cart-earn').textContent = earn ? '這筆訂單確認收款後可獲得 ' + earn + ' 點積分（每 1 點可折抵 ' + money(rules.pointValue) + '）。' : '';
      $('cart-submit').disabled = blocked;
      show('form');
    };

    var chooseShip = function (key) {
      method = key;
      document.querySelectorAll('#cart-ship .chip').forEach(function (c) {
        c.setAttribute('aria-pressed', c.getAttribute('data-value') === key ? 'true' : 'false');
      });
      var ask = shipping[key].ask;
      $('cart-shipto-wrap').hidden = !ask;
      if (ask) $('cart-shipto-label').textContent = ask;
      render();
    };

    var done = function (order, phone) {
      var box = $('cart-done');
      box.textContent = '';
      var card = el('div', 'bk-done');
      card.appendChild(el('div', 'h-serif bk-done-title', '訂單已送出'));
      var code = el('p', 'bk-code', '訂單編號 ');
      code.appendChild(el('strong', '', order.code));
      card.appendChild(code);
      card.appendChild(orderLines(order.items));
      if (order.promoDiscount) card.appendChild(el('p', '', '優惠碼 ' + order.promoCode + ' −' + money(order.promoDiscount)));
      if (order.discount) card.appendChild(el('p', '', '積分折抵 −' + money(order.discount) + '（使用 ' + order.pointsUsed + ' 點）'));
      card.appendChild(el('p', '', order.shipName + (order.shipFee ? '　運費 ' + money(order.shipFee) : '　免運')));
      if (order.willEarn) card.appendChild(el('p', '', '確認收款後會獲得 ' + order.willEarn + ' 點積分。'));
      card.appendChild(el('p', 'bk-done-title h-serif', '應付 ' + money(order.total)));
      card.appendChild(bankLine(order.bankInfo));
      card.appendChild(el('p', '', '匯款後請在下面回報帳號末五碼。之後也可以在本頁下方「查詢訂單」用訂單編號與手機回報或查看進度。'));
      card.appendChild(payForm(order.code, phone));
      var line = el('a', 'bk-line-link', '有問題？用官方 LINE 聯絡我們');
      line.href = window.SSC_LINE_URL;
      card.appendChild(line);
      box.appendChild(card);
      show('done');
      box.scrollIntoView({ block: 'start' });
    };

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var error = $('cart-error');
      var fail = function (msg) { error.textContent = msg; error.hidden = false; };
      error.hidden = true;
      if (!method) return fail('請選擇取貨方式');
      var cart = read();
      var body = {
        items: Object.keys(cart).map(function (key) {
          var chosen = {};
          optionsOf(key).split('、').filter(Boolean).forEach(function (pair) { var at = pair.indexOf(':'); chosen[pair.slice(0, at)] = pair.slice(at + 1); });
          return { id: Number(idOf(key)), qty: cart[key], options: chosen };
        }),
        promo: promo ? promo.code : '',
        shipMethod: method, shipTo: $('cart-shipto').value,
        name: $('cart-name').value, phone: $('cart-phone').value, email: $('cart-email').value,
        line: $('cart-line').value, note: $('cart-note').value,
        marketing: $('cart-marketing').checked,
        pointsUse: form.pointsUse || 0, pointsCode: pointsCode,
      };
      var button = $('cart-submit');
      button.disabled = true;
      button.textContent = '送出中…';
      post('/api/orders', body).then(function (order) {
        if (window.sscTrack) window.sscTrack('purchase', {
          transaction_id: order.code, value: order.total, currency: 'TWD', shipping: order.shipFee,
          items: order.items.map(function (it) { return { item_id: String(it.product_id), item_name: it.name, price: it.price, quantity: it.qty }; }),
        });
        write({});
        done(order, body.phone);
      }).catch(function (err) {
        button.textContent = '送出訂單';
        fail(err.message);
        // Stock may have changed since the page loaded: fetch it again so the cart shows why.
        load(true);
      });
    });

    var load = function (fresh) {
      return fetch(API + '/api/products' + (fresh ? '?t=' + Date.now() : '')).then(function (res) { return res.json(); }).then(function (data) {
        products = {};
        data.products.forEach(function (p) { products[p.id] = p; });
        shipping = data.shipping;
        maxQty = data.maxQtyPerItem || 10;
        rules = data.points || rules;
        freeOver = data.freeShipOver || 0;
        $('cart-points').hidden = !rules.earnPer;
        $('cart-points-hint').textContent = '買過的客人可以用積分折抵，每 1 點折 ' + money(rules.pointValue) + '。先在上面填好手機，再輸入任何一筆過往訂單或預約的編號來查詢。';
        var row = $('cart-ship');
        if (!row.children.length) {
          Object.keys(shipping).forEach(function (key) {
            var chip = el('button', 'chip', shipping[key].name + (shipping[key].fee ? '（' + money(shipping[key].fee) + '）' : '（免運）'));
            chip.type = 'button';
            chip.setAttribute('data-value', key);
            chip.setAttribute('aria-pressed', 'false');
            chip.addEventListener('click', function () { chooseShip(key); });
            row.appendChild(chip);
          });
        }
        render();
      }).catch(function () {
        $('cart-loading').textContent = '暫時無法載入購物車，請稍後再試或以官方 LINE 聯絡我們。';
      });
    };
    load(false).then(function () {
      if (window.sscTrack && count()) window.sscTrack('begin_checkout', { currency: 'TWD' });
    });

    $('cart-points-go').addEventListener('click', function () {
      var error = $('cart-points-error');
      error.hidden = true;
      var code = $('cart-points-code').value.trim();
      post('/api/points/balance', { phone: $('cart-phone').value, code: code }).then(function (res) {
        have = res.points;
        pointsCode = code;
        $('cart-points-check').hidden = true;
        $('cart-points-use').hidden = false;
        $('cart-points-n').max = have;
        $('cart-points-n').value = have;
        $('cart-points-have').textContent = '點（你有 ' + have + ' 點）';
        render();
      }).catch(function (err) { error.textContent = err.message; error.hidden = false; });
    });
    $('cart-points-n').addEventListener('input', render);

    $('cart-promo-go').addEventListener('click', function () {
      var status = $('cart-promo-status');
      var code = $('cart-promo-code').value.trim();
      if (!code) { promo = null; status.textContent = ''; render(); return; }
      var cart = read();
      var subtotal = Object.keys(cart).reduce(function (sum, k) { var p = products[idOf(k)]; return sum + (p && p.priceNow != null ? p.priceNow * cart[k] : 0); }, 0);
      post('/api/promos/check', { code: code, subtotal: subtotal }).then(function (res) {
        promo = res;
        render();
      }).catch(function (err) { promo = null; status.textContent = err.message; render(); });
    });
    // Points belong to a phone number: changing it means proving it again.
    $('cart-phone').addEventListener('input', function () {
      if (have == null) return;
      have = null;
      pointsCode = '';
      $('cart-points-check').hidden = false;
      $('cart-points-use').hidden = true;
      render();
    });
  }

  // ---- A product's own page (item.html?id=12) ----
  var item = $('item-body');
  if (item && API) {
    var wantId = Number((/[?&]id=(\d+)/.exec(window.location.search) || [])[1]);
    fetch(API + '/api/products').then(function (res) { return res.json(); }).then(function (data) {
      var p = data.products.filter(function (x) { return x.id === wantId; })[0];
      $('item-loading').hidden = true;
      if (!p) { $('item-missing').hidden = false; return; }
      var names = {};
      data.categories.stone.concat(data.categories.cat).forEach(function (c) { names[c.slug] = c.name; });
      var soldout = p.status === 'soldout';

      // The page's own title, description and structured data, for search engines and shared links.
      document.title = p.name + '｜奇怪貓工作室';
      var summary = (p.description || p.note || p.name).replace(/\s+/g, ' ').slice(0, 120);
      var meta = document.querySelector('meta[name="description"]');
      if (meta) meta.setAttribute('content', summary);
      if (p.priceNow != null) {
        var ld = document.createElement('script');
        ld.type = 'application/ld+json';
        ld.textContent = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: p.name, description: summary, image: p.images.map(function (u) { return new URL(u, window.location.href).href; }),
          brand: { '@type': 'Brand', name: '奇怪貓工作室' },
          offers: { '@type': 'Offer', priceCurrency: 'TWD', price: p.priceNow, url: window.location.href,
            availability: 'https://schema.org/' + (soldout ? 'OutOfStock' : p.supply === 'made' ? 'MadeToOrder' : 'InStock') } });
        document.head.appendChild(ld);
      }
      if (window.sscTrack) window.sscTrack('view_item', { currency: 'TWD', value: p.priceNow, items: [{ item_id: String(p.id), item_name: p.name, price: p.priceNow }] });

      // Photos: one large, the rest as thumbnails that swap in.
      var main = $('item-photo');
      if (p.images.length) {
        main.src = p.images[0];
        main.alt = p.name;
        main.hidden = false;
        if (p.images.length > 1) {
          p.images.forEach(function (src, at) {
            var t = el('button', 'item-thumb');
            t.type = 'button';
            t.setAttribute('aria-label', '第 ' + (at + 1) + ' 張相片');
            t.setAttribute('aria-pressed', at === 0 ? 'true' : 'false');
            var im = el('img'); im.src = src; im.alt = ''; im.loading = 'lazy';
            t.appendChild(im);
            t.addEventListener('click', function () {
              main.src = src;
              document.querySelectorAll('.item-thumb').forEach(function (o) { o.setAttribute('aria-pressed', o === t ? 'true' : 'false'); });
            });
            $('item-thumbs').appendChild(t);
          });
        }
      } else {
        $('item-nophoto').hidden = false;
      }

      $('item-crumb').textContent = (names[p.stone] || '') + ' ・ ' + (names[p.cat] || '');
      $('item-name').textContent = p.name;
      $('item-note').textContent = p.note;
      var price = $('item-price');
      if (p.priceNow == null) price.textContent = '價錢請洽詢';
      else {
        price.textContent = money(p.priceNow) + (p.priceFrom ? ' 起' : '');
        if (p.salePrice != null) { var was = el('s', 'item-was', money(p.price)); price.appendChild(was); }
      }
      $('item-badge').textContent = soldout ? '已售完' : p.supply === 'made' ? '手工訂製' : '現貨';
      $('item-desc').textContent = p.description;
      $('item-desc').hidden = !p.description;

      // Options: one row of chips each; every row needs a choice before buying.
      var chosen = {};
      var buy = $('item-buy');
      var hint = $('item-hint');
      p.options.forEach(function (o) {
        var group = el('div', 'filter-group');
        group.appendChild(el('div', 'filter-title', o.name));
        var row = el('div', 'chip-row');
        o.values.forEach(function (v) {
          var chip = el('button', 'chip', v);
          chip.type = 'button';
          chip.setAttribute('aria-pressed', 'false');
          chip.addEventListener('click', function () {
            chosen[o.name] = v;
            row.querySelectorAll('.chip').forEach(function (c) { c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'); });
            hint.textContent = '';
          });
          row.appendChild(chip);
        });
        group.appendChild(row);
        $('item-options').appendChild(group);
      });

      if (p.buyable) {
        buy.hidden = false;
        buy.addEventListener('click', function () {
          var missing = p.options.filter(function (o) { return !chosen[o.name]; })[0];
          if (missing) { hint.textContent = '請先選擇' + missing.name; return; }
          var text = p.options.map(function (o) { return o.name + ':' + chosen[o.name]; }).join('、');
          if (!window.sscCart.add(p.id, p.stock, p, text)) { hint.textContent = '購物車裡已經是最後 ' + p.stock + ' 件了'; return; }
          hint.textContent = '已加入購物車';
          $('item-cart').hidden = false;
        });
        if (p.stock != null && p.stock <= 3) $('item-stock').textContent = '只剩 ' + p.stock + ' 件';
      } else if (!soldout) {
        // Made-to-order and ask-for-price pieces are arranged with the studio.
        var ask = $('item-ask');
        ask.hidden = false;
        if (p.link) { ask.href = p.link; ask.textContent = '前往訂購'; if (/^https:/.test(p.link)) { ask.target = '_blank'; ask.rel = 'noopener'; } }
      }
      if (inCart(read(), p.id)) $('item-cart').hidden = false;
      $('item-body').hidden = false;
    }).catch(function (err) {
      console.error(err);
      $('item-loading').hidden = false;
      $('item-loading').textContent = '暫時無法載入，請稍後再試或以官方 LINE 聯絡我們。';
    });
  }

  // ---- Order look-up ----
  var lookup = $('lookup-form');
  if (lookup && API) {
    lookup.addEventListener('submit', function (e) {
      e.preventDefault();
      var error = $('lookup-error');
      var out = $('lookup-result');
      error.hidden = true;
      out.hidden = true;
      var code = $('lookup-code').value.trim();
      var phone = $('lookup-phone').value.trim();
      post('/api/orders/lookup', { code: code, phone: phone }).then(function (o) {
        out.textContent = '';
        var card = el('div', 'bk-done');
        card.appendChild(el('div', 'h-serif bk-done-title', STATUS[o.status] || o.status));
        card.appendChild(el('p', '', '訂單 ' + o.code + '　' + o.date));
        card.appendChild(orderLines(o.items));
        if (o.promoDiscount) card.appendChild(el('p', '', '優惠碼 ' + o.promoCode + ' −' + money(o.promoDiscount)));
        if (o.discount) card.appendChild(el('p', '', '積分折抵 −' + money(o.discount)));
        card.appendChild(el('p', '', o.shipName + (o.shipTo ? '　' + o.shipTo : '') + '　合計 ' + money(o.total)));
        if (o.tracking) card.appendChild(el('p', '', '寄件編號：' + o.tracking));
        card.appendChild(el('p', '', '你目前有 ' + o.points + ' 點積分。'));
        if (o.status === 'pending') { card.appendChild(bankLine(o.bankInfo)); card.appendChild(payForm(o.code, phone)); }
        out.appendChild(card);
        out.hidden = false;
      }).catch(function (err) { error.textContent = err.message; error.hidden = false; });
    });
  }
})();
