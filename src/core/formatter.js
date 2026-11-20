(function (root) {
  'use strict';

  const languages = Object.freeze([
    {id: 'auto', label: 'Auto-detect'}, {id: 'json', label: 'JSON'},
    {id: 'jsonl', label: 'JSONL'}, {id: 'javascript', label: 'JavaScript'},
    {id: 'typescript', label: 'TypeScript'}, {id: 'python', label: 'Python'},
    {id: 'bash', label: 'Shell'}, {id: 'yaml', label: 'YAML'},
    {id: 'xml', label: 'XML / HTML'}, {id: 'markdown', label: 'Markdown'},
    {id: 'text', label: 'Plain text'},
  ].map(language => Object.freeze(language)));
  const supported = new Set(languages.map(language => language.id));
  const aliases = {js: 'javascript', ts: 'typescript', py: 'python', sh: 'bash', shell: 'bash', html: 'xml', md: 'markdown', yml: 'yaml', plaintext: 'text', plain: 'text'};
  const escape = value => value.replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
  const cleanBom = value => value.replace(/^\uFEFF/, '');
  const parse = value => JSON.parse(cleanBom(value));
  const normalizeLanguage = value => {
    const id = typeof value === 'string' ? value.toLowerCase() : 'auto';
    return supported.has(id) ? id : Object.hasOwn(aliases, id) ? aliases[id] : 'text';
  };
  const keywords = {
    javascript: new Set('async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield'.split(' ')),
    typescript: new Set('abstract any as asserts async await boolean break case catch class const constructor continue declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface is keyof let namespace never new number of private protected public readonly require return satisfies set static string super switch symbol this throw try type typeof unknown var void while with yield'.split(' ')),
    python: new Set('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' ')),
    bash: new Set('if then else elif fi for in do done while until case esac function select time coproc export readonly local declare typeset return exit break continue source alias unalias eval exec set unset cd echo printf read test pwd true false'.split(' ')),
  };

  function detectLanguage(source, hint) {
    const trimmed = source.trim();
    if (!trimmed) return 'text';
    try { parse(trimmed); return 'json'; } catch {}
    const lines = source.split(/\r?\n/).filter(line => line.trim());
    if (lines.length > 1 && /^[\[{]/.test(lines[0].trim())) {
      try { parse(lines[0]); return 'jsonl'; } catch {}
    }
    const hints = String(hint || '').toLowerCase();
    const hinted = [
      ['jsonl', /\bjsonl\b|\.ndjson\b/], ['json', /\bjson\b/],
      ['typescript', /\btypescript\b|\.tsx?\b/], ['javascript', /\bjavascript\b|\.m?jsx?\b/],
      ['python', /\bpython\b|\.py\b/], ['bash', /\bbash\b|\bshell\b|exec_command|\.sh\b/],
      ['yaml', /\byaml\b|\.ya?ml\b/], ['xml', /\bxml\b|\bhtml\b/], ['markdown', /\bmarkdown\b|\.md\b/],
    ].find(([, pattern]) => pattern.test(hints));
    if (hinted) return hinted[0];
    if (/^[\[{]/.test(trimmed)) return 'json';
    if (/^#!.*\b(?:ba|z|k)?sh\b|^(?:export\s+\w+=|(?:ls|cd|cat|pwd|echo|printf|find|rg|grep|git|npm|pnpm|node|python3?|curl|sed|awk|mkdir)\s+)/m.test(trimmed)) return 'bash';
    if (/^\s*(?:def\s+\w+\(|from\s+[\w.]+\s+import\b|import\s+[\w.]+\s*$|class\s+\w+.*:)/m.test(source)) return 'python';
    if (/^\s*(?:interface|type|enum|namespace)\s+\w+|\b(?:const|let)\s+\w+\s*:\s*(?:string|number|boolean)\b/m.test(source)) return 'typescript';
    if (/^\s*(?:const|let|var|function|export|import)\s+|=>/m.test(source)) return 'javascript';
    if (/^\s*<(?:\?xml\b|!DOCTYPE\b|[a-zA-Z][\w:.-]*(?:\s|>|\/))/i.test(source)) return 'xml';
    if (/^\s*(?:#{1,6}\s|```|[-*]\s+)|\[[^\]]+\]\([^\n)]+\)/m.test(source)) return 'markdown';
    if (/^\s*[\w.-]+\s*:\s*\S/m.test(source)) return 'yaml';
    return 'text';
  }

  function document(source, options = {}) {
    const text = typeof source === 'string' ? source : JSON.stringify(source, null, 2) ?? '';
    const requested = normalizeLanguage(options.language ?? 'auto');
    return {
      id: String(options.id ?? ''), title: String(options.title ?? ''), source: text,
      suggestedLanguage: requested === 'auto' ? detectLanguage(text, options.hint) : requested,
      origin: options.origin ?? null,
    };
  }

  const quoted = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/y;
  const number = /(?:0[xX][\da-fA-F]+|0[bB][01]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/y;
  const identifier = /[A-Za-z_$][\w$]*/y;
  const rule = (kind, expression) => ({kind, expression});
  const rules = {
    json: [rule('string', /"(?:\\[\s\S]|[^"\\])*"/y), rule('number', /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y), rule('word', identifier), rule('punctuation', /[{}\[\],:]/y)],
    javascript: [rule('comment', /\/\/[^\r\n]*|\/\*[\s\S]*?(?:\*\/|$)/y), rule('string', quoted), rule('number', number), rule('word', identifier), rule('operator', /(?:=>|===?|!==?|&&|\|\||\?\?|\?\.|\+\+|--|\*\*|[+\-*/%=<>!&|?:~^])/y), rule('punctuation', /[{}\[\](),;.]/y)],
    python: [rule('comment', /#[^\r\n]*/y), rule('string', /"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/y), rule('number', number), rule('word', identifier), rule('operator', /(?:\*\*|\/\/|==|!=|<=|>=|:=|[+\-*/%=<>!&|~^])/y), rule('punctuation', /[{}\[\](),.:;]/y)],
    bash: [rule('comment', /#[^\r\n]*/y), rule('string', quoted), rule('variable', /\$(?:\{[^}\r\n]*\}|[A-Za-z_][\w]*|[0-9@*#?$!_-])/y), rule('number', number), rule('word', /[A-Za-z_][\w-]*/y), rule('attribute', /--?[A-Za-z][\w-]*/y), rule('operator', /(?:&&|\|\||>>|<<|[|;&<>])/y), rule('punctuation', /[(){}\[\]]/y)],
    yaml: [rule('comment', /#[^\r\n]*/y), rule('string', quoted), rule('key', /^[ \t]*[A-Za-z_][\w .-]*(?=[ \t]*:)/my), rule('number', /-?(?:\d+(?:\.\d+)?)/y), rule('word', identifier), rule('punctuation', /[:{}\[\],|>]/y), rule('operator', /[-&*!]/y)],
    xml: [rule('comment', /<!--[\s\S]*?(?:-->|$)/y), rule('tag', /<\/?[A-Za-z_][\w:.-]*|<\?[\w.-]+|<!DOCTYPE\b|\/?>|\?>/iy), rule('string', quoted), rule('attribute', /[A-Za-z_][\w:.-]*(?=\s*=)/y), rule('operator', /=/y), rule('word', /[A-Za-z_][\w:.-]*/y)],
    markdown: [rule('string', /```[\s\S]*?(?:```|$)|`[^`\r\n]*`/y), rule('heading', /^ {0,3}#{1,6}[^\r\n]*/my), rule('link', /!?\[[^\]\r\n]*\]\([^\r\n)]*\)/y), rule('keyword', /\*\*[^\r\n]*?\*\*|__[^\r\n]*?__/y), rule('punctuation', /^\s*[-*>](?=\s)|^\s*\d+\.(?=\s)/my)],
  };
  rules.jsonl = rules.json;
  rules.typescript = rules.javascript;

  function tokenKind(kind, text, language, remaining) {
    if (kind === 'string' && ['json', 'jsonl'].includes(language) && /^\s*:/.test(remaining)) return 'key';
    if (kind !== 'word') return kind;
    if (/^(?:true|false|True|False|yes|no)$/i.test(text)) return 'boolean';
    if (/^(?:null|None|undefined|nil)$/i.test(text)) return 'null';
    return keywords[language]?.has(text) ? 'keyword' : null;
  }

  function highlightedLines(source, language) {
    const selectedRules = rules[language] || [];
    const lines = [''];
    function append(text, kind) {
      const pieces = text.split('\n');
      pieces.forEach((piece, index) => {
        if (index) lines.push('');
        if (piece) lines[lines.length - 1] += kind ? `<span class="tok-${kind}">${escape(piece)}</span>` : escape(piece);
      });
    }
    let plain = '';
    for (let position = 0; position < source.length;) {
      let matched = null;
      for (const candidate of selectedRules) {
        candidate.expression.lastIndex = position;
        const match = candidate.expression.exec(source);
        if (match && match[0]) { matched = {kind: candidate.kind, text: match[0]}; break; }
      }
      if (!matched) { plain += source[position++]; continue; }
      if (plain) { append(plain, null); plain = ''; }
      append(matched.text, tokenKind(matched.kind, matched.text, language, source.slice(position + matched.text.length)));
      position += matched.text.length;
    }
    if (plain) append(plain, null);
    return lines;
  }

  function present(doc, options = {}) {
    const source = doc.source;
    const requested = normalizeLanguage(options.language ?? 'auto');
    const language = requested === 'auto' ? normalizeLanguage(doc.suggestedLanguage) : requested;
    const raw = options.mode === 'raw';
    let text = source;
    let warning = null;
    if (language === 'json') {
      try { const value = parse(source); if (!raw) text = JSON.stringify(value, null, 2); }
      catch { warning = 'Could not parse JSON. The original text was kept.'; }
    } else if (language === 'jsonl') {
      const invalid = [];
      const formatted = source.split(/\r?\n/).map((line, index) => {
        if (!line.trim()) return line;
        try { return JSON.stringify(parse(line), null, 2); }
        catch { invalid.push(index + 1); return line; }
      });
      if (!raw) text = formatted.join('\n');
      if (invalid.length) warning = `Could not parse ${invalid.length === 1 ? 'line' : 'lines'} ${invalid.join(', ')}. The original text was kept.`;
    }
    const lines = highlightedLines(text, language === 'auto' ? 'text' : language);
    return {source, text, language: language === 'auto' ? 'text' : language, html: lines.join('\n'), lines, lineCount: lines.length, warning};
  }

  function previewOf(value, source) {
    const payload = value && typeof value === 'object' && value.payload && typeof value.payload === 'object' ? value.payload : {};
    const chunks = payload.content || payload.summary;
    const content = Array.isArray(chunks) ? chunks.map(chunk => typeof chunk?.text === 'string' ? chunk.text : '').filter(Boolean).join(' ') : '';
    const candidate = [payload.message, payload.text, content, payload.arguments, payload.input, payload.output, payload.name].find(part => typeof part === 'string' && part.length) || (typeof value === 'string' ? value : source);
    const compact = candidate.replace(/\s+/g, ' ').trim();
    return compact.length > 160 ? compact.slice(0, 160) + '…' : compact;
  }

  function records(rawSource) {
    const result = [];
    String(rawSource).split(/\r?\n/).forEach((source, index) => {
      if (!source.trim()) return;
      let value = null;
      let valid = true;
      try { value = parse(source); } catch { valid = false; }
      const isTrace = Number.isFinite(value?.wall_time_unix_ms) && typeof value?.payload?.type === 'string';
      const type = typeof value?.type === 'string' ? value.type : isTrace ? 'codex_trace' : 'unknown';
      const subtype = typeof value?.payload?.type === 'string' ? value.payload.type : null;
      const traceDate = isTrace ? new Date(value.wall_time_unix_ms) : null;
      result.push({
        line: index + 1, source, type, subtype, category: subtype ? `${type}/${subtype}` : type,
        timestamp: typeof value?.timestamp === 'string' ? value.timestamp : traceDate && Number.isFinite(traceDate.getTime()) ? traceDate.toISOString() : null,
        preview: previewOf(value, source), valid,
      });
    });
    return result;
  }

  function recordPage(list, options = {}) {
    const query = String(options.query ?? '').trim().toLowerCase();
    const type = String(options.type ?? 'all');
    const size = Number.isFinite(options.pageSize) ? Math.max(1, Math.trunc(options.pageSize)) : 50;
    const filtered = list.filter(record => (type === 'all' || record.type === type || record.category === type) && (!query || `${record.source} ${record.type} ${record.subtype || ''} ${record.preview}`.toLowerCase().includes(query)));
    const total = filtered.length;
    const pageCount = Math.max(1, Math.ceil(total / size));
    const requested = Number.isFinite(options.page) ? Math.trunc(options.page) : 1;
    const page = Math.min(pageCount, Math.max(1, requested));
    return {items: filtered.slice((page - 1) * size, page * size), filtered, total, page, pageCount, types: [...new Set(list.map(record => record.category))].sort()};
  }

  const api = {languages, document, present, records, recordPage};
  if (typeof module !== 'undefined') module.exports = api;
  else root.AgentFormat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
