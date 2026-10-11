/**
 * 奇怪貓工作室 — booking notifier (Google Apps Script web app).
 *
 * The booking Worker posts here whenever a booking or shop order is made, a customer reports
 * their transfer, or the studio changes a booking's status. This script then:
 *   1. emails the studio,
 *   2. keeps the studio's Google Calendar in step (adds, retitles, removes),
 *   3. optionally pushes a LINE message,
 *   4. emails the customer when the Worker supplies a message for them.
 *
 * Settings live in Project Settings → Script properties (all optional):
 *   STUDIO_EMAIL  where to send the emails when none are set on the admin page
 *                 (default: the account running this script)
 *   CALENDAR_ID   calendar to write to (default: your main calendar; "off" to skip)
 *   NOTIFY_KEY    if set, the Worker's NOTIFY_URL must end with ?key=<this value>
 *   LINE_TOKEN    Messaging API channel access token  } both needed
 *   LINE_TO       user ID or group ID to push to      } for LINE messages
 *
 * Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 * Put the web app URL into the Worker as the secret NOTIFY_URL.
 */

var STATUS = { pending: '待匯款', reported: '已回報末五碼', confirmed: '已確認', cancelled: '已取消' };
var ORDER_STATUS = { pending: '待匯款', reported: '已回報末五碼', paid: '已收款', shipped: '已出貨', done: '已完成', cancelled: '已取消' };
var ADDRESS = { tn: '台南市北區長榮路四段40號', kh: '高雄市中華五路939巷24號' };

function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('NOTIFY_KEY');
  if (key && e.parameter.key !== key) return reply({ ok: false, error: 'bad key' });

  var data = JSON.parse(e.postData.contents);
  if (data.order) return orderNotice(props, data);
  var b = data.booking;
  var heading = { booked: '新預約', payment: '已回報匯款末五碼', status: '預約狀態更新' }[data.event] || '預約通知';
  var summary = b.studioName + ' ' + b.date + ' ' + b.time + '｜' + b.typeName + '｜' + b.name + ' ' + b.people + ' 位';
  var lines = [
    heading + '（' + STATUS[b.status] + '）',
    summary,
    '電話：' + b.phone,
    b.line_id ? 'LINE：' + b.line_id : '',
    b.email ? 'Email：' + b.email : '',
    b.note ? '備註：' + b.note : '',
    b.pay_last5 ? '匯款末五碼：' + b.pay_last5 : '',
    '預約編號：' + b.code,
  ].filter(String);

  var errors = [];
  attempt(errors, 'email', function () {
    // Recipients set on the admin page win; otherwise the script property, otherwise yourself.
    var to = (data.emails && data.emails.length ? data.emails.join(',') : '') ||
      props.getProperty('STUDIO_EMAIL') || Session.getEffectiveUser().getEmail();
    MailApp.sendEmail(to, '【奇怪貓預約】' + heading + '：' + summary, lines.join('\n'));
  });
  attempt(errors, 'calendar', function () {
    syncCalendar(props.getProperty('CALENDAR_ID'), b, data.slotMinutes || 90, lines);
  });
  mailCustomer(errors, data);
  attempt(errors, 'line', function () {
    pushLine(props.getProperty('LINE_TOKEN'), props.getProperty('LINE_TO'), lines.join('\n'));
  });
  return reply({ ok: errors.length === 0, errors: errors });
}

