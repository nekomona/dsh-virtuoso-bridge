// Virtuoso Bridge documentation site — small progressive enhancements.
(function () {
  'use strict';

  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) {
        nav.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Copy buttons for code cards.
  document.querySelectorAll('.code-card').forEach(function (card) {
    var pre = card.querySelector('pre');
    if (!pre || !navigator.clipboard) return;
    var header = card.querySelector('header');
    if (header && header.firstElementChild) {
      header.firstElementChild.dataset.label = header.firstElementChild.textContent;
    }
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-button';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', 'Copy code to clipboard');
    button.addEventListener('click', function () {
      navigator.clipboard.writeText(pre.innerText).then(function () {
        button.textContent = 'Copied';
        button.classList.add('copied');
        setTimeout(function () {
          button.textContent = 'Copy';
          button.classList.remove('copied');
        }, 1600);
      }, function () {
        button.textContent = 'Press Ctrl+C';
        setTimeout(function () { button.textContent = 'Copy'; }, 1600);
      });
    });
    card.appendChild(button);
  });

  // Table-of-contents scrollspy on guide pages.
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.doc-toc a[href^="#"]'));
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var byId = new Map();
    var sections = [];
    tocLinks.forEach(function (link) {
      var id = decodeURIComponent(link.getAttribute('href').slice(1));
      var section = document.getElementById(id);
      if (!section) return;
      byId.set(id, link);
      sections.push(section);
    });
    var visible = new Set();
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      });
      var activeId = null;
      for (var i = sections.length - 1; i >= 0; i -= 1) {
        if (visible.has(sections[i].id)) { activeId = sections[i].id; break; }
      }
      if (!activeId) {
        var top = window.scrollY + 120;
        for (var j = 0; j < sections.length; j += 1) {
          if (sections[j].offsetTop <= top) activeId = sections[j].id;
        }
      }
      tocLinks.forEach(function (link) { link.classList.remove('is-active'); });
      if (activeId && byId.has(activeId)) byId.get(activeId).classList.add('is-active');
    }, { rootMargin: '-88px 0px -60% 0px', threshold: 0 });
    sections.forEach(function (section) { observer.observe(section); });
  }
})();
