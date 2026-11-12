import { initTool, findTagEnd, findClosingTag } from './common.js';

const INDENT = '    ';     // 4 пробела
const getPortions = () => (document.getElementById('portions')?.value || '2').trim();
const getUnit = () => (document.getElementById('recipe-unit')?.value || 'порция').trim();

// &nbsp; и неразрывный пробел → обычный пробел
function decodeSpaces(s) {
  return s.replace(/&nbsp;|&#160;|\u00a0/g, ' ');
}

// кавычки в значении атрибута
function escAttr(s) {
  return s.replace(/"/g, '&quot;');
}

// "160 г" → { amount: "160", unit: "г" }; "По вкусу" → { amount: "", unit: "По вкусу" }
// Временное простое правило: число в начале — в amount, остальное — в unit.
function parseQuantity(raw) {
  const text = decodeSpaces(raw)
    .replace(/<[^>]*>/g, '')     // теги во второй колонке выбрасываем
    .replace(/\s+/g, ' ')
    .trim();
  const m = text.match(/^(\d+\/\d+|\d+(?:[.,]\d+)?)\s*(.*)$/);
  if (m) return { amount: normalizeNumber(m[1]), unit: m[2] };
  return { amount: '', unit: text };
}

// "1,5" → "1.5"; дроби вида "1/2" переносим как есть
function normalizeNumber(s) {
  return s.replace(',', '.');
}

// строки и ячейки таблицы с абсолютными позициями в исходнике
function parseRows(html, table) {
  const rows = [];
  const inner = html.slice(table.openEnd, table.closeStart);
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let tm;
  while ((tm = trRe.exec(inner))) {
    const rowStart = table.openEnd + tm.index;
    const rowEnd = rowStart + tm[0].length;
    const innerStart = rowStart + tm[0].indexOf(tm[1]);
    const cells = [];
    const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cm;
    while ((cm = tdRe.exec(tm[1]))) {
      const cStart = innerStart + cm.index;
      cells.push({ start: cStart, end: cStart + cm[0].length, inner: cm[1] });
    }
    rows.push({ start: rowStart, end: rowEnd, cells });
  }
  return rows;
}

function fix(html) {
  const marks = [];
  const diagnostics = [];
  const messages = [];
  const addError = (from, to, message) => {
    if (to <= from) to = from + 1;
    marks.push({ from, to, cls: 'hl-error' });
    diagnostics.push({ from, to, message });
  };

  // ---- 1. режем исходник на блоки: heading / table / text ----
  const blocks = [];
  const re = /<(h3|table)\b/gi;
  let pos = 0, m;
  while ((m = re.exec(html))) {
    const lt = m.index;
    const tag = m[1].toLowerCase();
    const gt = findTagEnd(html, lt);
    if (gt === -1) break;
    const close = findClosingTag(html, gt + 1, tag);
    if (!close) {
      addError(lt, gt + 1, `Не найден парный </${tag}> — элемент пропущен.`);
      re.lastIndex = gt + 1;
      continue;
    }
    if (pos < lt) blocks.push({ type: 'text', start: pos, end: lt });
    blocks.push({ type: tag === 'h3' ? 'heading' : 'table', start: lt, end: close.end, openEnd: gt + 1, closeStart: close.start });
    pos = close.end;
    re.lastIndex = close.end;
  }
  if (pos < html.length) blocks.push({ type: 'text', start: pos, end: html.length });

  // ---- 2. собираем результат ----
  const out = [];
  let pendingHeading = null;   // заголовок, который ещё ждёт свою таблицу

  for (const b of blocks) {
    if (b.type === 'text') {
      const chunk = html.slice(b.start, b.end);
      if (chunk.trim() !== '') {
        const lead = chunk.match(/^\s*/)[0].length, trail = chunk.match(/\s*$/)[0].length;
        addError(b.start + lead, b.end - trail, 'Текст вне таблицы — в результат не попадает.');
      }
      continue;
    }

    if (b.type === 'heading') {
      if (pendingHeading) addError(pendingHeading.start, pendingHeading.openEnd, 'После заголовка нет таблицы.');
      const inner = html.slice(b.openEnd, b.closeStart).trim();
      out.push(`<h3 level="3">${inner}</h3>`);
      pendingHeading = b;
      continue;
    }

    // ---- таблица ----
    if (!pendingHeading) {
      messages.push({ text: 'Перед таблицей нет заголовка — результат собран без заголовка.' });
    }
    pendingHeading = null;

    const rows = parseRows(html, b);
    if (rows.length === 0) {
      addError(b.start, b.openEnd, 'В таблице нет строк <tr> — таблица пропущена.');
      continue;
    }

    // больше трёх ячеек в строке — таблица оформлена неверно, целиком не конвертируем
    const tooWide = rows.find((r) => r.cells.length > 3);
    if (tooWide) {
      const lineNo = html.slice(0, tooWide.start).split('\n').length;
      messages.push({ text: `Таблица пропущена: в строке ${lineNo} исходника ${tooWide.cells.length} ячейки, а допустимо не больше трёх. Проверьте разметку таблицы.` });
      addError(tooWide.start, tooWide.end, 'В строке больше трёх ячеек — таблица пропущена.');
      continue;
    }

    // есть хоть одна строка с тремя ячейками → таблица с группами
    const grouped = rows.some((r) => r.cells.length === 3);
    const ind = grouped ? INDENT + INDENT : INDENT;   // внутри recipe-group ингредиенты на уровень глубже
    const lines = [`<recipe portions="${escAttr(getPortions())}" unit="${escAttr(getUnit())}">`];
    let groupOpen = false;

    const pushIngredient = (nameCell, qtyCell, row) => {
      // первая колонка — как есть, только срезаем пробелы по краям
      const name = nameCell.inner.trim();
      if (name === '') addError(nameCell.start, nameCell.end, 'Пустое название ингредиента.');
      let amount = '', unit = '';
      if (!qtyCell) {
        addError(row.start, row.end, 'В строке не хватает ячейки с количеством — оно не заполнено.');
      } else {
        ({ amount, unit } = parseQuantity(qtyCell.inner));
        if (amount !== '' && unit === '') addError(qtyCell.start, qtyCell.end, 'Число без единицы измерения — unit оставлен пустым.');
      }
      lines.push(`${ind}<ingredient amount="${escAttr(amount)}" unit="${escAttr(unit)}">`);
      lines.push(`${ind}${INDENT}${name}`);
      lines.push(`${ind}</ingredient>`);
    };

    const openGroup = (title) => {
      if (groupOpen) lines.push(`${INDENT}</recipe-group>`);
      lines.push(`${INDENT}<recipe-group>`);
      lines.push(`${INDENT}${INDENT}<title>${title}</title>`);
      groupOpen = true;
    };

    for (const row of rows) {
      const c = row.cells;
      if (c.length === 0) { addError(row.start, row.end, 'В строке нет ячеек — строка пропущена.'); continue; }

      if (!grouped) { pushIngredient(c[0], c[1], row); continue; }

      if (c.length === 3) {
        // три ячейки — начало новой группы: название + первый ингредиент
        const title = c[0].inner.trim();
        if (title === '') addError(c[0].start, c[0].end, 'Пустое название группы.');
        openGroup(title);
        pushIngredient(c[1], c[2], row);
      } else {
        if (!groupOpen) {
          addError(row.start, row.end, 'Строка идёт до первой группы — создана группа с пустым названием.');
          openGroup('');
        }
        pushIngredient(c[0], c[1], row);
      }
    }
    if (groupOpen) lines.push(`${INDENT}</recipe-group>`);
    lines.push('</recipe>');
    out.push(lines.join('\n'));
  }

  if (pendingHeading) addError(pendingHeading.start, pendingHeading.openEnd, 'После заголовка нет таблицы.');

  return { output: out.join('\n\n'), marks, diagnostics, messages };
}

const tool = initTool({ fix, placeholder: 'Вставьте таблицу сюда…' });

// поменяли порции — пересчитываем результат, если он уже есть
document.getElementById('portions')?.addEventListener('input', () => tool.run());
document.getElementById('recipe-unit')?.addEventListener('input', () => tool.run());