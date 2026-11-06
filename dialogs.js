/* 弹窗栈、键盘循环和背景隔离；不依赖业务状态。 */
(function () {
  'use strict';
  window.TianDaoDialogs = {
    create: function (beforeEscape) {
      var stack = [];
      var originalInert = new Map();
      function top() { return stack[stack.length - 1]; }
      function visible(element) {
        return element && element.isConnected && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
      }
      function controls(mask) {
        return Array.from(mask.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')).filter(function (element) {
          return !element.disabled && element.tabIndex >= 0 && !element.closest('[inert]') && visible(element);
        });
      }
      function syncBackground() {
        originalInert.forEach(function (value, element) { element.inert = value; });
        if (!top()) { originalInert.clear(); return; }
        Array.from(document.body.children).forEach(function (element) {
          if (element === top().mask || element.id === 'toastStack' || /^(SCRIPT|STYLE|LINK)$/.test(element.tagName)) { return; }
          if (!originalInert.has(element)) { originalInert.set(element, element.inert); }
          element.inert = true;
        });
      }
      function firstFocus(mask) {
        var target = controls(mask)[0] || mask.querySelector('[role="dialog"]') || mask;
        if (target.tabIndex < 0) { target.tabIndex = -1; }
        target.focus({ preventScroll: true });
      }
      document.addEventListener('keydown', function (event) {
        var active = top();
        if (!active) { return; }
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopImmediatePropagation();
          if (!beforeEscape || !beforeEscape()) { active.close(); }
        } else if (event.key === 'Tab') {
          var items = controls(active.mask);
          var index = items.indexOf(document.activeElement);
          if (!items.length || index < 0 || (!event.shiftKey && index === items.length - 1) || (event.shiftKey && index === 0)) {
            event.preventDefault();
            if (items.length) { items[event.shiftKey ? items.length - 1 : 0].focus({ preventScroll: true }); }
            else { firstFocus(active.mask); }
          }
        }
      }, true);
      document.addEventListener('focusin', function (event) {
        if (top() && !top().mask.contains(event.target)) { firstFocus(top().mask); }
      });
      return {
        activeMask: function () { return top() ? top().mask : null; },
        open: function (mask, close, target) {
          if (!stack.some(function (item) { return item.mask === mask; })) {
            stack.push({ mask: mask, close: close, opener: document.activeElement, zIndex: mask.style.zIndex });
          }
          mask.classList.remove('hidden');
          mask.style.zIndex = String(120 + stack.findIndex(function (item) { return item.mask === mask; }));
          syncBackground();
          if (target && visible(target)) { target.focus({ preventScroll: true }); }
          else { firstFocus(mask); }
        },
        close: function (mask, restoreFocus) {
          var index = stack.findIndex(function (item) { return item.mask === mask; });
          var item = stack[index];
          var wasTop = item && item === top();
          if (item) { stack.splice(index, 1); mask.style.zIndex = item.zIndex; }
          mask.classList.add('hidden');
          syncBackground();
          if (!wasTop || restoreFocus === false) { return; }
          if (visible(item.opener) && !item.opener.closest('[inert]')) { item.opener.focus({ preventScroll: true }); }
          else if (top()) { firstFocus(top().mask); }
          else {
            var fallback = document.querySelector('[role="tab"][aria-selected="true"]');
            if (fallback) { fallback.focus({ preventScroll: true }); }
          }
        }
      };
    }
  };
})();
