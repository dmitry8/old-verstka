import { EditorState, StateField, StateEffect, RangeSet } from '@codemirror/state';
import { EditorView, Decoration, GutterMarker, lineNumbers, lineNumberMarkers,
         highlightActiveLine, highlightActiveLineGutter, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { html } from '@codemirror/lang-html';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { setDiagnostics } from '@codemirror/lint';

// ======================================================================
//  Хелперы для разбора HTML — общие для всех инструментов
// ======================================================================

// Атрибуты внутри открывающего тега: { name, raw, value, start, end }
export function parseAttrs(openingTagText) {
  const attrs = [];
  const re = /(\w[\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|[^\s"'`>]+)/g;
  let m;
  while ((m = re.exec(openingTagText))) {
    const name = m[1];
    const raw = m[0];
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[0].split('=')[1];
    const start = m.index;
    const end = start + raw.length;
    attrs.push({ name, raw, value, start, end });
  }
  return attrs;
}

// Индекс символа '>' закрывающего открывающий тег, начатый в позиции lt (учитывает кавычки). -1 если не найден.
export function findTagEnd(html, lt) {
  let i = lt + 1, q = null;
  while (i < html.length) {
    const ch = html[i];
    if (q) { if (ch === q) q = null; }
    else { if (ch === '"' || ch === "'") q = ch; else if (ch === '>') return i; }
    i++;
  }
  return -1;
}

// Ближайший </tagName> после from (без учёта вложенности)
export function findClosingTag(html, from, tagName) {
  const re = new RegExp(`</\\s*${tagName}\\s*>`, 'g');
  re.lastIndex = from;
  const m = re.exec(html);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length, text: m[0] };
}

export function getLineIndent(html, pos) {
  const lastNl = html.lastIndexOf('\n', pos - 1);
  const lineStart = lastNl === -1 ? 0 : lastNl + 1;
  const before = html.slice(lineStart, pos);
  const m = before.match(/^[ \t]*/);
  const isInline = before.trim().length > 0;
  const indent = m ? m[0] : '';
  return { indent, isInline, lineStart };
}

export function isBlockContext(html, start, end) {
  const { indent, isInline } = getLineIndent(html, start);
  if (isInline) return { block: false, indent };
  const nextNl = html.indexOf('\n', end);
  const after = html.slice(end, nextNl === -1 ? html.length : nextNl);
  const hasTextAfter = after.trim().length > 0 && !after.trim().startsWith('<');
  if (hasTextAfter) return { block: false, indent };
  return { block: true, indent };
}

// ======================================================================
//  Рендер правого поля: построчно + гуттер с номерами и маркерами
// ======================================================================

function renderDiff(preEl, gutterEl, segments) {
  preEl.textContent = '';
  gutterEl.textContent = '';

  const lines = [[]];
  for (const seg of segments) {
    const parts = seg.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part !== '') lines[lines.length - 1].push({ text: part, cls: seg.cls || '' });
    });
  }
  if (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();

  const PRIORITY = ['hl-error', 'hl-changed', 'hl-removed', 'hl-added'];
  const fragPre = document.createDocumentFragment();
  const fragGut = document.createDocumentFragment();

  for (const parts of lines) {
    const row = document.createElement('div');
    row.className = 'c-line';
    let marker = '';
    for (const p of parts) {
      if (p.cls) {
        const m = document.createElement('mark');
        m.className = p.cls;
        m.textContent = p.text;
        row.appendChild(m);
        if (!marker || PRIORITY.indexOf(p.cls) < PRIORITY.indexOf(marker)) marker = p.cls;
      } else {
        row.appendChild(document.createTextNode(p.text));
      }
    }
    fragPre.appendChild(row);

    const g = document.createElement('div');
    g.className = 'g-line' + (marker ? ' g-' + marker.slice(3) : '');
    fragGut.appendChild(g);
  }

  preEl.appendChild(fragPre);
  gutterEl.appendChild(fragGut);
  syncGutterHeights(preEl, gutterEl);
}

function syncGutterHeights(preEl, gutterEl) {
  const rows = preEl.children, gs = gutterEl.children;
  for (let i = 0; i < rows.length && i < gs.length; i++) {
    gs[i].style.height = rows[i].getBoundingClientRect().height + 'px';
  }
}

// ======================================================================
//  initTool — два поля, кнопки, редактор. Инструмент передаёт только fix().
//
//  fix(src) может вернуть:
//    - строку — покажем справа как есть, без подсветки;
//    - объект { output, right?, marks?, diagnostics? } — с подсветкой диффа.
// ======================================================================

export function initTool({ fix, placeholder = 'Вставьте HTML сюда…', highlight = false, onPaste = null }) {
  const $ = (id) => document.getElementById(id);
  const outputPane = $('output-pane');
  const outputBox = $('output');
  const outputEmpty = $('output-empty');
  const staleBar = $('stale-bar');
  const diffRight = $('diff-right');
  const gutterRight = $('gutter-right');
  const btnFix = $('btn-fix');
  const btnRefix = $('btn-refix');
  const btnCopy = $('btn-copy');
  const btnClear = $('btn-clear');
  const btnPaste = $('btn-paste');
  const extrasBox = $('extras');       // есть не на всех страницах
  const messagesBox = $('messages');   // есть не на всех страницах

  let lastOutput = '';      // текст результата для копирования
  let lastChecked = null;   // исходник, для которого считали результат

  // ---- подсветка в левом поле: диапазоны + маркеры в гуттере ----
  const setMarks = StateEffect.define();

  class LineMark extends GutterMarker {
    constructor(cls) { super(); this.elementClass = cls; }
  }

  const EMPTY = { deco: Decoration.none, gutter: RangeSet.empty };

  const markField = StateField.define({
    create: () => EMPTY,
    update(value, tr) {
      for (const e of tr.effects) if (e.is(setMarks)) return e.value;
      if (tr.docChanged) return EMPTY;            // любая правка снимает подсветку
      return value;
    },
    provide: (f) => [
      EditorView.decorations.from(f, (v) => v.deco),
      lineNumberMarkers.from(f, (v) => v.gutter),
    ],
  });

  function applyLeftMarks(marks, diagnostics) {
    const doc = view.state.doc;
    const valid = marks.filter((m) => m.to > m.from && m.to <= doc.length);
    const decos = valid.map((m) => Decoration.mark({ class: 'cm-' + m.cls }).range(m.from, m.to));

    const PRIORITY = ['hl-error', 'hl-changed', 'hl-removed'];
    const perLine = new Map();
    for (const m of valid) {
      const l1 = doc.lineAt(m.from).number, l2 = doc.lineAt(m.to - 1).number;
      for (let n = l1; n <= l2; n++) {
        const cur = perLine.get(n);
        if (!cur || PRIORITY.indexOf(m.cls) < PRIORITY.indexOf(cur)) perLine.set(n, m.cls);
      }
    }
    const gutterMarks = [...perLine.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([n, cls]) => new LineMark('cm-g-' + cls.slice(3)).range(doc.line(n).from));

    view.dispatch({ effects: setMarks.of({ deco: Decoration.set(decos, true), gutter: RangeSet.of(gutterMarks, true) }) });
    view.dispatch(setDiagnostics(view.state, diagnostics
      .filter((d) => d.from < doc.length)
      .map((d) => ({ from: d.from, to: Math.min(Math.max(d.to, d.from + 1), doc.length), severity: 'error', message: d.message }))));
  }

  // ---- сам редактор ----
  const view = new EditorView({
    parent: $('input'),
    state: EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        html({ autoCloseTags: false, matchClosingTags: false }),
        ...(highlight ? [syntaxHighlighting(defaultHighlightStyle)] : []),
        EditorView.lineWrapping,
        cmPlaceholder(placeholder),
        markField,
        keymap.of([{ key: 'Mod-Enter', run: () => { run(); return true; } }, ...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((u) => { if (u.docChanged) onInputChanged(); }),
        // Cmd+V: если инструмент дал хук и он вернул текст — кладём его вместо содержимого поля
        EditorView.domEventHandlers({
          paste(event) {
            if (!onPaste || !event.clipboardData) return false;
            const text = event.clipboardData.getData('text/plain') || '';
            const htmlData = event.clipboardData.getData('text/html') || '';
            const result = onPaste({ text, html: htmlData });
            if (typeof result !== 'string') return false;
            event.preventDefault();
            setInput(result);
            return true;
          },
        }),
      ],
    }),
  });

  const getInput = () => view.state.doc.toString();
  const setInput = (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });

  // приводим результат fix() к одному виду
  function normalize(res) {
    if (typeof res === 'string') res = { output: res };
    const output = res.output ?? '';
    return {
      output,
      right: res.right ?? [{ text: output }],
      marks: res.marks ?? [],
      diagnostics: res.diagnostics ?? [],
      extras: res.extras ?? [],
      messages: res.messages ?? [],
    };
  }

  // сообщения под левым полем: ошибки, не привязанные к конкретному месту в тексте
  function renderMessages(messages) {
    if (!messagesBox) return;
    messagesBox.textContent = '';
    if (!messages.length) { messagesBox.hidden = true; return; }
    for (const msg of messages) {
      const row = document.createElement('div');
      row.className = 'message message-' + (msg.level || 'error');
      row.textContent = msg.text;
      messagesBox.appendChild(row);
    }
    messagesBox.hidden = false;
  }

  // копирование с запасным путём для старых браузеров
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  // дополнительные блоки под правым полем, каждый со своей кнопкой копирования
  function renderExtras(extras) {
    if (!extrasBox) return;
    extrasBox.textContent = '';
    if (!extras.length) { extrasBox.hidden = true; return; }
    for (const x of extras) {
      const row = document.createElement('div');
      row.className = 'extra' + (x.multiline ? ' extra-block' : '');

      const label = document.createElement('span');
      label.className = 'extra-label';
      label.textContent = x.label;

      const value = document.createElement(x.multiline ? 'pre' : 'span');
      value.className = 'extra-value';
      value.textContent = x.text;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost extra-copy';
      btn.textContent = '⧉';
      btn.title = 'Копировать';
      btn.disabled = !x.text;
      btn.addEventListener('click', async () => {
        await copyText(x.text);
        btn.textContent = '✓';
        setTimeout(() => (btn.textContent = '⧉'), 1200);
      });

      row.append(label, value, btn);
      extrasBox.appendChild(row);
    }
    extrasBox.hidden = false;
  }

  // показать результат в правом поле
  function renderOutput(res) {
    // сначала показываем поле, потом рисуем — иначе высоты строк считаются по скрытому элементу
    outputEmpty.hidden = true;
    outputBox.hidden = false;
    staleBar.hidden = true;
    outputPane.classList.remove('stale');
    renderDiff(diffRight, gutterRight, res.right);
    renderExtras(res.extras);
    renderMessages(res.messages);
    lastOutput = res.output;
    btnCopy.disabled = res.output.length === 0;
  }

  // очистить правое поле (пустое состояние)
  function clearOutput() {
    diffRight.textContent = '';
    gutterRight.textContent = '';
    outputBox.hidden = true;
    outputEmpty.hidden = false;
    staleBar.hidden = true;
    outputPane.classList.remove('stale');
    renderExtras([]);
    renderMessages([]);
    lastOutput = '';
    btnCopy.disabled = true;
  }

  // исходник поменяли после прогона — помечаем результат устаревшим
  function markStale() {
    if (outputBox.hidden) return;
    outputPane.classList.add('stale');
    staleBar.hidden = false;
  }

  function run() {
    const src = getInput();
    if (!src.trim()) { clearOutput(); return; }
    const res = normalize(fix(src));
    lastChecked = src;
    renderOutput(res);
    applyLeftMarks(res.marks, res.diagnostics);
  }

  // вызывается при любой правке в левом поле
  function onInputChanged() {
    const src = getInput();
    if (!src) { clearOutput(); lastChecked = null; return; }
    if (lastChecked !== null && src !== lastChecked) markStale();
  }

  async function copyOutput() {
    if (!lastOutput) return;
    await copyText(lastOutput);
    btnCopy.textContent = 'Скопировано';
    setTimeout(() => (btnCopy.textContent = 'Копировать'), 1200);
  }

  // читаем буфер в обоих видах: простой текст + HTML (если есть)
  async function readClipboard() {
    let text = '', htmlData = '';
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        if (!text && item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
        if (!htmlData && item.types.includes('text/html')) htmlData = await (await item.getType('text/html')).text();
      }
    } catch {
      text = await navigator.clipboard.readText();   // браузер не дал read() — хотя бы текст
    }
    return { text, html: htmlData };
  }

  // вставка из буфера: заменяет содержимое левого поля
  async function pasteInput() {
    try {
      const clip = await readClipboard();
      const result = onPaste ? onPaste(clip) : null;
      setInput(typeof result === 'string' ? result : clip.text);
      view.focus();
    } catch {
      view.focus();
      const old = btnPaste.textContent;
      btnPaste.textContent = 'Нажмите Cmd+V';
      setTimeout(() => (btnPaste.textContent = old), 1500);
    }
  }

  function clearAll() {
    setInput('');
    clearOutput();
    lastChecked = null;
    view.focus();
  }

  // фиксируем ширину кнопки по более длинной подписи, чтобы при смене текста соседи не прыгали
  btnCopy.textContent = 'Скопировано';
  btnCopy.style.minWidth = btnCopy.offsetWidth + 'px';
  btnCopy.textContent = 'Копировать';

  btnFix.addEventListener('click', run);
  btnRefix.addEventListener('click', run);
  btnCopy.addEventListener('click', copyOutput);
  btnClear.addEventListener('click', clearAll);
  btnPaste.addEventListener('click', pasteInput);

  // попап со списком правил — только если он есть на странице
  const rulesDialog = $('rules-dialog');
  const btnRules = $('btn-rules');
  if (rulesDialog && btnRules) {
    btnRules.addEventListener('click', () => rulesDialog.showModal());
    $('btn-rules-close').addEventListener('click', () => rulesDialog.close());
    rulesDialog.addEventListener('click', (e) => { if (e.target === rulesDialog) rulesDialog.close(); });
  }

  window.addEventListener('resize', () => syncGutterHeights(diffRight, gutterRight));

  clearOutput();

  return { view, run, getInput, setInput };
}