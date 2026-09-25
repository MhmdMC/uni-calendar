/* Apply the saved appearance before the page paints, including offline. */
(() => {
  const key = 'semester-planner-appearance';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = value => ['light', 'dark', 'system'].includes(value);
  let preference = 'light';
  try { const saved = JSON.parse(localStorage.getItem(key)); if (valid(saved)) preference = saved; } catch (_) {}
  function apply() {
    const dark = preference === 'dark' || (preference === 'system' && system.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]').content = dark ? '#11151d' : '#f6f7f9';
  }
  window.plannerTheme = {
    get: () => preference,
    save(value) {
      if (!valid(value)) return false;
      preference = value;
      apply();
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
    }
  };
  system.addEventListener('change', apply);
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    try { const value = JSON.parse(event.newValue); preference = valid(value) ? value : 'light'; } catch (_) { preference = 'light'; }
    apply();
  });
  apply();
})();
