import { EditorState, StateField, StateEffect, RangeSet } from '@codemirror/state';
import { EditorView, Decoration, GutterMarker, WidgetType, lineNumbers, lineNumberMarkers,
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

  // серый блок высотой в N строк, вставляется между строками для выравнивания с правым полем
  class PadWidget extends WidgetType {
    constructor(count) { super(); this.count = count; }
    eq(other) { return other.count === this.count; }
    toDOM() {
      const el = document.createElement('div');
      el.className = 'cm-pad';
      el.style.height = (this.count * 1.5) + 'em';
      return el;
    }
    get estimatedHeight() { return this.count * 19.5; }
    ignoreEvent() { return true; }
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

    function applyLeftMarks(marks, diagnostics, pads) {
    const doc = view.state.doc;
    const valid = marks.filter((m) => m.to > m.from && m.to <= doc.length);
    const decos = valid.map((m) => Decoration.mark({ class: 'cm-' + m.cls }).range(m.from, m.to));

    // заглушки после строк, где справа стало больше строк
    for (const p of pads || []) {
      const lineNo = Math.min(p.afterLine + 1, doc.lines);
      decos.push(Decoration.widget({ widget: new PadWidget(p.count), block: true, side: 1 }).range(doc.line(lineNo).to));
    }

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

  // Главный трансформер
  function fix(html) {
    const replacements = []; // {start,end, newText, leftHighlights[], rightHighlights[], error?}
    const msgs = [];
    let pos = 0;

    while (pos < html.length) {
      const lt = html.indexOf('<', pos);
      if (lt === -1) break;

      // быстро проверяем <img или <image
      const head = html.slice(lt, lt + 10).toLowerCase();
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
            start: lt, end: openEnd, newText: openText,
            error: true, openText
          });
          msgs.push({ level: 'error', text: `Ошибка разметки: не найден </image> для тега на позиции ${lt}.` });
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
        replacements.push({ start: lt, end: fullEnd, newText: html.slice(lt, fullEnd), error: true, openText, inner, closeText });
        msgs.push({ level: 'error', text: `Конфликт: атрибут caption и тег <caption> одновременно на позиции ${lt} — пропускаем.` });
        pos = fullEnd;
        continue;
      }
      if (captionAttr && inner.trim() !== '') {
        replacements.push({ start: lt, end: fullEnd, newText: html.slice(lt, fullEnd), error: true, openText, inner, closeText });
        msgs.push({ level: 'error', text: `Внутри <image> с caption="..." найден вложенный контент на позиции ${lt} — пропускаем.` });
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
    const errorTexts = msgs.filter(m => m.level === 'error').map(m => m.text);
    const diagnostics = marks
      .filter(m => m.cls === 'hl-error')
      .map((m, i) => ({ from: m.from, to: m.to, message: errorTexts[i] || 'Ошибка разметки — элемент пропущен.' }));

    // Заглушки для выравнивания полей: если замена добавила N строк справа,
    // слева после этой строки вставляем N пустых строк (и наоборот).
    // afterLine — номер строки (с нуля), после которой вставить; count — сколько.
    const countNl = (s) => (s.match(/\n/g) || []).length;
    const pads = { left: [], right: [] };
    let shift = 0; // накопленный сдвиг строк между исходником и результатом
    for (const r of [...replacements].sort((a, b) => a.start - b.start)) {
      if (r.error) continue;
      const oldLines = countNl(html.slice(r.start, r.end));
      const newLines = countNl(r.newText);
      const delta = newLines - oldLines;
      if (delta !== 0) {
        const srcEndLine = countNl(html.slice(0, r.end));
        if (delta > 0) pads.left.push({ afterLine: srcEndLine, count: delta });
        else pads.right.push({ afterLine: srcEndLine + shift + delta, count: -delta });
      }
      shift += delta;
    }

    return { output, left: leftSegments, right: rightSegments, marks, diagnostics, pads, messages: msgs };
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
    const spans = []; // {from, to, cls} — позиции внутри chunk

    // имя тега img → изменено
    const nameStart = chunk.indexOf('<' + r.tagName);
    if (nameStart !== -1 && r.tagName === 'img') spans.push({ from: nameStart + 1, to: nameStart + 4, cls: 'hl-changed' });

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
    if (reps.length===0) return [{text: output}];
    // для правой части подсвечиваем добавленные куски: <caption>, </caption>, </image>, и изменённое имя
    // самый простой способ: пройдем по output и найдем вставленные newText
    const good = reps.filter(r=>!r.error).sort((a,b)=> a.start - b.start);
    // надо найти позиции newText в output - они идут по порядку, но из-за сдвигов проще идти по output слева направо и искать newText
    let cur = 0;
    const segs = [];
    let searchFrom = 0;
    for (const r of good) {
      const idx = output.indexOf(r.newText, searchFrom);
      if (idx === -1) continue;
      if (cur < idx) segs.push({text: output.slice(cur, idx)});
      // внутри newText подсветим добавленные части
      const parts = splitRightChunk(r.newText, r);
      for (const p of parts) segs.push(p);
      cur = idx + r.newText.length;
      searchFrom = cur;
    }
    if (cur < output.length) segs.push({text: output.slice(cur)});
    // ошибки: в правой части тоже подсветим тот же chunk как hl-error (он не менялся)
    for (const r of reps.filter(r=>r.error)) {
      // найдем его в output (он там остался как был)
      // уже учтён выше как часть "до/после", но если мы его пропустили - подсветим отдельно
    }
    return segs.length? segs : [{text: output}];
  }

  function splitRightChunk(newText, r) {
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
  function renderDiff(preEl, gutterEl, segments, pads) {
    preEl.textContent = '';
    gutterEl.textContent = '';

    // после каких строк (с нуля) и сколько пустых строк вставить
    const padAt = new Map();
    for (const p of pads || []) padAt.set(p.afterLine, (padAt.get(p.afterLine) || 0) + p.count);

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

    for (let li = 0; li < lines.length; li++) {
      const parts = lines[li];
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

      // заглушка, если слева после этой строки строк больше
      const padCount = padAt.get(Math.min(li, lines.length - 1));
      if (padCount && (li === lines.length - 1 || padAt.has(li))) {
        const pad = document.createElement('div');
        pad.className = 'c-line c-pad';
        pad.style.height = (padCount * 1.5) + 'em';
        fragPre.appendChild(pad);
        const gp = document.createElement('div');
        gp.className = 'g-line g-pad';
        fragGut.appendChild(gp);
      }
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
    renderDiff(diffRight, gutterRight, res.right, res.pads.right);
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
     applyLeftMarks(res.marks, res.diagnostics, res.pads.left);
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
