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

    if (msg.type === 'INIT') {
      console.log(TAG, 'Injector initialized, models:', msg.models ? msg.models.length : 0);
      api.runtime.sendMessage({
        type: 'PAGE_INIT',
        models: msg.models,
        pageCookies: msg.cookies,
      });
      setTimeout(function() { fetchAndPushToken(); }, 2000);
    }
  });

  // ========== گرفتن توکن و ارسال به background ==========
  function fetchAndPushToken() {
    callInjector('GET_TOKEN', { action: 'chat_submit' }).then(function(result) {
      if (result.token) {
        console.log(TAG, 'Got V3 token:', result.token.length, 'chars');
        api.runtime.sendMessage({
          type: 'NEW_TOKEN',
          token: result.token,
          action: result.action || 'chat_submit',
        });
      }
    }).catch(function(err) {
      console.warn(TAG, 'Token error:', err.message);
    });
  }

  // ========== گوش دادن به درخواست‌های background ==========
  api.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    if (msg.type === 'NEED_TOKEN') {
      callInjector('GET_TOKEN', { action: msg.action || 'chat_submit' }).then(function(result) {
        sendResponse({ token: result.token, action: result.action });
      }).catch(function(err) {
        sendResponse({ error: err.message });
      });
      return true;
    }

    if (msg.type === 'NEED_MODELS') {
      callInjector('GET_MODELS').then(function(result) {
        sendResponse({ models: result.models });
      }).catch(function(err) {
        sendResponse({ error: err.message });
      });
      return true;
    }

    if (msg.type === 'NEED_COOKIES') {
      callInjector('GET_COOKIES').then(function(result) {
        sendResponse({ cookies: result.cookies });
      }).catch(function(err) {
        sendResponse({ error: err.message });
      });
      return true;
    }

    if (msg.type === 'CHECK_PAGE') {
      callInjector('CHECK').then(function(result) {
        sendResponse(result);
      }).catch(function(err) {
        sendResponse({ error: err.message });
      });
      return true;
    }
  });

  // ========== راه‌اندازی ==========
  console.log(TAG, 'Content script loaded (Firefox)');
  api.runtime.sendMessage({ type: 'TAB_READY' });

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
        console.log(TAG, 'reCAPTCHA ready, fetching token');
        fetchAndPushToken();
      }
    }).catch(function() {});
  }, 2000);

})();
