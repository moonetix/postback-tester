const note = document.getElementById('copy-note');
const timers = new WeakMap();

function say(text) {
  if (!note) return;
  note.textContent = '';
  setTimeout(() => {
    note.textContent = text;
  }, 30);
}

function selectText(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

async function copy(btn) {
  const target = document.getElementById(btn.dataset.copy);
  if (!target) return;
  const name = btn.dataset.name || 'Text';
  let ok = false;
  try {
    await navigator.clipboard.writeText(target.textContent);
    ok = true;
  } catch {
    selectText(target);
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
  }
  btn.textContent = ok ? 'Copied' : 'Select and copy';
  btn.classList.toggle('done', ok);
  btn.classList.toggle('fail', !ok);
  say(ok ? `${name} copied to the clipboard.` : `Copying is blocked in this browser. The ${name} is selected, copy it with the keyboard.`);
  clearTimeout(timers.get(btn));
  timers.set(btn, setTimeout(() => {
    btn.textContent = 'Copy';
    btn.classList.remove('done', 'fail');
  }, 2500));
}

for (const btn of document.querySelectorAll('button[data-copy]')) {
  btn.addEventListener('click', () => copy(btn));
}

for (const list of document.querySelectorAll('[role=tablist]')) {
  const tabs = [...list.querySelectorAll('[role=tab]')];
  const show = (tab, focus) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    }
    if (focus) tab.focus();
  };
  list.addEventListener('click', (ev) => {
    const tab = ev.target.closest('[role=tab]');
    if (tab) show(tab, false);
  });
  list.addEventListener('keydown', (ev) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let next = -1;
    if (ev.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (ev.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    show(tabs[next], true);
  });
}
