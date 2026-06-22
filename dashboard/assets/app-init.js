/* ── Mawjah Design System — Scroll Reveal ── */
(function() {
  if (typeof IntersectionObserver === 'undefined') return;
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach((e, i) => {
      if (e.isIntersecting) {
        e.target.style.transitionDelay = (i * 0.06) + 's';
        e.target.classList.add('revealed');
        revealObserver.unobserve(e.target);
      }
    });
  }, { threshold: 0.08 });
  function initReveal() {
    document.querySelectorAll('.card-outer, .panel, .stat-card, .summary-card, .movers-panel, .presignal-panel, .scoring-card, .breadth-container, .regime-panel').forEach(el => {
      if (!el.classList.contains('reveal-ready')) {
        el.classList.add('reveal-ready');
        revealObserver.observe(el);
      }
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initReveal);
  } else {
    initReveal();
  }
})();