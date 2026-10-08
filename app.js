import { EditorState, StateField, StateEffect, RangeSet } from '@codemirror/state';
import { EditorView, Decoration, GutterMarker, lineNumbers, lineNumberMarkers,
         highlightActiveLine, highlightActiveLineGutter, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { html } from '@codemirror/lang-html';
import { setDiagnostics } from '@codemirror/lint';

(function () {
  'use strict';

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
        EditorView.lineWrapping,
        placeholder('Вставьте HTML сюда…'),
        markField,
        keymap.of([{ key: 'Mod-Enter', run: () => { run(); return true; } }, ...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((u) => { if (u.docChanged) onInputChanged(); }),
      ],
    }),
  });

  const getInput = () => view.state.doc.toString();
  const setInput = (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });


  // --- helpers ---
  function escapeHtml(s) { return s; } // для <pre> через textContent не нужно

  function parseAttrs(openingTagText) {
    const attrs = [];
    // матчим атрибуты внутри <tag ...>
    const re = /(\w[\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|[^\s"'`>]+)/g;
    // также найдем их сырой текст для удаления
    let m;
    while ((m = re.exec(openingTagText))) {
      const name = m[1];
      const raw = m[0];
      const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[0].split('=')[1];
      // позиция внутри openingTagText
      const start = m.index;
      const end = start + raw.length;
      attrs.push({ name, raw, value, start, end });
    }
    return attrs;
  }

  function findClosingTag(html, from, tagName) {
    const re = new RegExp(`</\\s*${tagName}\\s*>`, 'g');
    re.lastIndex = from;
    const m = re.exec(html);
    if (!m) return null;
    return { start: m.index, end: m.index + m[0].length, text: m[0] };
  }

  function getLineIndent(html, pos) {
    const lastNl = html.lastIndexOf('\n', pos - 1);
    const lineStart = lastNl === -1 ? 0 : lastNl + 1;
    const before = html.slice(lineStart, pos);
    const m = before.match(/^[ \t]*/);
    // если до тега на строке есть не-пробельные символы -> считаем inline
    const isInline = before.trim().length > 0;
    const indent = m ? m[0] : '';
    return { indent, isInline, lineStart };
  }

  function isBlockContext(html, start, end) {
    const { indent, isInline } = getLineIndent(html, start);
    if (isInline) return { block: false, indent };
    // смотрим что после тега на той же строке
    const nextNl = html.indexOf('\n', end);
    const after = html.slice(end, nextNl === -1 ? html.length : nextNl);
    const hasTextAfter = after.trim().length > 0 && !after.trim().startsWith('<');
    // если после тега сразу текст на той же строке - тоже inline
    if (hasTextAfter) return { block: false, indent };
    return { block: true, indent };
  }

  // Блоки <div class="mobile-table"> … </div> — удаляются целиком.
  // Парный </div> ищем с учётом вложенных div. Если не нашли — помечаем как ошибку.
  function findDeletableBlocks(html) {
    const blocks = [];
    const re = /<div\b/gi;
    let m;
    while ((m = re.exec(html))) {
      const lt = m.index;
      let i = lt + 1, inQuote = null;
      while (i < html.length) {
        const ch = html[i];
        if (inQuote) { if (ch === inQuote) inQuote = null; }
        else { if (ch === '"' || ch === "'") inQuote = ch; else if (ch === '>') break; }
        i++;
      }
      if (i >= html.length) break;
      const openText = html.slice(lt, i + 1);

      const cm = openText.match(/\bclass\s*=\s*("([^"]*)"|'([^']*)')/);
      if (!cm || !(cm[2] !== undefined ? cm[2] : cm[3]).split(/\s+/).includes('mobile-table')) {
        re.lastIndex = i + 1;
        continue;
      }

      // парный </div> с учётом вложенности
      let depth = 1, end = -1;
      const tagRe = /<(\/?)div\b/gi;
      tagRe.lastIndex = i + 1;
      let t;
      while ((t = tagRe.exec(html))) {
        depth += t[1] ? -1 : 1;
        if (depth === 0) { end = t.index; break; }
      }
      if (end === -1) { blocks.push({ start: lt, end: i + 1, error: true }); re.lastIndex = i + 1; continue; }

      let k = end;
      while (k < html.length && html[k] !== '>') k++;
      let s = lt, e = Math.min(k + 1, html.length);

      // если блок стоит на своей строке один — забираем вместе с отступом и переносом строки
      const lineStart = html.lastIndexOf('\n', s - 1) + 1;
      if (html.slice(lineStart, s).trim() === '') s = lineStart;
      const nl = html.indexOf('\n', e);
      const rest = html.slice(e, nl === -1 ? html.length : nl);
      if (nl !== -1 && rest.trim() === '') e = nl + 1;

      blocks.push({ start: s, end: e, error: false });
      re.lastIndex = Math.min(k + 1, html.length);
    }
    return blocks;
  }

  // Главный трансформер
  function fix(html) {
    const replacements = []; // {start,end, newText, kind?, error?, message?}
    const msgs = [];
    let pos = 0;

    // Правило 2: блоки <div class="mobile-table"> удаляем целиком
    const deletable = findDeletableBlocks(html);
    for (const b of deletable) {
      if (b.error) {
        replacements.push({
          start: b.start, end: b.end, newText: html.slice(b.start, b.end), kind: 'delete', error: true,
          message: `Не найден парный </div> для <div class="mobile-table"> на позиции ${b.start} — блок пропущен.`
        });
      } else {
        replacements.push({ start: b.start, end: b.end, newText: '', kind: 'delete', error: false });
      }
    }
    const deletedBlockAt = (p) => deletable.find((b) => !b.error && p >= b.start && p < b.end);

    while (pos < html.length) {
      const lt = html.indexOf('<', pos);
      if (lt === -1) break;

      // внутри удаляемого блока ничего не ищем — он уйдёт целиком
      const del = deletedBlockAt(lt);
      if (del) { pos = del.end; continue; }

      const head = html.slice(lt, lt + 10).toLowerCase();

      // Правило 3: <table class="desktop-table" …> → <table>, все атрибуты долой
      if (/^<table\b/.test(head)) {
        let j = lt + 1, q = null;
        while (j < html.length) {
          const ch = html[j];
          if (q) { if (ch === q) q = null; }
          else { if (ch === '"' || ch === "'") q = ch; else if (ch === '>') break; }
          j++;
        }
        if (j >= html.length) break;
        const tOpenEnd = j + 1;
        const tOpenText = html.slice(lt, tOpenEnd);
        const tAttrs = parseAttrs(tOpenText);
        const cls = tAttrs.find(a => a.name === 'class');
        const isDesktop = cls && cls.value.split(/\s+/).includes('desktop-table');
        if (isDesktop && tAttrs.length > 0) {
          replacements.push({ start: lt, end: tOpenEnd, newText: '<table>', kind: 'strip', attrs: tAttrs, error: false });
        }
        pos = tOpenEnd;
        continue;
      }

      // Правило 4: <details title="X" opentitle="Y"> → <details> + <title>X</title>
      if (/^<details\b/.test(head)) {
        let j = lt + 1, q = null;
        while (j < html.length) {
          const ch = html[j];
          if (q) { if (ch === q) q = null; }
          else { if (ch === '"' || ch === "'") q = ch; else if (ch === '>') break; }
          j++;
        }
        if (j >= html.length) break;
        const dOpenEnd = j + 1;
        const dOpenText = html.slice(lt, dOpenEnd);
        const dAttrs = parseAttrs(dOpenText);
        const titleAttr = dAttrs.find(a => a.name === 'title');
        const openTitleAttr = dAttrs.find(a => a.name === 'opentitle');

        if (!titleAttr && !openTitleAttr) { pos = dOpenEnd; continue; } // уже новый формат

        // парный </details> с учётом вложенности
        let depth = 1, closeStart = -1;
        const dRe = /<(\/?)details\b/gi;
        dRe.lastIndex = dOpenEnd;
        let t;
        while ((t = dRe.exec(html))) {
          depth += t[1] ? -1 : 1;
          if (depth === 0) { closeStart = t.index; break; }
        }
        if (closeStart === -1) {
          replacements.push({ start: lt, end: dOpenEnd, newText: dOpenText, error: true,
            message: 'Не найден парный </details> — элемент пропущен.' });
          pos = dOpenEnd;
          continue;
        }
        const dInner = html.slice(dOpenEnd, closeStart);
        if (titleAttr && /<title[\s>]/i.test(dInner)) {
          replacements.push({ start: lt, end: dOpenEnd, newText: dOpenText, error: true,
            message: 'Конфликт: атрибут title и тег <title> одновременно — элемент пропущен.' });
          pos = dOpenEnd;
          continue;
        }

        let dNewOpen = dOpenText;
        if (titleAttr) dNewOpen = dNewOpen.replace(/\s+title\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`>]+)/, '');
        if (openTitleAttr) dNewOpen = dNewOpen.replace(/\s+opentitle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`>]+)/, '');

        let dNewText = dNewOpen;
        if (titleAttr && titleAttr.value.trim() !== '') {
          const { indent } = getLineIndent(html, lt);
          const startsOnNewLine = /^[ \t]*\n/.test(dInner);
          dNewText += (startsOnNewLine ? '\n' + indent + '  ' : '') + '<title>' + titleAttr.value + '</title>';
        }

        replacements.push({ start: lt, end: dOpenEnd, newText: dNewText, kind: 'details', titleAttr, openTitleAttr, error: false });
        pos = dOpenEnd;
        continue;
      }

      // Правило 5: <hl title="X"> → <hl> + <h3>X</h3> (сущности &lt;/&gt; раскодируем в теги)
      if (/^<hl\b/.test(head)) {
        let j = lt + 1, q = null;
        while (j < html.length) {
          const ch = html[j];
          if (q) { if (ch === q) q = null; }
          else { if (ch === '"' || ch === "'") q = ch; else if (ch === '>') break; }
          j++;
        }
        if (j >= html.length) break;
        const hOpenEnd = j + 1;
        const hOpenText = html.slice(lt, hOpenEnd);
        const hAttrs = parseAttrs(hOpenText);
        const hTitleAttr = hAttrs.find(a => a.name === 'title');
        const bubbleAttr = hAttrs.find(a => a.name === 'isbuble');

        // Правило 8: <hl isbuble="true">…</hl> → <bubble>…</bubble>
        if (bubbleAttr) {
          if (hTitleAttr) {
            replacements.push({ start: lt, end: hOpenEnd, newText: hOpenText, error: true,
              message: 'У <hl> одновременно isbuble и title — элемент пропущен.' });
            pos = hOpenEnd;
            continue;
          }
          let bDepth = 1, bClose = null;
          const bRe = /<(\/?)hl\b[^>]*>/gi;
          bRe.lastIndex = hOpenEnd;
          let bt;
          while ((bt = bRe.exec(html))) {
            bDepth += bt[1] ? -1 : 1;
            if (bDepth === 0) { bClose = { start: bt.index, end: bt.index + bt[0].length, text: bt[0] }; break; }
          }
          if (!bClose) {
            replacements.push({ start: lt, end: hOpenEnd, newText: hOpenText, error: true,
              message: 'Не найден парный </hl> — элемент пропущен.' });
            pos = hOpenEnd;
            continue;
          }
          const bNewOpen = hOpenText
            .replace(/\s+isbuble\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`>]+)/, '')
            .replace(/^<hl\b/i, '<bubble');
          const bInner = html.slice(hOpenEnd, bClose.start);
          const bNewText = bNewOpen + bInner + '</bubble>';
          replacements.push({ start: lt, end: bClose.end, newText: bNewText, kind: 'bubble', bubbleAttr,
            closeOffset: bClose.start - lt, closeText: bClose.text, error: false });
          pos = bClose.end;
          continue;
        }

        if (!hTitleAttr) { pos = hOpenEnd; continue; } // уже новый формат

        let depth = 1, closeStart = -1;
        const hRe = /<(\/?)hl\b/gi;
        hRe.lastIndex = hOpenEnd;
        let t;
        while ((t = hRe.exec(html))) {
          depth += t[1] ? -1 : 1;
          if (depth === 0) { closeStart = t.index; break; }
        }
        if (closeStart === -1) {
          replacements.push({ start: lt, end: hOpenEnd, newText: hOpenText, error: true,
            message: 'Не найден парный </hl> — элемент пропущен.' });
          pos = hOpenEnd;
          continue;
        }
        const hInner = html.slice(hOpenEnd, closeStart);
        if (/<h3[\s>]/i.test(hInner)) {
          replacements.push({ start: lt, end: hOpenEnd, newText: hOpenText, error: true,
            message: 'Конфликт: атрибут title и тег <h3> одновременно — элемент пропущен.' });
          pos = hOpenEnd;
          continue;
        }

        let hNewText = hOpenText.replace(/\s+title\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`>]+)/, '');
        if (hTitleAttr.value.trim() !== '') {
          const decoded = hTitleAttr.value
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
          const { indent } = getLineIndent(html, lt);
          const startsOnNewLine = /^[ \t]*\n/.test(hInner);
          hNewText += (startsOnNewLine ? '\n' + indent + '  ' : '') + '<h3>' + decoded + '</h3>';
        }

        replacements.push({ start: lt, end: hOpenEnd, newText: hNewText, kind: 'hl', titleAttr: hTitleAttr, error: false });
        pos = hOpenEnd;
        continue;
      }

     

      // Правило 6: <author desc="X"></author> → <author><description>X</description></author>
      if (/^<author\b/.test(head)) {
        let j = lt + 1, q = null;
        while (j < html.length) {
          const ch = html[j];
          if (q) { if (ch === q) q = null; }
          else { if (ch === '"' || ch === "'") q = ch; else if (ch === '>') break; }
          j++;
        }
        if (j >= html.length) break;
        const aOpenEnd = j + 1;
        const aOpenText = html.slice(lt, aOpenEnd);
        const aSelfClosing = /\/\s*>$/.test(aOpenText);
        const descAttr = parseAttrs(aOpenText).find(a => a.name === 'desc');
        if (!descAttr) { pos = aOpenEnd; continue; } // уже новый формат

        let aFullEnd = aOpenEnd, aInner = '';
        if (!aSelfClosing) {
          const closing = findClosingTag(html, aOpenEnd, 'author');
          if (!closing) {
            replacements.push({ start: lt, end: aOpenEnd, newText: aOpenText, error: true,
              message: 'Не найден парный </author> — элемент пропущен.' });
            pos = aOpenEnd;
            continue;
          }
          aInner = html.slice(aOpenEnd, closing.start);
          aFullEnd = closing.end;
        }
        if (/<description[\s>]/i.test(aInner)) {
          replacements.push({ start: lt, end: aFullEnd, newText: html.slice(lt, aFullEnd), error: true,
            message: 'Конфликт: атрибут desc и тег <description> одновременно — элемент пропущен.' });
          pos = aFullEnd;
          continue;
        }
        if (aInner.trim() !== '') {
          replacements.push({ start: lt, end: aFullEnd, newText: html.slice(lt, aFullEnd), error: true,
            message: 'Внутри <author> с desc="…" есть вложенный контент — элемент пропущен.' });
          pos = aFullEnd;
          continue;
        }

        let aNewOpen = aOpenText
          .replace(/\s+desc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`>]+)/, '')
          .replace(/\s*\/\s*>$/, '>');
        let aNewText;
        if (descAttr.value.trim() === '') {
          aNewText = aNewOpen + '</author>';
        } else {
          const decoded = descAttr.value
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
          const { block, indent } = isBlockContext(html, lt, aFullEnd);
          aNewText = block
            ? aNewOpen + '\n' + indent + '  <description>\n' + indent + '    ' + decoded + '\n' + indent + '  </description>\n' + indent + '</author>'
            : aNewOpen + '<description>' + decoded + '</description></author>';
        }

        replacements.push({ start: lt, end: aFullEnd, newText: aNewText, kind: 'author', descAttr, aSelfClosing, error: false });
        pos = aFullEnd;
        continue;
      }

        // Правило 7: <aside url="X">текст</aside> → <aside><a href="X">текст</a></aside>
      if (/^<aside\b/.test(head)) {
        let j = lt + 1, q = null;
        while (j < html.length) {
          const ch = html[j];
          if (q) { if (ch === q) q = null; }
          else { if (ch === '"' || ch === "'") q = ch; else if (ch === '>') break; }
          j++;
        }
        if (j >= html.length) break;
        const sOpenEnd = j + 1;
        const sOpenText = html.slice(lt, sOpenEnd);
        const urlAttr = parseAttrs(sOpenText).find(a => a.name === 'url');
        if (!urlAttr) { pos = sOpenEnd; continue; } // уже новый формат

        const closing = findClosingTag(html, sOpenEnd, 'aside');
        if (!closing) {
          replacements.push({ start: lt, end: sOpenEnd, newText: sOpenText, error: true,
            message: 'Не найден парный </aside> — элемент пропущен.' });
          pos = sOpenEnd;
          continue;
        }
        const sInner = html.slice(sOpenEnd, closing.start);
        if (/<a[\s>]/i.test(sInner)) {
          replacements.push({ start: lt, end: closing.end, newText: html.slice(lt, closing.end), error: true,
            message: 'Внутри <aside> с url="…" уже есть ссылка <a> — элемент пропущен.' });
          pos = closing.end;
          continue;
        }

        const sNewOpen = sOpenText.replace(/\s+url\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`>]+)/, '');
        let sNewInner = sInner;
        if (urlAttr.value.trim() !== '' && sInner.trim() !== '') {
          // оборачиваем только сам текст, пробелы и переносы вокруг оставляем как были
          const lead = sInner.match(/^\s*/)[0], trail = sInner.match(/\s*$/)[0];
          const core = sInner.slice(lead.length, sInner.length - trail.length);
          sNewInner = lead + '<a href="' + urlAttr.value + '">' + core + '</a>' + trail;
        }
        const sNewText = sNewOpen + sNewInner + closing.text;

        replacements.push({ start: lt, end: closing.end, newText: sNewText, kind: 'aside', urlAttr,
          linkAt: sNewOpen.length + sInner.match(/^\s*/)[0].length, hasLink: sNewInner !== sInner, error: false });
        pos = closing.end;
        continue;
      }

      // быстро проверяем <img или <image
      const isImg = head.startsWith('<img') && /<img\b/.test(head);
      const isImage = head.startsWith('<image') && /<image\b/.test(head);
      if (!isImg && !isImage) { pos = lt + 1; continue; }

      // находим конец открывающего тега с учётом кавычек
      let i = lt + 1, inQuote = null;
      while (i < html.length) {
        const ch = html[i];
        if (inQuote) { if (ch === inQuote) inQuote = null; }
        else { if (ch === '"' || ch === "'") inQuote = ch; else if (ch === '>') break; }
        i++;
      }
      if (i >= html.length) break;
      const openEnd = i + 1;
      const openText = html.slice(lt, openEnd);
      const tagName = isImg ? 'img' : 'image';
      const isSelfClosing = /\/\s*>$/.test(openText);

      let fullEnd = openEnd;
      let inner = '';
      let closeText = '';
      let closeStart = -1, closeEnd = -1;

      if (tagName === 'image' && !isSelfClosing) {
        const closing = findClosingTag(html, openEnd, 'image');
        if (!closing) {
          // битая разметка - подсветим как ошибку и идем дальше
                   replacements.push({
            start: lt, end: openEnd, newText: openText, error: true, openText,
            message: `Не найден парный </image> — элемент пропущен.`
          });
          pos = openEnd;
          continue;
        }
        closeStart = closing.start; closeEnd = closing.end; closeText = closing.text;
        inner = html.slice(openEnd, closeStart);
        fullEnd = closeEnd;
      }

      const attrs = parseAttrs(openText);
      const captionAttr = attrs.find(a => a.name === 'caption');
      const emptyPropAttr = attrs.find(a => a.name === 'prop' && a.value.trim() === '');

      // 5. уже новый формат: <image> без caption-атрибута но с <caption> внутри или просто без caption -> пропускаем
      const hasInnerCaption = /<caption[\s>]/i.test(inner);
      if (tagName === 'image' && !captionAttr) {
        // если это уже <image><caption>...</caption></image> или <image> без caption - считаем новым форматом
        // self-closing image без caption всё же развернем в парный
        if (!isSelfClosing) {
          pos = fullEnd;
          continue;
        }
        // self-closing без caption -> развернем (см ниже)
      }

      // 8. корнер-кейсы -> ошибка, не трогаем, подсвечиваем
      if (captionAttr && hasInnerCaption) {
              replacements.push({ start: lt, end: fullEnd, newText: html.slice(lt, fullEnd), error: true, openText, inner, closeText,
          message: `Конфликт: атрибут caption и тег <caption> одновременно — элемент пропущен.` });
        pos = fullEnd;
        continue;
      }
      if (captionAttr && inner.trim() !== '') {
                replacements.push({ start: lt, end: fullEnd, newText: html.slice(lt, fullEnd), error: true, openText, inner, closeText,
          message: `Внутри <image> с caption="…" есть вложенный контент — элемент пропущен.` });
        pos = fullEnd;
        continue;
      }

      // нужен ли трансформ вообще?
      const needsRename = tagName === 'img';
      const needsUnwrap = isSelfClosing;
      const needsCaptionMove = !!captionAttr && captionAttr.value.trim() !== '';
      const needsCaptionRemove = !!captionAttr; // даже пустой надо удалить

      if (!needsRename && !needsUnwrap && !needsCaptionRemove) {
        pos = fullEnd;
        continue;
      }

      // строим новый открывающий тег, сохраняя исходные кавычки и порядок остальных атрибутов
      let newOpen = openText;
      // 1. удалить caption атрибут с предшествующим пробелом
      if (captionAttr) {
        newOpen = newOpen.replace(/\s+caption\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`>]+)/, '');
      }
      // 1b. удалить пустой prop (prop="" или prop='')
      newOpen = newOpen.replace(/\s+prop\s*=\s*(?:""|'')/, '');
      // 2. переименовать img -> image
      if (tagName === 'img') {
        newOpen = newOpen.replace(/^<\s*img\b/, '<image');
      }
      // 3. убрать / перед >
      newOpen = newOpen.replace(/\s*\/\s*>$/, '>');

      // отступы
      const { block, indent } = isBlockContext(html, lt, fullEnd);
      let newText;
      if (needsCaptionMove) {
        const captionValue = captionAttr.value; // сырое содержимое без внешних кавычек
        if (block) {
          const innerIndent = indent + '  ';
          newText = newOpen + '\n' + innerIndent + '<caption>' + captionValue + '</caption>\n' + indent + '</image>';
        } else {
          newText = newOpen + '<caption>' + captionValue + '</caption></image>';
        }
      } else {
        // без caption просто парный тег
        if (block && inner === '' && isSelfClosing) {
          // оставим в одну строку для пустого: <image ...></image>
          newText = newOpen + '</image>';
        } else {
          newText = newOpen + inner + (tagName === 'image' && !isSelfClosing ? closeText : '</image>');
        }
      }

      replacements.push({
        start: lt, end: fullEnd, newText, openText, captionAttr, emptyPropAttr,
        tagName, isSelfClosing, block, indent, error: false
      });
      pos = fullEnd;
    }

    // применяем замены с конца чтобы не сбить позиции
    let output = html;
    const sorted = [...replacements].sort((a,b)=> b.start - a.start);
    for (const r of sorted) {
      if (r.error) continue;
      output = output.slice(0, r.start) + r.newText + output.slice(r.end);
    }

    // строим сегменты для диффа
    // left: подсветка удалённого caption и изменённого имени
    // right: подсветка добавленного
    const leftSegments = buildLeftSegments(html, replacements);
    const rightSegments = buildRightSegments(output, html, replacements);

    if (replacements.filter(r=>!r.error).length === 0 && msgs.length===0) {
      msgs.push({ level: 'info', text: 'Изменений не найдено — верстка уже в новом формате или нет подходящих тегов.' });
    } else if (replacements.filter(r=>!r.error).length>0) {
      msgs.unshift({ level: 'info', text: `Применено замен: ${replacements.filter(r=>!r.error).length}.` });
    }

    // Диапазоны для подсветки левого поля (CodeMirror): считаем позиции по сегментам
    const marks = [];
    let offset = 0;
    for (const seg of leftSegments) {
      if (seg.cls) marks.push({ from: offset, to: offset + seg.text.length, cls: seg.cls });
      offset += seg.text.length;
    }

    // Ошибки для всплывашек слева: error-сегменты и error-сообщения
    // собираются в одном порядке (по позиции в тексте), поэтому сопоставляем по индексу
        const diagnostics = replacements
      .filter(r => r.error)
      .sort((a, b) => a.start - b.start)
      .map(r => ({ from: r.start, to: r.end, message: r.message || 'Ошибка разметки — элемент пропущен.' }));

        return { output, left: leftSegments, right: rightSegments, marks, diagnostics, messages: msgs };
  }

  function buildLeftSegments(html, reps) {
    if (reps.length===0) return [{text: html}];
    const sorted = [...reps].sort((a,b)=> a.start - b.start);
    const segs = [];
    let cur = 0;
    for (const r of sorted) {
      if (cur < r.start) segs.push({text: html.slice(cur, r.start)});
      const chunk = html.slice(r.start, r.end);
      if (r.error) {
        segs.push({text: chunk, cls: 'hl-error'});


            } else {
        const parts = splitLeftChunk(chunk, r);
        for (const p of parts) segs.push(p);
      }


      cur = r.end;
    }
    if (cur < html.length) segs.push({text: html.slice(cur)});
    return segs;
  }

  function splitLeftChunk(chunk, r) {
    if (r.error) return [{text: chunk, cls: 'hl-error'}];
    if (r.kind === 'delete') return [{text: chunk, cls: 'hl-removed'}];
    const spans = []; // {from, to, cls} — позиции внутри chunk

     // таблица: все атрибуты удаляются
    if (r.kind === 'strip') {
      for (const a of r.attrs) spans.push({ from: a.start, to: a.end, cls: 'hl-removed' });
    }

    // bubble: имя тега hl → изменено (в обоих тегах), isbuble="…" → удалено целиком
    if (r.kind === 'bubble') {
      spans.push({ from: 1, to: 3, cls: 'hl-changed' });                       // <hl
      spans.push({ from: r.bubbleAttr.start, to: r.bubbleAttr.end, cls: 'hl-removed' });
      const nameInClose = r.closeText.search(/hl/i);                           // </hl>
      if (nameInClose !== -1) {
        spans.push({ from: r.closeOffset + nameInClose, to: r.closeOffset + nameInClose + 2, cls: 'hl-changed' });
      }
    }

    // aside: url="…" → обёртка красным, адрес не трогаем (переезжает в href)
    if (r.kind === 'aside' && r.urlAttr) {
      const a = r.urlAttr, raw = a.raw, val = a.value;
      const valIdx = val ? raw.indexOf(val, raw.indexOf('=')) : -1;
      if (valIdx > 0) {
        spans.push({ from: a.start, to: a.start + valIdx, cls: 'hl-removed' });
        if (valIdx + val.length < raw.length) spans.push({ from: a.start + valIdx + val.length, to: a.end, cls: 'hl-removed' });
      } else {
        spans.push({ from: a.start, to: a.end, cls: 'hl-removed' });
      }
    }

    // author: desc="…" → обёртка красным, текст описания не трогаем
    if (r.kind === 'author' && r.descAttr) {
      const a = r.descAttr, raw = a.raw, val = a.value;
      const valIdx = val ? raw.indexOf(val, raw.indexOf('=')) : -1;
      if (valIdx > 0) {
        spans.push({ from: a.start, to: a.start + valIdx, cls: 'hl-removed' });
        if (valIdx + val.length < raw.length) spans.push({ from: a.start + valIdx + val.length, to: a.end, cls: 'hl-removed' });
      } else {
        spans.push({ from: a.start, to: a.end, cls: 'hl-removed' });
      }
    }

    // hl: title="…" → обёртка красным, текст заголовка не трогаем
    if (r.kind === 'hl' && r.titleAttr) {
      const a = r.titleAttr, raw = a.raw, val = a.value;
      const valIdx = val ? raw.indexOf(val, raw.indexOf('=')) : -1;
      if (valIdx > 0) {
        spans.push({ from: a.start, to: a.start + valIdx, cls: 'hl-removed' });
        if (valIdx + val.length < raw.length) spans.push({ from: a.start + valIdx + val.length, to: a.end, cls: 'hl-removed' });
      } else {
        spans.push({ from: a.start, to: a.end, cls: 'hl-removed' });
      }
    }

    // details: title="…" → обёртка красным, текст не трогаем; opentitle — целиком
    if (r.kind === 'details') {
      if (r.titleAttr) {
        const a = r.titleAttr, raw = a.raw, val = a.value;
        const valIdx = val ? raw.indexOf(val, raw.indexOf('=')) : -1;
        if (valIdx > 0) {
          spans.push({ from: a.start, to: a.start + valIdx, cls: 'hl-removed' });
          if (valIdx + val.length < raw.length) spans.push({ from: a.start + valIdx + val.length, to: a.end, cls: 'hl-removed' });
        } else {
          spans.push({ from: a.start, to: a.end, cls: 'hl-removed' });
        }
      }
      if (r.openTitleAttr) spans.push({ from: r.openTitleAttr.start, to: r.openTitleAttr.end, cls: 'hl-removed' });
    }

        // имя тега img → изменено
    if (r.tagName === 'img') {
      const nameStart = chunk.indexOf('<img');
      if (nameStart !== -1) spans.push({ from: nameStart + 1, to: nameStart + 4, cls: 'hl-changed' });
    }

    // caption="…" → удалено, но сам текст подписи не красим (он переезжает)
    if (r.captionAttr) {
      const a = r.captionAttr, raw = a.raw, val = a.value;
      const valIdx = val ? raw.indexOf(val, raw.indexOf('=')) : -1;
      if (valIdx > 0) {
        spans.push({ from: a.start, to: a.start + valIdx, cls: 'hl-removed' });
        if (valIdx + val.length < raw.length) spans.push({ from: a.start + valIdx + val.length, to: a.end, cls: 'hl-removed' });
      } else {
        spans.push({ from: a.start, to: a.end, cls: 'hl-removed' });
      }
    }

    // пустой prop="" → удалено целиком
    if (r.emptyPropAttr) spans.push({ from: r.emptyPropAttr.start, to: r.emptyPropAttr.end, cls: 'hl-removed' });

    spans.sort((a, b) => a.from - b.from);
    const out = [];
    let cur = 0;
    for (const s of spans) {
      if (s.from < cur) continue;
      if (s.from > cur) out.push({text: chunk.slice(cur, s.from)});
      out.push({text: chunk.slice(s.from, s.to), cls: s.cls});
      cur = s.to;
    }
    if (cur < chunk.length) out.push({text: chunk.slice(cur)});
    return out;
  }

    function buildRightSegments(output, html, reps) {
    const good = reps.filter(r => !r.error).sort((a, b) => a.start - b.start);
    if (good.length === 0) return [{text: output}];
    const segs = [];
    let cur = 0;    // позиция в output
    let shift = 0;  // накопленная разница длин между исходником и результатом
    for (const r of good) {
      const idx = r.start + shift;
      if (cur < idx) segs.push({text: output.slice(cur, idx)});
      if (r.newText) for (const p of splitRightChunk(r.newText, r)) segs.push(p);
      cur = idx + r.newText.length;
      shift += r.newText.length - (r.end - r.start);
    }
    if (cur < output.length) segs.push({text: output.slice(cur)});
    return segs;
  }

   function splitRightChunk(newText, r) {
    if (r.kind === 'strip') return [{text: '<'}, {text: 'table', cls: 'hl-changed'}, {text: '>'}];
    if (r.kind === 'bubble') {
      const c = newText.lastIndexOf('</bubble>');
      return [
        {text: '<'},
        {text: 'bubble', cls: 'hl-changed'},
        {text: newText.slice(7, c)},
        {text: '</'},
        {text: 'bubble', cls: 'hl-changed'},
        {text: '>'},
      ];
    }
    if (r.kind === 'aside') {
      if (!r.hasLink) return [{text: newText}];
      const o = r.linkAt;                              // начало <a href="…">
      const oEnd = newText.indexOf('>', o) + 1;        // конец открывающего <a>
      const c = newText.lastIndexOf('</a>');
      if (o === -1 || oEnd === 0 || c === -1) return [{text: newText}];
      // внутри <a href="…"> сам адрес не красим — он переехал без изменений
      const hrefStart = o + '<a href="'.length;
      const hrefEnd = hrefStart + r.urlAttr.value.length;
      return [
        {text: newText.slice(0, o)},
        {text: newText.slice(o, hrefStart), cls: 'hl-added'},
        {text: newText.slice(hrefStart, hrefEnd)},
        {text: newText.slice(hrefEnd, oEnd), cls: 'hl-added'},
        {text: newText.slice(oEnd, c)},
        {text: '</a>', cls: 'hl-added'},
        {text: newText.slice(c + 4)},
      ];
    }
    if (r.kind === 'author') {
      const o = newText.indexOf('<description>'), c = newText.indexOf('</description>');
      const closeIdx = newText.lastIndexOf('</author>');
      const out = [];
      if (o === -1 || c === -1) {
        out.push({text: newText.slice(0, closeIdx)});
      } else {
        out.push({text: newText.slice(0, o)});
        out.push({text: '<description>', cls: 'hl-added'});
        out.push({text: newText.slice(o + 13, c)});
        out.push({text: '</description>', cls: 'hl-added'});
        out.push({text: newText.slice(c + 14, closeIdx)});
      }
      // </author> был в исходнике — не подсвечиваем; появился из /> — подсвечиваем
      out.push(r.aSelfClosing ? {text: '</author>', cls: 'hl-added'} : {text: '</author>'});
      return out;
    }
    if (r.kind === 'hl') {
      const o = newText.indexOf('<h3>'), c = newText.indexOf('</h3>');
      if (o === -1 || c === -1) return [{text: newText}];
      return [
        {text: newText.slice(0, o)},
        {text: '<h3>', cls: 'hl-added'},
        {text: newText.slice(o + 4, c)},
        {text: '</h3>', cls: 'hl-added'},
        {text: newText.slice(c + 5)},
      ];
    }
    if (r.kind === 'details') {
      const o = newText.indexOf('<title>'), c = newText.indexOf('</title>');
      if (o === -1 || c === -1) return [{text: newText}];
      return [
        {text: newText.slice(0, o)},
        {text: '<title>', cls: 'hl-added'},
        {text: newText.slice(o + 7, c)},
        {text: '</title>', cls: 'hl-added'},
        {text: newText.slice(c + 8)},
      ];
    }
    const out = [];
    // имя image если было img -> hl-changed
    const nameStart = newText.indexOf('<image');
    if (nameStart !== -1 && r.tagName === 'img') {
      if (nameStart > 0) out.push({text: newText.slice(0, nameStart+1)});
      else out.push({text: '<'});
      out.push({text: 'image', cls: 'hl-changed'});
      let rest = newText.slice(nameStart+6);
      // найдем <caption> и </caption> и финальный </image> как hl-added
      const capOpen = '<caption>';
      const capClose = '</caption>';
      const capO = rest.indexOf(capOpen);
      if (capO !== -1) {
        out.push({text: rest.slice(0, capO)});
        out.push({text: capOpen, cls: 'hl-added'});
        const capTextStart = capO + capOpen.length;
        const capC = rest.indexOf(capClose, capTextStart);
        if (capC !== -1) {
          out.push({text: rest.slice(capTextStart, capC)}); // сам текст не подсвечиваем
          out.push({text: capClose, cls: 'hl-added'});
          const afterCap = rest.slice(capC + capClose.length);
          // финальный </image>
          const closeIdx = afterCap.indexOf('</image>');
          if (closeIdx !== -1) {
            if (closeIdx > 0) {
              // учитываем возможный \n и отступ перед </image>
              const beforeClose = afterCap.slice(0, closeIdx);
              // подсветим только тег, отступ оставим без подсветки
              const wsMatch = beforeClose.match(/(\n[ \t]*)$/);
              if (wsMatch) {
                out.push({text: beforeClose.slice(0, beforeClose.length - wsMatch[1].length)});
                out.push({text: wsMatch[1]});
              } else {
                out.push({text: beforeClose});
              }
            }
            out.push({text: '</image>', cls: 'hl-added'});
            const tail = afterCap.slice(closeIdx + 8);
            if (tail) out.push({text: tail});
          } else {
            out.push({text: afterCap});
          }
        } else {
          out.push({text: rest.slice(capTextStart)});
        }
      } else {
        // без caption: подсвечиваем добавленный </image> если он был добавлен (self-closing case)
        if (r.isSelfClosing) {
          const ci = rest.indexOf('</image>');
          if (ci !== -1) {
            out.push({text: rest.slice(0, ci)});
            out.push({text: '</image>', cls: 'hl-added'});
            out.push({text: rest.slice(ci+8)});
          } else {
            out.push({text: rest});
          }
        } else {
          out.push({text: rest});
        }
      }
      return out;
    }
    // если имя не менялось, просто подсветим добавленные caption/close
    if (newText.includes('<caption>')) {
      return splitRightChunk(newText, {...r, tagName:'img'}); // reuse логику выше для подсветки caption
    }
    return [{text: newText}];
  }

  // --- render ---
  // Рисуем текст построчно + гуттер с номерами и маркерами правок.
  // Подсветка внутри строки сохраняется (тег и атрибут могут быть на одной строке).
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

  // При переносе длинной строки номер в гуттере тянется на ту же высоту
  function syncGutterHeights(preEl, gutterEl) {
    const rows = preEl.children, gs = gutterEl.children;
    for (let i = 0; i < rows.length && i < gs.length; i++) {
      gs[i].style.height = rows[i].getBoundingClientRect().height + 'px';
    }
  }
  // показать результат в правом поле
  function renderOutput(res) {
    // сначала показываем поле, потом рисуем — иначе высоты строк считаются по скрытому элементу
    outputEmpty.hidden = true;
    outputBox.hidden = false;
    staleBar.hidden = true;
    outputPane.classList.remove('stale');
    renderDiff(diffRight, gutterRight, res.right);
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
    const res = fix(src);
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
    try {
      await navigator.clipboard.writeText(lastOutput);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = lastOutput;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    const old = btnCopy.textContent;
    btnCopy.textContent = 'Скопировано';
    setTimeout(() => (btnCopy.textContent = old), 1200);
  }

  function clearAll() {
    setInput('');
    clearOutput();
    lastChecked = null;
    view.focus();
  }

  btnFix.addEventListener('click', run);
  btnRefix.addEventListener('click', run);
  btnCopy.addEventListener('click', copyOutput);
  btnClear.addEventListener('click', clearAll);


  window.addEventListener('resize', () => syncGutterHeights(diffRight, gutterRight));

  clearOutput();
})();
