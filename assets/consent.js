/*
 * phiredact — consent for analytics.
 *
 * PostHog initialises opted out on every page
 * (opt_out_capturing_by_default: true) and with in-memory persistence, so
 * nothing is captured and nothing is stored until this script applies a
 * stored choice:
 *
 *   localStorage "phiredact.consent" = "granted" -> opt in, no banner
 *   localStorage "phiredact.consent" = "denied"  -> stay opted out, no banner
 *   Global Privacy Control signal present        -> treated as a denial:
 *                                                   stay opted out, no banner,
 *                                                   and nothing is stored
 *                                                   (the signal is re-read on
 *                                                   every visit)
 *   no stored choice                             -> show the banner
 *
 * The choice itself is stored in a first-party localStorage entry.
 * Remembering a consent decision is strictly necessary for the consent
 * mechanism to work, so that entry is kept even when analytics are
 * declined. Before any choice, the site stores nothing at all: PostHog
 * runs in memory and only writes its identifier (upgraded persistence,
 * below) after a visitor allows analytics. PostHog also keeps its own
 * small marker of the opt-in/opt-out decision once one is made.
 *
 * Footer "Cookie settings" controls carry the data-consent-settings
 * attribute; clicking one re-opens the banner so consent can be changed or
 * withdrawn. Choosing again overwrites the stored value.
 *
 * posthog-js loads asynchronously and the inline stub does not queue the
 * opt-in/opt-out methods, so capture changes are applied through withPosthog,
 * which waits until the real library is present.
 */
(function () {
  'use strict';

  var KEY = 'phiredact.consent';

  function readChoice() {
    try {
      return window.localStorage.getItem(KEY);
    } catch (err) {
      return null;
    }
  }

  function storeChoice(value) {
    try {
      window.localStorage.setItem(KEY, value);
    } catch (err) {
      /* storage unavailable (private mode, disabled): the choice simply
         does not persist; capturing stays off either way. */
    }
  }

  function withPosthog(fn) {
    if (window.posthog && typeof window.posthog.opt_in_capturing === 'function') {
      fn(window.posthog);
      return;
    }
    var tries = 0;
    var timer = window.setInterval(function () {
      tries += 1;
      if (window.posthog && typeof window.posthog.opt_in_capturing === 'function') {
        window.clearInterval(timer);
        fn(window.posthog);
      } else if (tries >= 100) {
        window.clearInterval(timer);
      }
    }, 50);
  }

  function optIn() {
    withPosthog(function (posthog) {
      /* Consent given: only now may PostHog persist its identifier. */
      if (typeof posthog.set_config === 'function') {
        posthog.set_config({ persistence: 'localStorage+cookie' });
      }
      posthog.opt_in_capturing();
    });
  }

  function optOut() {
    withPosthog(function (posthog) {
      posthog.opt_out_capturing();
    });
  }

  /* The pages of this site are / and one directory per section, so the
     privacy page is "privacy/" from the home page and "../privacy/" from
     anywhere else. */
  function privacyHref() {
    var path = window.location.pathname.replace(/index\.html$/, '');
    var depth = path.split('/').filter(function (part) { return part !== ''; }).length;
    return (depth === 0 ? '' : '../') + 'privacy/';
  }

  var banner = null;

  function closeBanner() {
    if (banner && banner.parentNode) {
      banner.parentNode.removeChild(banner);
    }
    banner = null;
  }

  function showBanner() {
    if (banner) {
      return;
    }
    banner = document.createElement('div');
    banner.className = 'consent-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Cookie consent');

    var inner = document.createElement('div');
    inner.className = 'consent-in';

    var text = document.createElement('p');
    text.className = 'consent-text';
    text.appendChild(document.createTextNode('This site uses cookies for anonymous analytics \u2014 only if you allow it. '));
    var link = document.createElement('a');
    link.href = privacyHref();
    link.textContent = 'How this site handles your data';
    text.appendChild(link);
    inner.appendChild(text);

    var actions = document.createElement('div');
    actions.className = 'consent-actions';

    var allow = document.createElement('button');
    allow.type = 'button';
    allow.className = 'consent-btn';
    allow.textContent = 'Allow analytics';
    allow.addEventListener('click', function () {
      storeChoice('granted');
      optIn();
      closeBanner();
    });

    var decline = document.createElement('button');
    decline.type = 'button';
    decline.className = 'consent-btn';
    decline.textContent = 'Decline';
    decline.addEventListener('click', function () {
      storeChoice('denied');
      optOut();
      closeBanner();
    });

    actions.appendChild(allow);
    actions.appendChild(decline);
    inner.appendChild(actions);
    banner.appendChild(inner);
    document.body.appendChild(banner);
  }

  /* Withdrawal / re-choice: any "Cookie settings" control re-opens the
     banner. Capture state is unchanged until a new choice is made; the
     choice then overwrites the stored value. */
  document.addEventListener('click', function (event) {
    var target = event.target;
    var el = target && typeof target.closest === 'function'
      ? target.closest('[data-consent-settings]')
      : null;
    if (el) {
      showBanner();
    }
  });

  var choice = readChoice();
  if (choice === 'granted') {
    optIn();
  } else if (choice === 'denied') {
    /* Stay opted out (the default); nothing to do, no banner. */
  } else if (navigator.globalPrivacyControl === true) {
    /* An explicit opt-out signal: honour it like a stored denial, but
       store nothing — the signal is re-read on the next visit. */
    optOut();
  } else {
    if (document.body) {
      showBanner();
    } else {
      document.addEventListener('DOMContentLoaded', showBanner);
    }
  }
})();