/** Shop orders: email and LINE only (nothing goes on the calendar). */
function orderNotice(props, data) {
  var o = data.order;
  var heading = { order: '新訂單', order_payment: '訂單已回報匯款末五碼', order_status: '訂單狀態更新' }[data.event] || '訂單通知';
  var lines = [heading + '（' + (ORDER_STATUS[o.status] || o.status) + '）', '訂單編號：' + o.code, o.name + '　' + o.phone]
    .concat((o.items || []).map(function (it) { return '・' + it.name + (it.options ? '（' + it.options + '）' : '') + ' × ' + it.qty + '　NT$' + it.price * it.qty; }))
    .concat([
      o.shipName + (o.ship_to ? '：' + o.ship_to : ''),
      o.promo_discount ? '優惠碼 ' + o.promo_code + '　−NT$' + o.promo_discount : '',
      o.discount ? '積分折抵　−NT$' + o.discount : '',
      '運費 NT$' + o.ship_fee + '　合計 NT$' + o.total,
      o.pay_last5 ? '匯款末五碼：' + o.pay_last5 : '',
      o.tracking ? '寄件編號：' + o.tracking : '',
      o.line_id ? 'LINE：' + o.line_id : '',
      o.email ? 'Email：' + o.email : '',
      o.note ? '備註：' + o.note : '',
    ]).filter(String);
  var errors = [];
  attempt(errors, 'email', function () {
    var to = (data.emails && data.emails.length ? data.emails.join(',') : '') ||
      props.getProperty('STUDIO_EMAIL') || Session.getEffectiveUser().getEmail();
    MailApp.sendEmail(to, '【奇怪貓訂單】' + heading + '：' + o.code + ' ' + o.name + ' NT$' + o.total, lines.join('\n'));
  });
  attempt(errors, 'line', function () {
    pushLine(props.getProperty('LINE_TOKEN'), props.getProperty('LINE_TO'), lines.join('\n'));
  });
  mailCustomer(errors, data);
  return reply({ ok: errors.length === 0, errors: errors });
}

/**
 * The Worker decides whether the customer should hear about this change and writes the
 * message; this only sends it. Sent from the account that runs this script.
 */
function mailCustomer(errors, data) {
  if (!data.customer || !data.customer.to) return;
  attempt(errors, 'customer email', function () {
    MailApp.sendEmail(data.customer.to, data.customer.subject, data.customer.body, { name: '奇怪貓工作室' });
  });
}

/** One failing channel must not stop the others. */
function attempt(errors, name, fn) {
  try { fn(); } catch (err) { errors.push(name + ': ' + err); console.error(name, err); }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function syncCalendar(calendarId, b, minutes, lines) {
  if (calendarId === 'off') return;
  var calendar = calendarId ? CalendarApp.getCalendarById(calendarId) : CalendarApp.getDefaultCalendar();
  if (!calendar) throw new Error('calendar not found: ' + calendarId);
  var start = new Date(b.date + 'T' + b.time + ':00+08:00');
  var end = new Date(start.getTime() + minutes * 60000);
  var title = '[' + STATUS[b.status] + '] ' + b.studioName.replace('工作室', '') + ' ' + b.typeName + '｜' + b.name + ' ' + b.people + ' 位';
  var marker = '預約編號：' + b.code;

  // The booking code in the description is how an existing event is found again.
  var existing = calendar.getEvents(start, end).filter(function (ev) {
    return ev.getDescription().indexOf(marker) !== -1;
  });
  if (b.status === 'cancelled') {
    existing.forEach(function (ev) { ev.deleteEvent(); });
    return;
  }
  if (existing.length) {
    existing[0].setTitle(title);
    existing[0].setDescription(lines.join('\n'));
  } else {
    calendar.createEvent(title, start, end, { location: ADDRESS[b.studio], description: lines.join('\n') });
  }
}

function pushLine(token, to, text) {
  if (!token || !to) return;
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error(res.getContentText());
}

/** Run this once from the editor to grant permissions and check the email arrives. */
function testNotify() {
  doPost({
    parameter: { key: PropertiesService.getScriptProperties().getProperty('NOTIFY_KEY') },
    postData: { contents: JSON.stringify({
      event: 'booked', slotMinutes: 90,
      booking: { code: 'TEST01', studio: 'tn', studioName: '台南工作室', date: Utilities.formatDate(new Date(Date.now() + 86400000), 'Asia/Taipei', 'yyyy-MM-dd'),
        time: '15:00', type: 'class', typeName: '琉璃體驗課', people: 2, name: '測試', phone: '0900000000', status: 'pending' },
    }) },
  });
}
