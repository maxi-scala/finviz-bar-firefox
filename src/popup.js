/* Popup for toggling display mode */
(function(){
  const storage = (typeof browser !== 'undefined' && browser.storage) ? browser.storage : (typeof chrome !== 'undefined' ? chrome.storage : null);
  if (!storage || !storage.local) return;

  const radios = Array.from(document.querySelectorAll('input[name="mode"]'));
  function setChecked(val){
    radios.forEach(r => { r.checked = (r.value === val); });
  }

  storage.local.get('displayMode').then((res) => {
    const mode = res && res.displayMode ? res.displayMode : 'embedded';
    setChecked(mode);
  });

  radios.forEach(r => {
    r.addEventListener('change', async () => {
      try {
        await storage.local.set({ displayMode: r.value });
      } catch (e) {}
    });
  });
})();
