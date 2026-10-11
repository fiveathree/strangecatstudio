// Booking widget for visit.html. Talks to the Worker in /booking.
(function () {
  var API = window.SSC_API;
  var root = document.getElementById('booking-app');
  if (!API || !root) return;

  // The site's own booking replaces the Calendly fallback.
  var fallback = document.getElementById('booking-fallback');
  if (fallback) fallback.hidden = true;
  root.hidden = false;

  var STUDIOS = { tn: '台南工作室', kh: '高雄工作室' };
  var TYPES = { 'class': '琉璃體驗課', visit: '到訪鑑賞' };
  var WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  var DAYS_PER_PAGE = 14;

  var state = { studio: 'tn', type: 'class', people: 1, from: null, days: [], date: null, time: null, loading: false, error: '' };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function request(method, path, body) {
    return fetch(API + path, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error(data.error || '發生錯誤，請稍後再試');
        return data;
      });
    }, function () {
      throw new Error('連線失敗，請檢查網路後再試');
    });
  }

  function loadSlots() {
    state.loading = true;
    state.error = '';
    render();
    var q = '/api/slots?studio=' + state.studio + '&days=' + DAYS_PER_PAGE + (state.from ? '&from=' + state.from : '');
    return request('GET', q).then(function (data) {
      state.days = data.days;
      state.from = data.days[0].date;
      var stillThere = data.days.some(function (d) { return d.date === state.date && !d.closed; });
      if (!stillThere) {
        var firstOpen = data.days.filter(function (d) { return !d.closed && d.slots.some(function (s) { return s.left >= state.people; }); })[0];
        state.date = firstOpen ? firstOpen.date : null;
        state.time = null;
      }
    }).catch(function (err) {
      state.days = [];
      state.error = err.message;
    }).then(function () {
      state.loading = false;
      render();
    });
  }

  function shift(n) {
    var d = new Date(state.from + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    state.from = d.toISOString().slice(0, 10);
    loadSlots();
  }

  function chips(title, options, current, onPick) {
    return el('div', { 'class': 'bk-field' }, [
      el('div', { 'class': 'filter-title', text: title }),
      el('div', { 'class': 'chip-row' }, Object.keys(options).map(function (key) {
        return el('button', { type: 'button', 'class': 'chip', 'aria-pressed': String(key === String(current)), text: options[key], onclick: function () { onPick(key); } });
      })),
    ]);
  }

  function dayLabel(date) {
    var p = date.split('-');
    return Number(p[1]) + '/' + Number(p[2]);
  }

  function render() {
    root.textContent = '';
    var selectedDay = state.days.filter(function (d) { return d.date === state.date; })[0];

    root.appendChild(chips('工作室', STUDIOS, state.studio, function (k) { state.studio = k; state.date = null; state.time = null; state.from = null; loadSlots(); }));
    root.appendChild(chips('預約項目', TYPES, state.type, function (k) { state.type = k; render(); }));
    root.appendChild(chips('人數', { 1: '1 位', 2: '2 位', 3: '3 位', 4: '4 位' }, state.people, function (k) { state.people = Number(k); state.time = null; render(); }));

    // Dates
    var dateRow = el('div', { 'class': 'bk-dates' }, state.days.map(function (d) {
      var free = !d.closed && d.slots.some(function (s) { return s.left >= state.people; });
      return el('button', {
        type: 'button', 'class': 'bk-date', disabled: !free, 'aria-pressed': String(d.date === state.date),
        title: d.closed || (free ? '' : '已額滿'),
        onclick: function () { state.date = d.date; state.time = null; render(); },
      }, [el('span', { 'class': 'bk-date-week', text: '週' + WEEK[d.weekday] }), el('span', { 'class': 'bk-date-day', text: dayLabel(d.date) }), el('span', { 'class': 'bk-date-note', text: d.closed ? '休息' : free ? '' : '額滿' })]);
    }));
    root.appendChild(el('div', { 'class': 'bk-field' }, [
      el('div', { 'class': 'bk-row' }, [
        el('div', { 'class': 'filter-title', text: '日期' }),
        el('div', { 'class': 'bk-pager' }, [
          el('button', { type: 'button', 'class': 'chip', text: '較早', onclick: function () { shift(-DAYS_PER_PAGE); } }),
          el('button', { type: 'button', 'class': 'chip', text: '較後', onclick: function () { shift(DAYS_PER_PAGE); } }),
        ]),
      ]),
      state.loading ? el('p', { 'class': 'bk-hint', text: '正在載入可預約時段…' }) : dateRow,
      state.error ? el('p', { 'class': 'bk-error', role: 'alert', text: state.error }) : null,
    ]));

    // Times
    if (selectedDay) {
      root.appendChild(el('div', { 'class': 'bk-field' }, [
        el('div', { 'class': 'filter-title', text: '時段（' + dayLabel(selectedDay.date) + ' 週' + WEEK[selectedDay.weekday] + '）' }),
        el('div', { 'class': 'chip-row' }, selectedDay.slots.map(function (s) {
          var ok = s.left >= state.people;
          return el('button', {
            type: 'button', 'class': 'chip bk-time', disabled: !ok, 'aria-pressed': String(s.time === state.time),
            text: s.time + (ok ? '　尚餘 ' + s.left + ' 位' : '　額滿'),
            onclick: function () { state.time = s.time; render(); },
          });
        })),
      ]));
    } else if (!state.loading && !state.error) {
      root.appendChild(el('p', { 'class': 'bk-hint', text: '這兩週沒有可預約的時段，請按「較後」查看之後的日期。' }));
    }

    // Contact details
    var form = el('form', { 'class': 'bk-form', onsubmit: submit }, [
      field('姓名', 'bk-name', 'text', 'name', true),
      field('電話', 'bk-phone', 'tel', 'tel', true),
      field('LINE ID（選填）', 'bk-line', 'text', 'off', false),
      el('div', { 'class': 'bk-input bk-input-wide' }, [
        el('label', { 'for': 'bk-note', text: '備註（選填）' }),
        el('textarea', { id: 'bk-note', rows: '3', maxlength: '300', placeholder: '例如：想做的體驗課項目、送禮對象、想了解的產品' }),
      ]),
      el('p', { 'class': 'bk-error', id: 'bk-submit-error', role: 'alert', hidden: '' }),
      el('button', { type: 'submit', 'class': 'bk-submit', disabled: !state.time, text: state.time ? '確認預約' : '請先選擇日期與時段' }),
    ]);
    root.appendChild(form);
  }

  function field(label, id, type, autocomplete, required) {
    return el('div', { 'class': 'bk-input' }, [
      el('label', { 'for': id, text: label }),
      el('input', { id: id, type: type, autocomplete: autocomplete, required: required ? '' : null, maxlength: '40' }),
    ]);
  }

  function value(id) {
    return document.getElementById(id).value.trim();
  }

  function submit(event) {
    event.preventDefault();
    var button = root.querySelector('.bk-submit');
    var errorBox = document.getElementById('bk-submit-error');
    var phone = value('bk-phone');
    errorBox.hidden = true;
    button.disabled = true;
    button.textContent = '送出中…';
    request('POST', '/api/bookings', {
      studio: state.studio, date: state.date, time: state.time, type: state.type, people: state.people,
      name: value('bk-name'), phone: phone, line: value('bk-line'), note: value('bk-note'),
    }).then(function (booking) {
      if (window.sscTrack) window.sscTrack('generate_lead', { booking_type: booking.type, studio: booking.studio, people: booking.people });
      done(booking, phone);
    }).catch(function (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      button.disabled = false;
      button.textContent = '確認預約';
      // Someone else may have taken the slot: show the up-to-date numbers.
      request('GET', '/api/slots?studio=' + state.studio + '&days=' + DAYS_PER_PAGE + '&from=' + state.from).then(function (data) { state.days = data.days; });
    });
  }

  function done(booking, phone) {
    root.textContent = '';
    var lineLink = el('a', { href: window.SSC_LINE_URL, 'class': 'bk-line-link', text: '加入官方 LINE ' + window.SSC_LINE_ID });
    var parts = [
      el('div', { 'class': 'eyebrow', text: booking.status === 'confirmed' ? 'BOOKED ・ 預約完成' : 'ALMOST THERE ・ 已保留名額' }),
      el('div', { 'class': 'h-serif bk-done-title', text: booking.studioName + '　' + booking.date + ' ' + booking.time }),
      el('p', { 'class': 'bk-done-line', text: booking.typeName + '・' + booking.people + ' 位' }),
      el('p', { 'class': 'bk-code' }, [el('span', { text: '預約編號 ' }), el('strong', { text: booking.code })]),
    ];
    if (booking.type === 'class') {
      parts.push(el('p', { text: window.SSC_BANK_INFO ? '請匯款至：' + window.SSC_BANK_INFO : '請加入官方 LINE 取得匯款資料。' }));
      parts.push(el('p', { text: '匯款後，在下方填寫匯款帳號末五碼，或直接以 LINE 告訴我們，名額才算確認。' }));
      var input = el('input', { id: 'bk-last5', type: 'text', inputmode: 'numeric', maxlength: '5', pattern: '\\d{5}', placeholder: '末五碼', 'aria-label': '匯款帳號末五碼' });
      var note = el('p', { 'class': 'bk-hint', role: 'status' });
      var send = el('button', { type: 'submit', 'class': 'bk-submit', text: '送出末五碼' });
      parts.push(el('form', { 'class': 'bk-pay', onsubmit: function (e) {
        e.preventDefault();
        send.disabled = true;
        request('POST', '/api/bookings/payment', { code: booking.code, phone: phone, last5: input.value.trim() }).then(function () {
          note.textContent = '已收到，我們核對後會以 LINE 或電話與你確認。';
          input.disabled = true;
        }).catch(function (err) {
          note.textContent = err.message;
          send.disabled = false;
        });
      } }, [input, send]));
      parts.push(note);
    } else {
      parts.push(el('p', { text: '到訪無須預付。如需改期或取消，請以官方 LINE 告訴我們。' }));
    }
    parts.push(el('a', {
      'class': 'bk-cal', target: '_blank', rel: 'noopener',
      href: window.sscCalendarLink('奇怪貓工作室 ' + booking.typeName, booking.date, booking.time, booking.slotMinutes || 90,
        window.SSC_ADDRESS[booking.studio], '預約編號 ' + booking.code + '，' + booking.people + ' 位。官方 LINE ' + window.SSC_LINE_ID),
      text: '加入 Google 日曆',
    }));
    parts.push(lineLink);
    root.appendChild(el('div', { 'class': 'bk-done' }, parts));
    root.scrollIntoView({ block: 'start' });
  }

  loadSlots();
})();
