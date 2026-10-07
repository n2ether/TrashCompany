(function () {
  document.addEventListener('DOMContentLoaded', function () {
    var navToggle = document.querySelector('[data-nav-toggle]');
    var siteNav = document.getElementById('site-nav');
    if (navToggle && siteNav) {
      navToggle.addEventListener('click', function () {
        var open = siteNav.classList.toggle('is-open');
        navToggle.setAttribute('aria-expanded', String(open));
      });
    }

    var sidebar = document.getElementById('sidebar');
    var scrim = document.querySelector('[data-scrim]');
    var sideToggle = document.querySelector('[data-sidebar-toggle]');
    function setSidebar(open) {
      if (!sidebar) return;
      sidebar.classList.toggle('is-open', open);
      if (scrim) scrim.classList.toggle('is-open', open);
      if (sideToggle) sideToggle.setAttribute('aria-expanded', String(open));
    }
    if (sideToggle) sideToggle.addEventListener('click', function () { setSidebar(!sidebar.classList.contains('is-open')); });
    if (scrim) scrim.addEventListener('click', function () { setSidebar(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setSidebar(false); });

    var errorBox = document.querySelector('[data-autofocus]');
    if (errorBox) errorBox.focus();

    document.querySelectorAll('form[data-confirm]').forEach(function (form) {
      form.addEventListener('submit', function (e) {
        if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
      });
    });

    document.querySelectorAll('[data-print]').forEach(function (btn) {
      btn.addEventListener('click', function () { window.print(); });
    });

    document.querySelectorAll('[data-fill-login]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.getElementById('email').value = btn.getAttribute('data-email');
        document.getElementById('password').value = btn.getAttribute('data-password');
        document.getElementById('password').focus();
      });
    });

    // Show only the request fields relevant to the chosen service type.
    var typeInputs = document.querySelectorAll('input[name="type"]');
    function syncType() {
      var checked = document.querySelector('input[name="type"]:checked');
      var type = checked ? checked.value : '';
      document.querySelectorAll('[data-show-for]').forEach(function (el) {
        var show = el.getAttribute('data-show-for').split(',').indexOf(type) !== -1;
        el.hidden = !show;
      });
    }
    typeInputs.forEach(function (i) { i.addEventListener('change', syncType); });
    if (typeInputs.length) syncType();

    var gigToggle = document.querySelector('[data-gig-toggle]');
    var gigPanel = document.querySelector('[data-gig-panel]');
    var supervisor = document.getElementById('supervisor_id');
    if (gigToggle) {
      var syncGig = function () {
        if (gigPanel) gigPanel.hidden = !gigToggle.checked;
        if (supervisor) supervisor.required = !gigToggle.checked;
      };
      gigToggle.addEventListener('change', syncGig);
      syncGig();
    }

    var repeat = document.querySelector('[data-repeat-toggle]');
    var repeatPanel = document.querySelector('[data-repeat-panel]');
    if (repeat && repeatPanel) {
      var sync = function () { repeatPanel.hidden = !repeat.checked; };
      repeat.addEventListener('change', sync);
      sync();
    }
  });
})();
