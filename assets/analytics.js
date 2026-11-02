/*
 * phiredact — named analytics events.
 *
 * A single delegated click listener turns data-ph-capture attributes into
 * PostHog events. Content-free by design: the only things ever sent are the
 * fixed event name in data-ph-capture and the fixed label properties in
 * data-ph-props — static attributes written in the markup, never user text
 * and never element text.
 */
(function () {
  'use strict';

  document.addEventListener('click', function (event) {
    if (!window.posthog || typeof window.posthog.capture !== 'function') {
      return;
    }
    var target = event.target;
    var el = target && typeof target.closest === 'function'
      ? target.closest('[data-ph-capture]')
      : null;
    if (!el) {
      return;
    }
    var name = el.getAttribute('data-ph-capture');
    if (!name) {
      return;
    }
    var props = {};
    var raw = el.getAttribute('data-ph-props');
    if (raw) {
      try {
        props = JSON.parse(raw);
      } catch (err) {
        props = {};
      }
    }
    window.posthog.capture(name, props);
  });
})();
