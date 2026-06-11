'use client';

import React from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { vscodeDark } from '@uiw/codemirror-theme-vscode';
import { EditorView } from '@codemirror/view';

interface Props {
  value: string;
  onChange: (next: string) => void;
  height?: string;
  // The compile state controls whether the editor border highlights green/red.
  status?: 'idle' | 'compiling' | 'ready' | 'error';
}

// Match the surrounding cards: small font, dark slate-ish background, no
// scrollbar boxout. CodeMirror's default focus outline is replaced by a
// blue border so it lines up with the textareas elsewhere in the dashboard.
const baseTheme = EditorView.theme({
  '&': { fontSize: '12px', backgroundColor: '#020617' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  '.cm-gutters': { backgroundColor: '#020617', borderRight: '1px solid #1e293b', color: '#475569' },
  '.cm-activeLine': { backgroundColor: 'rgba(30, 41, 59, 0.4)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#94a3b8' },
  '.cm-content': { caretColor: '#60a5fa' },
  '&.cm-focused': { outline: 'none' },
});

export const PythonCodeEditor: React.FC<Props> = ({ value, onChange, height = '288px', status = 'idle' }) => {
  const borderClass =
    status === 'ready' ? 'border-emerald-700/60' :
    status === 'error' ? 'border-red-700/60' :
    'border-slate-700';

  return (
    <div className={`rounded border ${borderClass} overflow-hidden`}>
      <CodeMirror
        value={value}
        onChange={onChange}
        height={height}
        theme={vscodeDark}
        extensions={[python(), baseTheme]}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          autocompletion: false,
          tabSize: 4,
          indentOnInput: true,
        }}
      />
    </div>
  );
};

export default PythonCodeEditor;
