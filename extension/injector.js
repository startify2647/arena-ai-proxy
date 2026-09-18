/**
 * Arena2API - Injector (MAIN world)  —  نسخه‌ی وصله‌شده v2
 *
 * در «دنیای اصلی» صفحه اجرا می‌شود و دسترسی مستقیم دارد به:
 * - window.grecaptcha.enterprise
 * - window.__next_f (دیتای Next.js)
 * - تمام متغیرهای سراسری صفحه
 *
 * از طریق window.postMessage با content.js ارتباط برقرار می‌کند
 *
 * ==== وصله v2: به‌روزرسانی استخراج مدل‌ها ====
 * v1: ساختار جدید صفحه (RSC payload چند لایه escape) را پشتیبانی می‌کند.
 * v2: در صفحه‌ی لاگین‌شده چند آرایه‌ی «initialModels» وجود دارد و بعضی
 *     فقط id دارند و publicName (نام واقعی مدل) ندارند. این نسخه بین
 *     همه‌ی کاندیدها، آرایه‌ای را انتخاب می‌کند که بیشترین مدلِ «نام‌دار»
 *     را دارد تا سرور دیگر UUID را به‌جای نام نمایش ندهد.
 */
(function() {
  'use strict';

  var SITEKEY = '6Led_uYrAAAAAKjxDIF58fgFtX3t8loNAK85bW9I';
  var TAG = '[Arena2API]';
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // ========== استخراج لیست مدل‌ها ==========
  function extractModels() {
    try {
      // روش ۱: __NEXT_DATA__ (ساختار قدیمی Pages Router — برای سازگاری نگه داشته شده)
      var nd = window.__NEXT_DATA__;
      if (nd && nd.props && nd.props.pageProps && nd.props.pageProps.initialModels) {
        return nd.props.pageProps.initialModels;
      }

      // جمع‌آوری همه‌ی منابع متنیِ ممکن
      var chunks = [];
      if (window.__next_f && window.__next_f.length) {
        for (var i = 0; i < window.__next_f.length; i++) {
          var entry = window.__next_f[i];
          if (entry && typeof entry[1] === 'string' && entry[1].indexOf('initialModels') >= 0) {
            chunks.push(entry[1]);
          }
        }
      }
      var scripts = document.querySelectorAll('script');
      for (var s = 0; s < scripts.length; s++) {
        var txt = scripts[s].textContent || '';
        if (txt.indexOf('initialModels') >= 0) chunks.push(txt);
      }

      // از هر منبع، همه‌ی آرایه‌های کاندید را جمع کن
      var candidates = [];
      for (var c = 0; c < chunks.length; c++) {
        var found = findModelCandidates(chunks[c]);
        for (var f = 0; f < found.length; f++) candidates.push(found[f]);
      }

      if (!candidates.length) return null;

      // امتیازدهی: ترجیح با آرایه‌ای است که بیشترین مدلِ «نام‌دار» را دارد
      var best = null, bestScore = -1, bestNamed = 0;
      for (var k = 0; k < candidates.length; k++) {
        var cand = candidates[k];
        var named = 0;
        for (var n = 0; n < cand.length; n++) {
          var p = cand[n] && cand[n].publicName;
          if (typeof p === 'string' && p && p !== cand[n].id && !UUID_RE.test(p)) named++;
        }
        // امتیاز: تعداد مدل‌های نام‌دار (وزن اصلی) + تعداد کل (وزن فرعی)
        var score = named * 100000 + cand.length;
        if (score > bestScore) {
          bestScore = score;
          best = cand;
          bestNamed = named;
        }
      }

      console.log(TAG, 'Model candidates:', candidates.length,
                  '| chosen:', best ? best.length : 0, 'entries,', bestNamed, 'named');
      return best;
    } catch(e) {
      console.error(TAG, 'extractModels error:', e);
      return null;
    }
  }

  // یافتن همه‌ی آرایه‌های کاندیدِ مدل در یک متن (ممکن است چند بار initialModels آمده باشد)
  function findModelCandidates(str) {
    var out = [];
    var key = 'initialModels';
    var pos = 0;
    while (true) {
      var idx = str.indexOf(key, pos);
      if (idx < 0) break;
      var i = idx + key.length;
      // رد شدن از روی کاراکترهای escape / کوتیشن / دونقطه تا رسیدن به '['
      var j = i;
      while (j < str.length && (str[j] === '\\' || str[j] === '"' || str[j] === "'" || str[j] === ':' || str[j] === ' ')) {
        j++;
      }
      if (str[j] === '[') {
        var end = matchBracket(str, j);
        if (end > 0) {
          var parsed = tryParseJsonVariants(str.substring(j, end + 1));
          if (parsed && parsed.length && parsed[0] && typeof parsed[0] === 'object' &&
              (parsed[0].publicName || parsed[0].id)) {
            out.push(parsed);
          }
        }
      }
      pos = idx + key.length;
    }
    return out;
  }

  // پیدا کردن براکت بسته‌ی متناظر، با نادیده گرفتن کاراکترهای escape شده
  function matchBracket(str, start) {
    var depth = 0;
    for (var j = start; j < str.length; j++) {
      var ch = str[j];
      if (ch === '\\') { j++; continue; }
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) return j;
      }
    }
    return -1;
  }

  // تلاش برای parse کردن متن با اعمال چند لایه unescape متوالی
  function tryParseJsonVariants(raw) {
    var cur = raw;
    for (var k = 0; k < 4; k++) {
      try {
        return JSON.parse(cur);
      } catch(e) {}
      cur = unescapeOnce(cur);
    }
    return null;
  }

  // یک لایه از escapeهای جیسونی را برمی‌دارد (\" → " , \\ → \ و ...)
  function unescapeOnce(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      if (s[i] === '\\' && i + 1 < s.length) {
        var nxt = s[i + 1];
        if (nxt === '"') { out += '"'; i++; continue; }
        if (nxt === '\\') { out += '\u0001'; i++; continue; }
        if (nxt === 'n') { out += '\n'; i++; continue; }
        if (nxt === 'u' && i + 5 < s.length) {
          try {
            out += JSON.parse('"' + s.substring(i, i + 6) + '"');
            i += 5;
            continue;
          } catch(e) {}
        }
      }
      out += s[i];
    }
    return out.split('\u0001').join('\\');
  }

  // ========== استخراج Next.js server action hashes ==========
  function extractNextActions() {
    // فعلاً نیازی نیست؛ در صورت پشتیبانی از آپلود تصویر اضافه می‌شود
    return {};
  }

  // ========== گرفتن توکن reCAPTCHA ==========
  function getRecaptchaToken(action) {
    return new Promise(function(resolve, reject) {
      var g = window.grecaptcha && window.grecaptcha.enterprise
        ? window.grecaptcha.enterprise
        : window.grecaptcha;

      if (!g || typeof g.execute !== 'function') {
        reject(new Error('grecaptcha not available'));
        return;
      }

      g.ready(function() {
        g.execute(SITEKEY, { action: action || 'chat_submit' })
          .then(resolve)
          .catch(reject);
      });
    });
  }

  // ========== استخراج کوکی‌ها ==========
  function extractCookies() {
    var cookies = {};
    try {
      var cookieStr = document.cookie;
      if (cookieStr) {
        cookieStr.split(';').forEach(function(pair) {
          var parts = pair.trim().split('=');
          if (parts.length >= 2) {
            cookies[parts[0]] = parts.slice(1).join('=');
          }
        });
      }
    } catch(e) {
      console.error(TAG, 'extractCookies error:', e);
    }
    return cookies;
  }

  // ========== پردازش پیام‌ها ==========
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.from !== 'arena2api-content') return;

    var msg = event.data;
    var rid = msg.rid;

    switch (msg.type) {
      case 'GET_TOKEN':
        getRecaptchaToken(msg.action).then(function(token) {
          window.postMessage({
            from: 'arena2api-injector',
            type: 'TOKEN_OK',
            rid: rid,
            token: token,
            action: msg.action || 'chat_submit',
          }, '*');
        }).catch(function(err) {
          window.postMessage({
            from: 'arena2api-injector',
            type: 'TOKEN_ERR',
            rid: rid,
            error: err.message || String(err),
          }, '*');
        });
        break;

      case 'GET_MODELS':
        var models = extractModels();
        window.postMessage({
          from: 'arena2api-injector',
          type: 'MODELS_OK',
          rid: rid,
          models: models,
        }, '*');
        break;

      case 'GET_COOKIES':
        var cookies = extractCookies();
        window.postMessage({
          from: 'arena2api-injector',
          type: 'COOKIES_OK',
          rid: rid,
          cookies: cookies,
        }, '*');
        break;

      case 'CHECK':
        var g = window.grecaptcha && window.grecaptcha.enterprise
          ? window.grecaptcha.enterprise
          : window.grecaptcha;
        window.postMessage({
          from: 'arena2api-injector',
          type: 'CHECK_OK',
          rid: rid,
          recaptcha: !!(g && typeof g.execute === 'function'),
          enterprise: !!(window.grecaptcha && window.grecaptcha.enterprise),
        }, '*');
        break;
    }
  });

  // ========== اعلان آماده شدن ==========
  // کمی تأخیر تا content.js شروع به گوش دادن کند
  setTimeout(function() {
    var models = extractModels();
    var cookies = extractCookies();
    window.postMessage({
      from: 'arena2api-injector',
      type: 'INIT',
      models: models,
      cookies: cookies,
    }, '*');
    var sample = models ? models.filter(function(m){ return m && m.publicName; })
                               .slice(0, 5).map(function(m){ return m.publicName; }) : [];
    console.log(TAG, 'Injector ready, models:', models ? models.length : 0,
                '| sample names:', sample.join(', '),
                '| cookies:', Object.keys(cookies).join(', '));
  }, 1000);

})();
