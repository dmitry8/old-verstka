// Список инструментов. Добавить новый = добавить строку.
const TOOLS = [
  { href: 'index.html',       title: 'Переверстка старого синтаксиса', desc: 'Старые теги и атрибуты → новый формат' },
  { href: 'ingredients.html', title: 'Счётчик ингредиентов',           desc: 'Таблица → счётчик ингредиентов' },
  { href: 'cycles.html',      title: 'Циклы',                          desc: 'Список статей → блоки цикла' },
];

(function () {
  const current = location.pathname.split('/').pop() || 'index.html';

  const dlg = document.createElement('dialog');
  dlg.className = 'nav-dialog';
  dlg.innerHTML = `
    <div class="nav-head">
      <span>Инструменты</span>
      <button type="button" class="btn btn-ghost" id="btn-nav-close" aria-label="Закрыть">✕</button>
    </div>
    <nav class="nav-list">
      ${TOOLS.map((t) => `
        <a href="${t.href}" class="nav-item${t.href === current ? ' active' : ''}">
          <span class="nav-title">${t.title}</span>
          <span class="nav-desc">${t.desc}</span>
        </a>`).join('')}
    </nav>
    <div class="nav-footer">
      <button type="button" class="nav-theme" id="btn-theme" aria-expanded="false">
        <svg class="nav-theme-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="9"/>
          <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>
        </svg>
        <span class="nav-theme-title">Тема оформления</span>
        <svg class="nav-theme-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 6l6 6-6 6"/>
        </svg>
      </button>
      <div class="nav-theme-menu" id="theme-menu" role="menu">
        <button type="button" class="nav-theme-option" data-theme="system" role="menuitemradio">Системная тема</button>
        <button type="button" class="nav-theme-option" data-theme="light" role="menuitemradio">Светлая</button>
        <button type="button" class="nav-theme-option" data-theme="dark" role="menuitemradio">Тёмная</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);

  document.getElementById('btn-menu').addEventListener('click', () => dlg.showModal());
  dlg.querySelector('#btn-nav-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

  // ---- тема оформления: system | light | dark ----
  // Класс theme-light / theme-dark вешается на <html>; для системной темы класса нет,
  // работает prefers-color-scheme из CSS. Выбор хранится в localStorage.
  const THEME_KEY = 'theme';
  const root = document.documentElement;
  const btnTheme = dlg.querySelector('#btn-theme');
  const themeMenu = dlg.querySelector('#theme-menu');
  const themeOptions = [...dlg.querySelectorAll('.nav-theme-option')];

  function applyTheme(theme) {
    root.classList.remove('theme-light', 'theme-dark');
    if (theme === 'light' || theme === 'dark') root.classList.add('theme-' + theme);
    themeOptions.forEach((o) => o.classList.toggle('active', o.dataset.theme === theme));
  }

  function setTheme(theme) {
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
  }

  applyTheme(localStorage.getItem(THEME_KEY) || 'system');

  function openMenu(open) {
    themeMenu.classList.toggle('open', open);
    btnTheme.setAttribute('aria-expanded', String(open));
  }

  // открытие по наведению: footer содержит и кнопку, и попап, поэтому
  // перемещение курсора между ними не считается уходом
  const footer = dlg.querySelector('.nav-footer');
  let closeTimer = null;
  footer.addEventListener('mouseenter', () => { clearTimeout(closeTimer); openMenu(true); });
  footer.addEventListener('mouseleave', () => { closeTimer = setTimeout(() => openMenu(false), 150); });

  // клик — запасной вариант для тача и клавиатуры
  btnTheme.addEventListener('click', (e) => {
    e.stopPropagation();
    openMenu(!themeMenu.classList.contains('open'));
  });
  themeOptions.forEach((o) => o.addEventListener('click', (e) => {
    e.stopPropagation();
    setTheme(o.dataset.theme);
    openMenu(false);
  }));

  // клик вне попапа, Esc или закрытие сайдбара — прячем попап
  dlg.addEventListener('click', (e) => { if (!e.target.closest('.nav-theme-menu')) openMenu(false); });
  dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') openMenu(false); });
  dlg.addEventListener('close', () => openMenu(false));
})();