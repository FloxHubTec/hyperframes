// Studio download links name this visitor's PostHog id (`ph_id`), so hyperframes.dev counts the download under the
// same person as these docs' pageviews. Both sites send to one PostHog project, but each domain has its own cookie,
// so the download site cannot read this one. The id is added at click time only, so a copied link never carries it.
(function () {
  var COOKIE = 'ph_phc_zjjbX0PnWxERXrMHhkEJWj9A9BhGVLRReICgsfTMmpx_posthog';
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function posthogId() {
    var prefix = COOKIE + '=';
    var raw = document.cookie.split('; ').find(function (c) {
      return c.indexOf(prefix) === 0;
    });
    if (!raw) return null;
    try {
      var id = JSON.parse(decodeURIComponent(raw.slice(prefix.length))).distinct_id;
      return typeof id === 'string' && UUID.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  function tag(event) {
    var link = event.target instanceof Element && event.target.closest('a[href]');
    if (!link) return;
    var url;
    try {
      url = new URL(link.href);
    } catch {
      return;
    }
    if (!/(^|\.)hyperframes\.dev$/.test(url.hostname) || url.pathname !== '/studio/download') return;
    var id = posthogId();
    if (!id) return;
    var original = link.getAttribute('href');
    url.searchParams.set('ph_id', id);
    link.href = url.toString();
    // Put the link back once the browser has followed it, so copying it later still leaves the id out.
    setTimeout(function () {
      link.setAttribute('href', original);
    }, 0);
  }

  // Capture phase, before the browser follows the link; auxclick covers a middle-click into a new tab.
  document.addEventListener('click', tag, true);
  document.addEventListener('auxclick', tag, true);
})();
