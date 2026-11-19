// Applies the saved theme before the page draws, so there is no flash.
(function () {
  try {
    var t = localStorage.getItem('f3drop.theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage off: follow the device */ }
})();
