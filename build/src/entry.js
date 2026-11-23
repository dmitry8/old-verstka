// Точка входа для сборки CodeMirror в один локальный бандл.
// Реэкспортируем ровно то, что используется в common.js, чтобы esbuild
// включил эти модули (и их транзитивные зависимости) в vendor/codemirror.bundle.js.
export {
  EditorState, StateField, StateEffect, RangeSet,
} from '@codemirror/state';
export {
  EditorView, Decoration, GutterMarker, lineNumbers, lineNumberMarkers,
  highlightActiveLine, highlightActiveLineGutter, keymap, placeholder,
} from '@codemirror/view';
export {
  defaultKeymap, history, historyKeymap,
} from '@codemirror/commands';
export { html } from '@codemirror/lang-html';
export {
  syntaxHighlighting, defaultHighlightStyle,
} from '@codemirror/language';
export { setDiagnostics } from '@codemirror/lint';