// Tiny per-language syntax highlighter used by the docs CodeBlock.
//
// Why roll our own instead of pulling in prism / shiki / highlight.js?
//   - Three languages (json / bash / python), all used at 80% coverage —
//     full grammars are overkill.
//   - Matches the dep-free tokenizer pattern already used by
//     config-generator's HighlightedJson, so the visual style stays
//     consistent across the dashboard.
//   - No bundle-size cost, no lazy-load dance.
//
// Each lexer is an ordered list of [kind, regex]. The runner builds a
// single master regex by alternating them with named capture groups; the
// FIRST rule in the list whose group fires wins, so put more-specific
// rules (e.g. "string-followed-by-colon" → key) before general ones.

import React from 'react';

type Lang = 'json' | 'bash' | 'python';

// Tailwind classes for each token kind. Kept loose (multiple kinds can
// reuse a colour) so adding a new language doesn't force palette
// expansion — just map the new kinds to one of the existing buckets.
const COLOR: Record<string, string> = {
  key:          'text-sky-400',
  string:       'text-emerald-400',
  triplestring: 'text-emerald-400',
  number:       'text-amber-400',
  bool:         'text-violet-400',
  keyword:      'text-violet-400',
  builtin:      'text-sky-400',
  flag:         'text-violet-400',
  decorator:    'text-violet-400',
  comment:      'text-slate-500 italic',
  prompt:       'text-slate-500',
  punct:        'text-slate-400',
};

type Rule = [kind: string, re: RegExp];

const RULES: Record<Lang, Rule[]> = {
  // JSON: a string immediately followed by ':' is a key, otherwise a
  // value-string. Numbers include scientific form. Booleans + null share
  // the violet "literal" colour.
  json: [
    ['key',    /"(?:\\.|[^"\\])*"(?=\s*:)/],
    ['string', /"(?:\\.|[^"\\])*"/],
    ['number', /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/],
    ['bool',   /\b(?:true|false|null)\b/],
    ['punct',  /[{}[\],:]/],
  ],
  // Bash: highlight comments, strings, the leading "$" prompt, and CLI
  // flags. We deliberately don't try to colour the command itself —
  // that would require a list of known commands and would silently
  // mis-render the moment someone uses `jq` or `httpie`.
  bash: [
    ['comment', /#[^\n]*/],
    ['string',  /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/],
    ['prompt',  /^\$(?=\s)/m],
    ['flag',    /(?<=\s|^)--?[a-zA-Z][\w-]*/],
    ['number',  /\b\d+(?:\.\d+)?\b/],
  ],
  // Python: triple-quoted strings before single-quoted, so """ doesn't
  // get carved up. Keyword + builtin lists are intentionally curated to
  // what actually appears in the docs samples — we're not aiming to be a
  // generic Python highlighter.
  python: [
    ['comment',      /#[^\n]*/],
    ['triplestring', /"""[\s\S]*?"""|'''[\s\S]*?'''/],
    ['string',       /[fr]?"(?:\\.|[^"\\])*"|[fr]?'(?:\\.|[^'\\])*'/],
    ['keyword',      /\b(?:import|from|as|def|class|if|else|elif|for|while|return|with|async|await|in|not|and|or|is|None|True|False|try|except|finally|raise|yield|lambda|pass|break|continue|global|nonlocal)\b/],
    ['builtin',      /\b(?:print|len|range|str|int|float|bool|list|dict|tuple|set|isinstance|enumerate|zip|map|filter|asyncio|json|websockets)\b/],
    ['decorator',    /@\w+/],
    ['number',       /\b\d+(?:\.\d+)?\b/],
  ],
};

interface Token { kind: string | null; text: string; }

// Build the combined regex once per call (cheap; rule lists are small).
// Named groups (g0, g1, ...) tell us which alternative matched — JS
// regex alternation is tried in order at each position, so the rule list
// order is the priority order.
function tokenize(src: string, rules: Rule[]): Token[] {
  const pattern = rules.map(([, r], i) => `(?<g${i}>${r.source})`).join('|');
  const re = new RegExp(pattern, 'gms');
  const out: Token[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ kind: null, text: src.slice(last, m.index) });
    let kind: string | null = null;
    if (m.groups) {
      for (let i = 0; i < rules.length; i++) {
        if (m.groups['g' + i] != null) { kind = rules[i][0]; break; }
      }
    }
    out.push({ kind, text: m[0] });
    last = re.lastIndex;
    // Defensive: zero-width match would loop forever. Bump past it.
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < src.length) out.push({ kind: null, text: src.slice(last) });
  return out;
}

export function highlight(lang: string | undefined, src: string): React.ReactNode {
  const rules = lang && (RULES as Record<string, Rule[] | undefined>)[lang];
  if (!rules) return src;
  const tokens = tokenize(src, rules);
  return tokens.map((t, i) => {
    if (t.kind == null) return <React.Fragment key={i}>{t.text}</React.Fragment>;
    const cls = COLOR[t.kind];
    if (!cls) return <React.Fragment key={i}>{t.text}</React.Fragment>;
    return <span key={i} className={cls}>{t.text}</span>;
  });
}
