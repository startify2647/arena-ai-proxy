/**
 * Arena AI Proxy - Background Script (Firefox, Manifest V2)
 *
 * مدیریت استخر توکن و کوکی‌ها و ارسال منظم به سرور پراکسی محلی
 */
(function() {
  'use strict';

  var TAG = '[Arena AI Proxy]';
  // در فایرفاکس browser.* (پرامیس‌محور) وجود دارد و chrome.* هم سازگار است
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

  // ========== گرفتن کوکی‌ها از صفحه ==========
  async function requestPageCookies() {
    if (!state.tabId) return null;
    try {
      return await new Promise(function(resolve) {
        api.tabs.sendMessage(state.tabId, { type: 'NEED_COOKIES' }, function(resp) {
          if (api.runtime.lastError || !resp || !resp.cookies) {
            resolve(null);
          } else {
            resolve(resp.cookies);
          }
        });
      });
    } catch(e) {
      return null;
    }
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

      if (auth) {
        console.log(TAG, 'Auth Cookie found! Length:', auth.length);
      } else {
        console.log(TAG, 'Auth Cookie NOT found. Available cookies:', Object.keys(state.cookies));
      }
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
    console.log(TAG, 'Token added, pool:', state.v3Tokens.length);
  }

  function cleanTokens() {
    var now = Date.now();
    state.v3Tokens = state.v3Tokens.filter(function(t) { return now - t.ts < 110000; });
  }

  // ========== درخواست توکن از content script ==========
  // action می‌تواند 'chat_submit' (حالت مستقیم) یا
  // 'agentic_chat_submit' (حالت ایجنت) باشد.
  async function requestToken(action) {
    action = action || 'chat_submit';
    if (!state.tabId) {
      try {
        var tabs = await api.tabs.query({ url: 'https://arena.ai/*' });
        if (tabs.length > 0) state.tabId = tabs[0].id;
        else return;
      } catch(e) { return; }
    }
    try {
      api.tabs.sendMessage(state.tabId, {
        type: 'NEED_TOKEN',
        action: action,
      }, function(resp) {
        if (api.runtime.lastError) {
          state.tabId = null;
          return;
        }
        if (resp && resp.token) {
          addToken(resp.token, resp.action);
          pushToServer();
        }
      });
    } catch(e) {
      state.tabId = null;
    }
  }

  // ========== ارسال به سرور ==========
  async function pushToServer() {
    if (!state.proxyUrl) return;
    try {
      await refreshCookies();
      cleanTokens();

      var data = {
        cookies: state.cookies,
        auth_token: state.authToken,
        cf_clearance: state.cfClearance,
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
    }
  }

  // ========== پردازش پیام‌ها ==========
  api.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    switch (msg.type) {
      case 'TAB_READY':
        state.tabId = sender.tab ? sender.tab.id : null;
        console.log(TAG, 'Tab ready:', state.tabId);
        refreshCookies().then(function() { pushToServer(); });
        sendResponse({ ok: true });
        break;

      case 'PAGE_INIT':
        if (msg.models && msg.models.length > 0) {
          state.models = msg.models;
          console.log(TAG, 'Models received:', msg.models.length);
        }
        if (msg.pageCookies) {
          for (var k in msg.pageCookies) {
            if (!state.cookies[k]) {
              state.cookies[k] = msg.pageCookies[k];
            }
          }
          var auth = state.cookies['arena-auth-prod-v1'] || '';
          if (!auth) {
            var p0 = state.cookies['arena-auth-prod-v1.0'] || '';
            var p1 = state.cookies['arena-auth-prod-v1.1'] || '';
            if (p0) {
              auth = p0 + (p1 || '');
              state.authToken = auth;
              console.log(TAG, 'Auth token updated from page cookies! Length:', auth.length);
            }
          }
        }
        pushToServer();
        sendResponse({ ok: true });
        break;

      case 'NEW_TOKEN':
        addToken(msg.token, msg.action);
        pushToServer();
        sendResponse({ ok: true });
        break;

      case 'GET_STATUS':
        cleanTokens();
        refreshCookies().then(function() {
          sendResponse({
            connected: state.connected,
            proxyUrl: state.proxyUrl,
            lastError: state.lastError,
            lastPush: state.lastPush,
            v3Count: state.v3Tokens.length,
            hasV2: !!state.v2Token,
            hasAuth: !!state.authToken,
            hasCf: !!state.cfClearance,
            hasModels: !!(state.models && state.models.length),
            modelCount: state.models ? state.models.length : 0,
            tabId: state.tabId,
          });
        });
        return true;

      case 'SET_PROXY_URL':
        state.proxyUrl = msg.url;
        api.storage.local.set({ proxyUrl: msg.url });
        pushToServer();
        sendResponse({ ok: true });
        break;

      case 'FORCE_PUSH':
        pushToServer();
        sendResponse({ ok: true });
        break;

      case 'FORCE_TOKEN':
        requestToken();
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ error: 'unknown' });
    }
  });

  // تعداد توکن‌های سالم هر action
  function countAction(action) {
    return state.v3Tokens.filter(function(t) { return t.action === action; }).length;
  }

  // ========== کارهای زمان‌بندی‌شده ==========
  // دو استخر جدا: chat_submit برای حالت مستقیم، agentic_chat_submit برای حالت ایجنت
  setInterval(function() {
    cleanTokens();
    if (countAction('chat_submit') < 3) {
      requestToken('chat_submit');
    }
    if (countAction('agentic_chat_submit') < 2) {
      // کمی تأخیر تا دو فراخوان reCAPTCHA پشت‌سرهم تداخل نکنند
      setTimeout(function() { requestToken('agentic_chat_submit'); }, 2000);
    }
  }, 80000);

  setInterval(function() {
    pushToServer();
  }, 30000);

  // ========== راه‌اندازی ==========
  api.storage.local.get(['proxyUrl'], function(result) {
    if (result.proxyUrl) state.proxyUrl = result.proxyUrl;
    console.log(TAG, 'Proxy URL:', state.proxyUrl);
    refreshCookies().then(function() { pushToServer(); });
  });

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
