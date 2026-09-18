/**
 * [FIREFOX] این نسخه برای Manifest V2 است؛ دسترسی به متغیرهای صفحه از طریق wrappedJSObject انجام می‌شود.
 *
 * Arena2API - Injector (MAIN world)  —  نسخه‌ی وصله‌شده v2
 *
 * در «دنیای اصلی» صفحه اجرا می‌شود و دسترسی مستقیم دارد به:
 * - PW.grecaptcha.enterprise
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

  // پنجره‌ی واقعی صفحه — در فایرفاکس از Xray عبور می‌کند
  var PW = (typeof window !== 'undefined' && window.wrappedJSObject) ? window.wrappedJSObject : window;
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // ========== استخراج لیست مدل‌ها ==========
  function extractModels() {
    try {
      // روش ۱: __NEXT_DATA__ (ساختار قدیمی Pages Router — برای سازگاری نگه داشته شده)
      var nd = PW.__NEXT_DATA__;
      if (nd && nd.props && nd.props.pageProps && nd.props.pageProps.initialModels) {
        return nd.props.pageProps.initialModels;
      }

      // جمع‌آوری همه‌ی منابع متنیِ ممکن
      var chunks = [];
      if (PW.__next_f && PW.__next_f.length) {
        for (var i = 0; i < PW.__next_f.length; i++) {
          var entry = PW.__next_f[i];
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
      var g = PW.grecaptcha && PW.grecaptcha.enterprise
        ? PW.grecaptcha.enterprise
        : PW.grecaptcha;

      if (!g || typeof g.execute !== 'function') {
        reject(new Error('grecaptcha not available'));
        return;
      }

      var act = action || 'chat_submit';
      var done = false;
      function ok(t)  { if (!done) { done = true; resolve(t); } }
      function bad(e) { if (!done) { done = true; reject(e instanceof Error ? e : new Error(String(e))); } }

      // [FIREFOX] هر تابع/آبجکتی که به کد صفحه پاس می‌دهیم باید با
      // exportFunction / cloneInto صادر شود؛ وگرنه صفحه هنگام صدا زدن آن
      // خطای «Permission denied to access object» می‌گیرد و callback هرگز اجرا نمی‌شود.
      var isXray = (typeof exportFunction === 'function' && typeof cloneInto === 'function' && PW !== window);

      function runExecute() {
        try {
          var opts = isXray ? cloneInto({ action: act }, PW) : { action: act };
          var p = g.execute(SITEKEY, opts);
          if (isXray) {
            p.then(exportFunction(ok, PW), exportFunction(bad, PW));
          } else {
            p.then(ok, bad);
          }
        } catch (e) { bad(e); }
      }

      try {
        if (typeof g.ready === 'function') {
          g.ready(isXray ? exportFunction(runExecute, PW) : runExecute);
        } else {
          runExecute();
        }
      } catch (e) { bad(e); }

      // مهلت ایمنی: اگر ready هیچ‌وقت صدا نزد
      setTimeout(function() { bad(new Error('recaptcha execute timeout')); }, 15000);
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
        var g = PW.grecaptcha && PW.grecaptcha.enterprise
          ? PW.grecaptcha.enterprise
          : PW.grecaptcha;
        window.postMessage({
          from: 'arena2api-injector',
          type: 'CHECK_OK',
          rid: rid,
          recaptcha: !!(g && typeof g.execute === 'function'),
          enterprise: !!(PW.grecaptcha && PW.grecaptcha.enterprise),
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

    // اگر مدل‌ها هنوز نرسیده‌اند (RSC payload دیر می‌آید)، چند بار دیگر تلاش کن
    if (!models || models.length === 0) {
      var tries = 0;
      var t = setInterval(function() {
        tries++;
        var m = extractModels();
        if (m && m.length > 0) {
          clearInterval(t);
          console.log(TAG, 'Models found on retry #' + tries + ':', m.length);
          window.postMessage({ from: 'arena2api-injector', type: 'MODELS_UPDATE', models: m }, '*');
        } else if (tries >= 10) {
          clearInterval(t);
          console.warn(TAG, 'Models still not found after retries (Agent Mode does not need them)');
        }
      }, 3000);
    }
  }, 1000);

})();
