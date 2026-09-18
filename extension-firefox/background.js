/**
 * Arena AI Proxy - Background Script (Firefox, Manifest V2)
 *
 * مدیریت استخر توکن و کوکی‌ها و ارسال منظم به سرور پراکسی محلی
 *
 * نکته‌ی مهم فایرفاکس: فضای نام browser.* «پرامیس‌محور» است و callback
 * قبول نمی‌کند (پاس دادن تابع به‌عنوان آرگومان سوم sendMessage یا
 * آرگومان دوم storage.get خطای TypeError می‌دهد). به همین دلیل همه‌ی
 * فراخوانی‌ها در این فایل با async/await نوشته شده‌اند.
 */
(function() {
  'use strict';

  var TAG = '[Arena AI Proxy]';
  var api = typeof browser !== 'undefined' ? browser : chrome;

  // ========== وضعیت ==========
  var state = {
    proxyUrl: 'http://127.0.0.1:9090',
    connected: false,
    lastError: '',
    lastPush: 0,

    v3Tokens: [],   // [{token, action, ts}]
    v2Token: null,

    cookies: {},
    authToken: '',
    cfClearance: '',

    models: null,

    tabId: null,
  };

  // ========== پیام به تب (پرامیس‌محور) ==========
  async function sendToTab(msg) {
    if (!state.tabId) {
      try {
        var tabs = await api.tabs.query({ url: 'https://arena.ai/*' });
        if (tabs.length > 0) state.tabId = tabs[0].id;
        else return null;
      } catch(e) { return null; }
    }
    try {
      return await api.tabs.sendMessage(state.tabId, msg);
    } catch(e) {
      // تب بسته شده یا content script لود نشده
      state.tabId = null;
      return null;
    }
  }

  // ========== گرفتن کوکی‌ها از صفحه ==========
  async function requestPageCookies() {
    var resp = await sendToTab({ type: 'NEED_COOKIES' });
    return (resp && resp.cookies) ? resp.cookies : null;
  }

  // ========== تازه‌سازی کوکی‌ها ==========
  async function refreshCookies() {
    try {
      var byDomain = await api.cookies.getAll({ domain: 'arena.ai' });
      var byDotDomain = await api.cookies.getAll({ domain: '.arena.ai' });
      var byUrl = await api.cookies.getAll({ url: 'https://arena.ai' });

      state.cookies = {};
      byDomain.concat(byDotDomain).concat(byUrl).forEach(function(c) {
        state.cookies[c.name] = c.value;
      });

      var pageCookies = await requestPageCookies();
      if (pageCookies) {
        for (var k in pageCookies) {
          if (!state.cookies[k]) {
            state.cookies[k] = pageCookies[k];
          }
        }
      }

      state.cfClearance = state.cookies['cf_clearance'] || '';

      // توکن auth ممکن است تکه‌تکه ذخیره شده باشد
      var auth = state.cookies['arena-auth-prod-v1'] || '';
      if (!auth) {
        var p0 = state.cookies['arena-auth-prod-v1.0'] || '';
        var p1 = state.cookies['arena-auth-prod-v1.1'] || '';
        if (p0) {
          auth = p0 + (p1 || '');
        }
      }
      state.authToken = auth;
    } catch(e) {
      console.error(TAG, 'Cookie error:', e);
    }
  }

  // ========== مدیریت توکن‌ها ==========
  function addToken(token, action) {
    if (!token || token.length < 20) return;
    if (state.v3Tokens.some(function(t) { return t.token === token; })) return;
    state.v3Tokens.push({ token: token, action: action || 'chat_submit', ts: Date.now() });
    while (state.v3Tokens.length > 10) state.v3Tokens.shift();
    console.log(TAG, 'Token added (' + (action || 'chat_submit') + '), pool:', state.v3Tokens.length);
  }

  function cleanTokens() {
    var now = Date.now();
    state.v3Tokens = state.v3Tokens.filter(function(t) { return now - t.ts < 110000; });
  }

  function countAction(action) {
    return state.v3Tokens.filter(function(t) { return t.action === action; }).length;
  }

  // ========== درخواست توکن از content script ==========
  // action: 'chat_submit' (حالت مستقیم) یا 'agentic_chat_submit' (حالت ایجنت)
  var tokenInFlight = {};
  async function requestToken(action) {
    action = action || 'chat_submit';
    if (tokenInFlight[action]) return;
    tokenInFlight[action] = true;
    try {
      var resp = await sendToTab({ type: 'NEED_TOKEN', action: action });
      if (resp && resp.token) {
        addToken(resp.token, resp.action || action);
        await pushToServer();
      } else if (resp && resp.error) {
        console.warn(TAG, 'Token request failed:', resp.error);
      }
    } finally {
      tokenInFlight[action] = false;
    }
  }

  // ========== درخواست مجدد مدل‌ها از صفحه ==========
  async function requestModels() {
    var resp = await sendToTab({ type: 'NEED_MODELS' });
    if (resp && resp.models && resp.models.length > 0) {
      state.models = resp.models;
      console.log(TAG, 'Models received (retry):', resp.models.length);
      return true;
    }
    return false;
  }

  // ========== ارسال به سرور ==========
  var pushing = false;
  async function pushToServer() {
    if (!state.proxyUrl || pushing) return;
    pushing = true;
    try {
      await refreshCookies();
      cleanTokens();

      var data = {
        cookies: state.cookies,
        auth_token: state.authToken,
        cf_clearance: state.cfClearance,
        user_agent: navigator.userAgent,
        v3_tokens: state.v3Tokens.map(function(t) {
          return { token: t.token, action: t.action, age_ms: Date.now() - t.ts };
        }),
        v2_token: state.v2Token ? {
          token: state.v2Token.token,
          age_ms: Date.now() - state.v2Token.ts,
        } : null,
        models: state.models,
      };

      var url = state.proxyUrl.replace(/\/+$/, '') + '/v1/extension/push';
      var resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (resp.ok) {
        state.connected = true;
        state.lastError = '';
        state.lastPush = Date.now();
        var result = await resp.json();
        pushing = false;
        if (result.need_tokens) {
          requestToken('chat_submit');
        }
        if (result.need_agent_tokens) {
          setTimeout(function() { requestToken('agentic_chat_submit'); }, 1500);
        }
      } else {
        state.connected = false;
        state.lastError = 'HTTP ' + resp.status;
      }
    } catch(e) {
      state.connected = false;
      state.lastError = e.message || 'Connection failed';
    } finally {
      pushing = false;
    }
  }

  // ========== پردازش پیام‌ها ==========
  // در فایرفاکس اگر listener یک Promise برگرداند، مقدار resolve شده پاسخ است.
  api.runtime.onMessage.addListener(function(msg, sender) {
    switch (msg.type) {
      case 'TAB_READY':
        state.tabId = sender.tab ? sender.tab.id : null;
        console.log(TAG, 'Tab ready:', state.tabId);
        pushToServer();
        return Promise.resolve({ ok: true });

      case 'PAGE_INIT':
        if (msg.models && msg.models.length > 0) {
          state.models = msg.models;
          console.log(TAG, 'Models received:', msg.models.length);
        }
        if (msg.pageCookies) {
          for (var k in msg.pageCookies) {
            if (!state.cookies[k]) state.cookies[k] = msg.pageCookies[k];
          }
        }
        pushToServer();
        return Promise.resolve({ ok: true });

      case 'MODELS_UPDATE':
        if (msg.models && msg.models.length > 0) {
          state.models = msg.models;
          console.log(TAG, 'Models updated:', msg.models.length);
          pushToServer();
        }
        return Promise.resolve({ ok: true });

      case 'NEW_TOKEN':
        addToken(msg.token, msg.action);
        pushToServer();
        return Promise.resolve({ ok: true });

      case 'GET_STATUS':
        cleanTokens();
        return refreshCookies().then(function() {
          return {
            connected: state.connected,
            proxyUrl: state.proxyUrl,
            lastError: state.lastError,
            lastPush: state.lastPush,
            v3Count: state.v3Tokens.length,
            v3Chat: countAction('chat_submit'),
            v3Agent: countAction('agentic_chat_submit'),
            hasV2: !!state.v2Token,
            hasAuth: !!state.authToken,
            hasCf: !!state.cfClearance,
            hasModels: !!(state.models && state.models.length),
            modelCount: state.models ? state.models.length : 0,
            tabId: state.tabId,
          };
        });

      case 'SET_PROXY_URL':
        state.proxyUrl = msg.url;
        api.storage.local.set({ proxyUrl: msg.url });
        pushToServer();
        return Promise.resolve({ ok: true });

      case 'FORCE_PUSH':
        pushToServer();
        return Promise.resolve({ ok: true });

      case 'FORCE_TOKEN':
        requestToken('chat_submit');
        setTimeout(function() { requestToken('agentic_chat_submit'); }, 2000);
        return Promise.resolve({ ok: true });

      default:
        return Promise.resolve({ error: 'unknown' });
    }
  });

  // ========== کارهای زمان‌بندی‌شده ==========
  // دو استخر جدا: chat_submit برای حالت مستقیم، agentic_chat_submit برای حالت ایجنت
  function topUpTokens() {
    cleanTokens();
    if (countAction('chat_submit') < 3) {
      requestToken('chat_submit');
    }
    if (countAction('agentic_chat_submit') < 2) {
      setTimeout(function() { requestToken('agentic_chat_submit'); }, 2000);
    }
  }
  setInterval(topUpTokens, 80000);
  // اولین پر کردن استخر کمی بعد از استارت (وقتی تب آماده شد)
  setTimeout(topUpTokens, 8000);

  setInterval(function() { pushToServer(); }, 30000);

  // اگر مدل‌ها هنوز نیامده‌اند، چند بار دیگر از صفحه بپرس
  var modelRetries = 0;
  var modelTimer = setInterval(async function() {
    modelRetries++;
    if ((state.models && state.models.length > 0) || modelRetries > 8) {
      clearInterval(modelTimer);
      return;
    }
    if (await requestModels()) {
      clearInterval(modelTimer);
      pushToServer();
    }
  }, 7000);

  // ========== راه‌اندازی ==========
  (async function init() {
    try {
      var result = await api.storage.local.get(['proxyUrl']);
      if (result && result.proxyUrl) state.proxyUrl = result.proxyUrl;
    } catch(e) {}
    console.log(TAG, 'Proxy URL:', state.proxyUrl);
    pushToServer();
  })();

  api.tabs.onRemoved.addListener(function(tabId) {
    if (tabId === state.tabId) state.tabId = null;
  });

  api.cookies.onChanged.addListener(function(info) {
    if (info.cookie.domain.indexOf('arena.ai') >= 0) {
      refreshCookies();
    }
  });

  console.log(TAG, 'Background started (Firefox)');
})();
