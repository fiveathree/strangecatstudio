// Site settings.
//
// SSC_API: address of the booking API (the Cloudflare Worker in /booking),
// without a trailing slash, e.g. 'https://strangecat-booking.<you>.workers.dev'.
// While it is empty the booking page keeps showing the Calendly calendar.
window.SSC_API = 'https://strangecat-booking.fiveathree.workers.dev';

// Shown to customers after they book a class. Leave empty to have them ask on LINE.
window.SSC_BANK_INFO = '';

// Used for the "add to Google Calendar" links.
window.SSC_ADDRESS = { tn: '台南市北區長榮路四段40號', kh: '高雄市中華五路939巷24號' };

// Builds a Google Calendar link that opens with the event already filled in.
// date 'YYYY-MM-DD' and time 'HH:MM' are Taipei time (UTC+8).
window.sscCalendarLink = function (title, date, time, minutes, location, details) {
  var start = new Date(date + 'T' + time + ':00+08:00');
  var end = new Date(start.getTime() + minutes * 60000);
  var stamp = function (d) { return d.toISOString().replace(/[-:]|\.\d{3}/g, ''); };
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
    '&text=' + encodeURIComponent(title) +
    '&dates=' + stamp(start) + '/' + stamp(end) +
    '&location=' + encodeURIComponent(location || '') +
    '&details=' + encodeURIComponent(details || '');
};

window.SSC_LINE_URL = 'https://lin.ee/9DuIwy4';
window.SSC_LINE_ID = '@735tcwvw';

// Google Analytics 4. Paste the Measurement ID (looks like 'G-XXXXXXXXXX') between the
// quotes to switch it on; leave it empty and nothing is loaded or sent.
window.SSC_GA_ID = '';

// sscTrack('event_name', {details}) records something a visitor did. Safe to call
// whether or not Analytics is switched on.
window.dataLayer = window.dataLayer || [];
window.gtag = function () { window.dataLayer.push(arguments); };
window.sscTrack = function (name, params) {
  if (window.SSC_GA_ID) window.gtag('event', name, params || {});
};
(function () {
  var id = window.SSC_GA_ID;
  // The studio's own back office is not a visitor.
  if (!id || /admin\.html$/.test(window.location.pathname)) { window.SSC_GA_ID = ''; return; }
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
  document.head.appendChild(s);
  window.gtag('js', new Date());
  window.gtag('config', id);
  // Tapping through to the official LINE account is the site's main "contact us".
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href*="lin.ee"], a[href*="line.me"]');
    if (a) window.sscTrack('contact_line', { link_url: a.href });
  });
})();
