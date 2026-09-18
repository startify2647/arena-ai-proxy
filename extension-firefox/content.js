/**
 * Arena AI Proxy - Content Script (Firefox, Manifest V2)
 *
 * پل پیام: injector.js <-> content.js <-> background.js
 */
(function() {
  'use strict';

  var TAG = '[Arena AI Proxy]';
  var api = typeof browser !== 'undefined' ? browser : chrome;
  var rid = 0;
  var pending = {};  // rid -> {resolve, reject, timer}

  // ========== ارسال پیام به injector.js ==========
  function callInjector(type, data) {
    var id = 'r' + (++rid) + '_' + Date.now();
    return new Promise(function(resolve, reject) {
      var timer = setTimeout(function() {
        delete pending[id];
        reject(new Error('Injector timeout'));
      }, 20000);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      var msg = { from: 'arena2api-content', type: type, rid: id };
      if (data) {
        for (var k in data) msg[k] = data[k];
      }
      window.postMessage(msg, '*');
    });
  }

  // ========== گوش دادن به پاسخ‌های injector.js ==========
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (!event.data || event.data.from !== 'arena2api-injector') return;

    var msg = event.data;

    if (msg.rid && pending[msg.rid]) {
      var p = pending[msg.rid];
      clearTimeout(p.timer);
      delete pending[msg.rid];
      if (msg.type.endsWith('_ERR')) {
        p.reject(new Error(msg.error || 'Unknown error'));
      } else {
        p.resolve(msg);
      }
      return;
    }

    if (msg.type === 'MODELS_UPDATE') {
      api.runtime.sendMessage({ type: 'MODELS_UPDATE', models: msg.models }).catch(function(){});
      return;
    }

    if (msg.type === 'INIT') {
      console.log(TAG, 'Injector initialized, models:', msg.models ? msg.models.length : 0);
      api.runtime.sendMessage({
        type: 'PAGE_INIT',
        models: msg.models,
        pageCookies: msg.cookies,
      }).catch(function(){});
      setTimeout(function() { fetchAndPushToken(); }, 2000);
    }
  });

  // ========== گرفتن توکن و ارسال به background ==========
  function fetchAndPushToken(action) {
    action = action || 'chat_submit';
    callInjector('GET_TOKEN', { action: action }).then(function(result) {
      if (result.token) {
        console.log(TAG, 'Got V3 token (' + action + '):', result.token.length, 'chars');
        api.runtime.sendMessage({
          type: 'NEW_TOKEN',
          token: result.token,
          action: result.action || 'chat_submit',
        }).catch(function(){});
      }
    }).catch(function(err) {
      console.warn(TAG, 'Token error:', err.message);
    });
  }

  // ========== گوش دادن به درخواست‌های background ==========
  // در فایرفاکس، برگرداندن Promise از listener = پاسخ async (بدون sendResponse)
  api.runtime.onMessage.addListener(function(msg) {
    if (msg.type === 'NEED_TOKEN') {
      return callInjector('GET_TOKEN', { action: msg.action || 'chat_submit' }).then(function(result) {
        return { token: result.token, action: result.action };
      }).catch(function(err) {
        return { error: err.message };
      });
    }

    if (msg.type === 'NEED_MODELS') {
      return callInjector('GET_MODELS').then(function(result) {
        return { models: result.models };
      }).catch(function(err) {
        return { error: err.message };
      });
    }

    if (msg.type === 'NEED_COOKIES') {
      return callInjector('GET_COOKIES').then(function(result) {
        return { cookies: result.cookies };
      }).catch(function(err) {
        return { error: err.message };
      });
    }

    if (msg.type === 'CHECK_PAGE') {
      return callInjector('CHECK').catch(function(err) {
        return { error: err.message };
      });
    }
  });

  // ========== راه‌اندازی ==========
  console.log(TAG, 'Content script loaded (Firefox)');
  api.runtime.sendMessage({ type: 'TAB_READY' }).catch(function(){});

  var checkCount = 0;
  var checker = setInterval(function() {
    checkCount++;
    if (checkCount > 30) {
      clearInterval(checker);
      return;
    }
    callInjector('CHECK').then(function(result) {
      if (result.recaptcha) {
        clearInterval(checker);
        console.log(TAG, 'reCAPTCHA ready, fetching tokens');
        fetchAndPushToken('chat_submit');
        setTimeout(function() { fetchAndPushToken('agentic_chat_submit'); }, 2500);
      }
    }).catch(function() {});
  }, 2000);

})();
