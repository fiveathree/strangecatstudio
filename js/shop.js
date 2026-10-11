// Cart (kept in this browser), the checkout page and order look-up.
(function () {
  var API = window.SSC_API;
  var KEY = 'ssc-cart';
  var $ = function (id) { return document.getElementById(id); };
  var money = function (n) { return 'NT$' + Number(n).toLocaleString('en-US'); };
  var STATUS = { pending: '待匯款', reported: '已回報末五碼，待工作室確認', paid: '已收款，準備出貨', shipped: '已出貨／可取貨', done: '已完成', cancelled: '已取消' };

  // The cart is { productId: quantity }. Storage can be unavailable (private windows),
  // in which case the cart simply lasts until the page is closed.
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
    add: function (id, stock, item) {
      if (window.sscTrack && item) window.sscTrack('add_to_cart', { currency: 'TWD', value: item.price, items: [{ item_id: String(id), item_name: item.name, price: item.price, quantity: 1 }] });
      var cart = read();
      var next = (cart[id] || 0) + 1;
      cart[id] = stock == null ? next : Math.min(next, stock);
      write(cart);
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
    items.forEach(function (it) { ul.appendChild(el('li', '', it.name + ' × ' + it.qty + '　' + money(it.price * it.qty))); });
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

  function bankLine() {
    return el('p', '', window.SSC_BANK_INFO ? '請匯款至：' + window.SSC_BANK_INFO : '請加入官方 LINE（' + window.SSC_LINE_ID + '）取得匯款資料。');
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
      ids.forEach(function (id) {
        var p = products[id];
        var row = el('div', 'cart-item');
        if (p && p.image) { var img = el('img'); img.src = p.image; img.alt = ''; row.appendChild(img); }
        else row.appendChild(el('span', 'ph', '相片'));
        row.appendChild(el('span', 'cart-item-name', p ? p.name : '這件貨品已下架'));
        var limit = p && p.buyable ? Math.min(maxQty, p.stock == null ? maxQty : p.stock) : 0;
        var problem = !p || !p.buyable ? '目前無法訂購，請移除' : cart[id] > limit ? '只剩 ' + limit + ' 件，請調整數量' : '';
        if (problem) blocked = true;
        row.appendChild(el('span', 'cart-item-price', p && p.price != null ? money(p.price * cart[id]) : ''));
        var qty = el('span', 'cart-qty');
        var minus = el('button', '', '−'); minus.type = 'button'; minus.setAttribute('aria-label', '減少一件');
        var plus = el('button', '', '＋'); plus.type = 'button'; plus.setAttribute('aria-label', '增加一件');
        plus.disabled = cart[id] >= limit;
        minus.addEventListener('click', function () { var c = read(); c[id] -= 1; if (c[id] < 1) delete c[id]; write(c); render(); });
        plus.addEventListener('click', function () { var c = read(); c[id] += 1; write(c); render(); });
        qty.appendChild(minus); qty.appendChild(el('output', '', cart[id])); qty.appendChild(plus);
        row.appendChild(qty);
        var remove = el('button', 'cart-remove', '移除'); remove.type = 'button';
        remove.addEventListener('click', function () { var c = read(); delete c[id]; write(c); render(); });
        row.appendChild(remove);
        if (problem) row.appendChild(el('span', 'cart-item-problem', problem));
        list.appendChild(row);
        if (p && p.price != null) subtotal += p.price * cart[id];
      });
      var fee = method ? shipping[method].fee : 0;
      // Points can pay for goods but not for shipping.
      var use = have == null ? 0 : Math.max(0, Math.min(Math.floor(Number($('cart-points-n').value) || 0), have, Math.floor(subtotal / rules.pointValue)));
      var discount = use * rules.pointValue;
      form.pointsUse = use;
      $('cart-subtotal').textContent = money(subtotal);
      $('cart-discount-row').hidden = !discount;
      $('cart-discount').textContent = '−' + money(discount);
      $('cart-fee').textContent = method ? (fee ? money(fee) : '免運') : '請先選擇取貨方式';
      $('cart-grand').textContent = money(subtotal - discount + fee);
      var earn = rules.earnPer ? Math.floor((subtotal - discount) / rules.earnPer) : 0;
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
      if (order.discount) card.appendChild(el('p', '', '積分折抵 −' + money(order.discount) + '（使用 ' + order.pointsUsed + ' 點）'));
      card.appendChild(el('p', '', order.shipName + (order.shipFee ? '　運費 ' + money(order.shipFee) : '　免運')));
      if (order.willEarn) card.appendChild(el('p', '', '確認收款後會獲得 ' + order.willEarn + ' 點積分。'));
      card.appendChild(el('p', 'bk-done-title h-serif', '應付 ' + money(order.total)));
      card.appendChild(bankLine());
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
        items: Object.keys(cart).map(function (id) { return { id: Number(id), qty: cart[id] }; }),
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
        $('cart-points').hidden = !rules.earnPer;
        $('cart-points-hint').textContent = '買過的客人可以用積分折抵，每 1 點折 ' + money(rules.pointValue) + '。先在上面填好手機，再輸入任何一張過往訂單的編號來查詢。';
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
        card.appendChild(el('p', '', o.shipName + (o.shipTo ? '　' + o.shipTo : '') + '　合計 ' + money(o.total)));
        if (o.tracking) card.appendChild(el('p', '', '寄件編號：' + o.tracking));
        card.appendChild(el('p', '', '你目前有 ' + o.points + ' 點積分。'));
        if (o.status === 'pending') { card.appendChild(bankLine()); card.appendChild(payForm(o.code, phone)); }
        out.appendChild(card);
        out.hidden = false;
      }).catch(function (err) { error.textContent = err.message; error.hidden = false; });
    });
  }
})();
