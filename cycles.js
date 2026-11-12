import { initTool } from './common.js';

// схлопываем пробелы, &nbsp; → пробел
const clean = (s) => s.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

// Google Docs оборачивает ссылки в редирект: google.com/url?q=<реальный url>&sa=…
function unwrapGoogleUrl(href) {
  try {
    const u = new URL(href);
    if (/(^|\.)google\.com$/.test(u.hostname) && u.pathname === '/url') {
      const q = u.searchParams.get('q');
      if (q) return q;
    }
  } catch { /* не URL — вернём как есть */ }
  return href;
}

// ---- вход: HTML (буфер из Google Docs / браузера, либо HTML-код, вставленный как текст) ----
function fromHtml(htmlData) {
  const doc = new DOMParser().parseFromString(htmlData, 'text/html');
  const anchors = [...doc.querySelectorAll('a[href]')];
  const links = anchors
    .map((a) => ({ title: clean(a.textContent), url: unwrapGoogleUrl(a.getAttribute('href')) }))
    .filter((l) => /^https?:\/\//i.test(l.url));
  if (!links.length) return null;

  // заголовок — первый текстовый блок до первой ссылки, сам без ссылок внутри
  const firstLink = anchors[0];
  const blocks = [...doc.body.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,td,div')];
  const headBlock = blocks.find((el) =>
    clean(el.textContent) && !el.querySelector('a') &&
    (el.compareDocumentPosition(firstLink) & Node.DOCUMENT_POSITION_FOLLOWING));
  const heading = headBlock ? clean(headBlock.textContent) : '';

  return { heading, links };
}

// ---- вход: простой текст ----
function fromText(text) {
  if (/<a\b[^>]*href/i.test(text)) return fromHtml(text);                 // HTML-код вставили как текст
  if (/\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(text)) return null;           // уже наш формат — не трогаем

  const links = [];
  let heading = '';
  for (const raw of text.split(/\r?\n/)) {
    // срезаем мусор по краям: |, #, маркеры списков, нумерацию
    const line = clean(raw.replace(/^[\s|#*\-•]+|^\s*\d+[.)]\s+/g, '').replace(/[\s|,]+$/, ''));
    if (!line) continue;
    const urls = line.match(/https?:\/\/\S+/g);
    if (urls) {
      const url = urls[urls.length - 1].replace(/[),.;]+$/, '');
      const title = clean(line.replace(url, '').replace(/[—–\-:→>]+\s*$/, ''));
      links.push({ title, url });
    } else if (!heading && !links.length) {
      heading = line;
    }
  }
  if (!links.length) return null;   // ссылок нет — обычная вставка, парсер потом подсветит
  return { heading, links };
}

// ---- единый вид в левом поле: заголовок обычным текстом, статьи — [название](url) ----
function toCanonical({ heading, links }) {
  const lines = [];
  if (heading) lines.push(heading, '');
  for (const l of links) lines.push(`[${l.title}](${l.url})`);
  return lines.join('\n');
}

function onPaste({ text, html }) {
  const parsed = (html && /<a\b[^>]*href/i.test(html) ? fromHtml(html) : null) || fromText(text || '');
  return parsed ? toCanonical(parsed) : null;
}

// последний непустой сегмент пути: https://t-j.ru/list/good-germany/?utm=1 → good-germany
function slugFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  } catch {
    return '';
  }
}

// «Как переехать в Сербию» → Как переехать в Сербию (внешние кавычки долой)
const stripQuotes = (s) => s.replace(/^[«"“]\s*/, '').replace(/\s*[»"”]$/, '');

function fix(src) {
  const marks = [];
  const diagnostics = [];
  const messages = [];
  const addError = (from, to, message) => {
    if (to <= from) to = from + 1;
    marks.push({ from, to, cls: 'hl-error' });
    diagnostics.push({ from, to, message });
  };

  const linkRe = /^\[([^\]]*)\]\(([^)]*)\)$/;
  let heading = null;        // { text, from, to }
  const articles = [];
  const seen = new Map();    // slug → первая статья

  let offset = 0;
  for (const raw of src.split('\n')) {
    const from = offset;
    offset += raw.length + 1;
    const line = raw.trim();
    if (!line) continue;
    const lead = raw.indexOf(line);
    const lFrom = from + lead, lTo = lFrom + line.length;

    const m = line.match(linkRe);
    if (m) {
      const title = clean(m[1]);
      const url = m[2].trim();
      const slug = slugFromUrl(url);
      if (!title) { addError(lFrom, lTo, 'У ссылки пустой заголовок — статья пропущена.'); continue; }
      if (!slug) { addError(lFrom, lTo, 'Из ссылки не удалось получить слаг — в конфиге slug оставлен пустым.'); articles.push({ slug: '', title }); continue; }
      if (seen.has(slug)) { addError(lFrom, lTo, `Слаг «${slug}» уже встречался выше — статья пропущена.`); continue; }
      seen.set(slug, true);
      articles.push({ slug, title });
      continue;
    }

    if (!heading && articles.length === 0) {
      heading = { text: clean(line.replace(/^#+\s*/, '')), from: lFrom, to: lTo };
      continue;
    }
    addError(lFrom, lTo, 'У строки нет ссылки — в конфиге slug оставлен пустым.');
    articles.push({ slug: '', title: clean(line) });
  }

  // ---- название цикла ----
  let name = '';
  if (!heading) {
    messages.push({ text: 'Не найден заголовок цикла. Первая строка должна быть вида «Эта статья — часть сборника «…»».' });
  } else {
    const idx = heading.text.search(/часть\s+сборника/i);
    if (idx === -1) {
      addError(heading.from, heading.to, 'В заголовке нет слов «часть сборника» — название цикла взято из всей строки.');
      name = heading.text;
    } else {
      name = heading.text.slice(idx).replace(/^часть\s+сборника\s*/i, '').trim();
      if (!name) addError(heading.from, heading.to, 'После «часть сборника» нет названия цикла.');
    }
  }

  if (articles.length === 0) {
    messages.push({ text: 'Не найдено ни одной ссылки на статью — нечего конвертировать. Проверьте, что при копировании из документа ссылки сохранились.' });
    return { output: '', marks, diagnostics, extras: [], messages };
  }

  // ---- выдача ----
  if (!articles[0].slug) messages.push({ text: 'У первой статьи нет ссылки — слаг цикла не заполнен.' });
  const cycleSlug = `cycle-${articles[0].slug}`;
  const json = JSON.stringify({ cycle: articles }, null, 2);
  const h3 = heading
    ? `<h3 level="3">Эта статья — часть сборника<br/> ${name}</h3>`
    : `<h3 level="3"></h3>`;
  const htmlBlock = `${h3}\n<cycle config="${cycleSlug}"></cycle>`;
  const configName = `Цикл: ${stripQuotes(name)}`;

  return {
    output: json,
    marks,
    diagnostics,
    messages,
    extras: [
      { label: 'Название конфига', text: configName },
      { label: 'Слаг цикла', text: cycleSlug },
      { label: 'HTML-блок', text: htmlBlock, multiline: true },
    ],
  };
}

initTool({ fix, onPaste, placeholder: 'Вставьте список статей сюда…' });