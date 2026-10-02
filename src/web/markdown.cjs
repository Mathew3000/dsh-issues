/*
 * Small, safe Markdown renderer for issue text (GitHub flavoured subset).
 * Pure parser -> tree of plain objects; toDom builds DOM nodes with
 * createElement/createTextNode only, so no HTML from the text is ever parsed.
 * Supported: headings, paragraphs (newline = line break), fenced code, quotes,
 * nested lists with task items, tables, rules, `code`, **bold**, *italic*,
 * ~~strike~~, [links](https://...) and bare http(s) URLs. Images show as links.
 */
var Markdown = (function () {
  'use strict';

  var SAFE_URL = /^(https?:\/\/|mailto:)/i;

  function leading(line) { return /^ */.exec(line)[0].length; }
  function isBlank(line) { return /^\s*$/.test(line); }

  var FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
  var HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  var RULE = /^ {0,3}([-*_])(?: *\1){2,} *$/;
  var QUOTE = /^ {0,3}> ?/;
  var ITEM = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
  var TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  function startsBlock(line) {
    return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line);
  }

  function splitRow(line) {
    var s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|' && s.charAt(s.length - 2) !== '\\') s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map(function (cell) { return cell.replace(/\\\|/g, '|').trim(); });
  }

  function parseBlocks(lines, depth) {
    var out = [];
    var i = 0;
    if (depth > 12) return [{ type: 'p', children: inline(lines.join('\n')) }];
    while (i < lines.length) {
      var line = lines[i];
      if (isBlank(line)) { i++; continue; }

      var m = FENCE.exec(line);
      if (m) {
        var fence = m[1], body = [];
        i++;
        while (i < lines.length) {
          var close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]);
          if (close && close[1].charAt(0) === fence.charAt(0) && close[1].length >= fence.length) { i++; break; }
          body.push(lines[i]); i++;
        }
        out.push({ type: 'code', lang: m[2], text: body.join('\n') });
        continue;
      }
      m = HEADING.exec(line);
      if (m) { out.push({ type: 'heading', level: m[1].length, children: inline(m[2]) }); i++; continue; }
      if (RULE.test(line)) { out.push({ type: 'rule' }); i++; continue; }

      if (QUOTE.test(line)) {
        var quoted = [];
        while (i < lines.length && (QUOTE.test(lines[i]) || (!isBlank(lines[i]) && quoted.length && !startsBlock(lines[i])))) {
          quoted.push(lines[i].replace(QUOTE, '')); i++;
        }
        out.push({ type: 'quote', children: parseBlocks(quoted, depth + 1) });
        continue;
      }

      m = ITEM.exec(line);
      if (m) {
        var ordered = /\d/.test(m[2].charAt(0));
        var base = m[1].length;
        var items = [];
        while (i < lines.length) {
          var im = ITEM.exec(lines[i]);
          if (!im || im[1].length > base + 1 || /\d/.test(im[2].charAt(0)) !== ordered || RULE.test(lines[i])) break;
          var width = im[1].length + im[2].length + Math.max(1, Math.min(im[3].length, 4));
          var content = [im[4]];
          i++;
          while (i < lines.length) {
            var next = lines[i];
            if (isBlank(next)) {
              var j = i; while (j < lines.length && isBlank(lines[j])) j++;
              if (j < lines.length && leading(lines[j]) >= width) { for (; i < j; i++) content.push(''); continue; }
              break;
            }
            if (leading(next) >= width) { content.push(next.slice(width)); i++; continue; }
            if (leading(next) > base && !ITEM.test(next)) { content.push(next.replace(/^ +/, '')); i++; continue; }
            if (!ITEM.test(next) && !startsBlock(next) && content.length && !isBlank(content[content.length - 1])) { content.push(next); i++; continue; }
            break;
          }
          var task = /^\[([ xX])\]\s+/.exec(content[0]);
          var checked;
          if (task) { checked = task[1] !== ' '; content[0] = content[0].slice(task[0].length); }
          var children = parseBlocks(content, depth + 1);
          items.push({ checked: checked, children: children });
        }
        var list = { type: 'list', ordered: ordered, items: items };
        if (ordered) list.start = parseInt(m[2], 10);
        out.push(list);
        continue;
      }

      if (line.indexOf('|') >= 0 && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].indexOf('-') >= 0) {
        var head = splitRow(line);
        var align = splitRow(lines[i + 1]).map(function (c) {
          return /^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : '';
        });
        i += 2;
        var rows = [];
        while (i < lines.length && !isBlank(lines[i]) && lines[i].indexOf('|') >= 0) { rows.push(splitRow(lines[i])); i++; }
        out.push({
          type: 'table', align: align,
          head: head.map(function (c) { return inline(c); }),
          rows: rows.map(function (r) { return r.map(function (c) { return inline(c); }); })
        });
        continue;
      }

      var para = [line];
      i++;
      while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) { para.push(lines[i]); i++; }
      out.push({ type: 'p', children: inline(para.map(function (l) { return l.replace(/^\s+/, ''); }).join('\n')) });
    }
    return out;
  }

  function findClose(s, from, delim) {
    for (var j = from; j < s.length; j++) {
      if (s.charAt(j) === '\\') { j++; continue; }
      if (s.charAt(j) === '`') { var end = s.indexOf('`', j + 1); if (end > 0) { j = end; continue; } }
      if (s.substr(j, delim.length) !== delim) continue;
      if (/\s/.test(s.charAt(j - 1))) continue;
      if (delim.length === 1 && (s.charAt(j + 1) === delim || s.charAt(j - 1) === delim)) continue;
      if (delim === '_' && /[A-Za-z0-9]/.test(s.charAt(j + 1))) continue;
      return j;
    }
    return -1;
  }

  function matchBracket(s, open) {
    var depth = 0;
    for (var j = open; j < s.length; j++) {
      var c = s.charAt(j);
      if (c === '\\') { j++; continue; }
      if (c === '`') { var end = s.indexOf('`', j + 1); if (end > 0) { j = end; continue; } }
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) return j; }
    }
    return -1;
  }

  function parseDestination(s, start) {
    // s.charAt(start) === '(' ; returns { url, end } or null
    var j = start + 1, depth = 1, url = '';
    while (j < s.length && /\s/.test(s.charAt(j))) j++;
    var begin = j;
    if (s.charAt(j) === '<') {
      var close = s.indexOf('>', j);
      if (close < 0) return null;
      url = s.slice(j + 1, close); j = close + 1;
      while (j < s.length && s.charAt(j) !== ')') j++;
      return s.charAt(j) === ')' ? { url: url, end: j + 1 } : null;
    }
    for (; j < s.length; j++) {
      var c = s.charAt(j);
      if (c === '\\') { j++; continue; }
      if (/\s/.test(c)) break;
      if (c === '(') depth++;
      if (c === ')') { depth--; if (depth === 0) break; }
    }
    url = s.slice(begin, j);
    while (j < s.length && s.charAt(j) !== ')' ) j++;
    return s.charAt(j) === ')' ? { url: url, end: j + 1 } : null;
  }

  function inline(s) {
    var out = [], buf = '', i = 0;
    function flush() { if (buf) { out.push({ type: 'text', text: buf }); buf = ''; } }
    while (i < s.length) {
      var c = s.charAt(i), rest, m;
      if (c === '\\' && /[\\`*_{}\[\]()#+\-.!|~<>]/.test(s.charAt(i + 1))) { buf += s.charAt(i + 1); i += 2; continue; }
      if (c === '\n') { flush(); out.push({ type: 'br' }); i++; continue; }
      if (c === '`') {
        var run = /^`+/.exec(s.slice(i))[0];
        var end = s.indexOf(run, i + run.length);
        while (end > 0 && s.charAt(end + run.length) === '`') end = s.indexOf(run, end + run.length + 1);
        if (end > 0) {
          flush();
          out.push({ type: 'code', text: s.slice(i + run.length, end).replace(/^ (.*) $/, '$1') });
          i = end + run.length; continue;
        }
        buf += run; i += run.length; continue;
      }
      if (c === '!' && s.charAt(i + 1) === '[') {
        var closeImg = matchBracket(s, i + 1);
        if (closeImg > 0 && s.charAt(closeImg + 1) === '(') {
          var dest = parseDestination(s, closeImg + 1);
          if (dest) {
            flush();
            var alt = s.slice(i + 2, closeImg);
            out.push({ type: 'link', url: dest.url, children: [{ type: 'text', text: alt || dest.url }], image: true });
            i = dest.end; continue;
          }
        }
      }
      if (c === '[') {
        var closeText = matchBracket(s, i);
        if (closeText > 0 && s.charAt(closeText + 1) === '(') {
          var target = parseDestination(s, closeText + 1);
          if (target) {
            flush();
            out.push({ type: 'link', url: target.url, children: inline(s.slice(i + 1, closeText)) });
            i = target.end; continue;
          }
        }
      }
      if (c === '<') {
        m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i));
        if (m) { flush(); out.push({ type: 'link', url: m[1], children: [{ type: 'text', text: m[1] }] }); i += m[0].length; continue; }
      }
      if ((c === 'h' || c === 'H') && (i === 0 || /[\s(\[>]/.test(s.charAt(i - 1)))) {
        m = /^https?:\/\/[^\s<]+/i.exec(s.slice(i));
        if (m) {
          var url = m[0].replace(/[.,;:!?'"]+$/, '');
          while (/\)$/.test(url) && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length) url = url.slice(0, -1);
          flush(); out.push({ type: 'link', url: url, children: [{ type: 'text', text: url }] }); i += url.length; continue;
        }
      }
      if (c === '~' && s.charAt(i + 1) === '~' && !/\s/.test(s.charAt(i + 2))) {
        var endDel = findClose(s, i + 2, '~~');
        if (endDel > 0) { flush(); out.push({ type: 'del', children: inline(s.slice(i + 2, endDel)) }); i = endDel + 2; continue; }
      }
      if ((c === '*' || c === '_') && !/\s/.test(s.charAt(i + (s.charAt(i + 1) === c ? 2 : 1)) || ' ')) {
        var double = s.charAt(i + 1) === c;
        var delim = double ? c + c : c;
        var okOpen = c === '*' || i === 0 || !/[A-Za-z0-9]/.test(s.charAt(i - 1));
        if (okOpen) {
          var endEm = findClose(s, i + delim.length, delim);
          if (endEm > i + delim.length) {
            flush();
            out.push({ type: double ? 'strong' : 'em', children: inline(s.slice(i + delim.length, endEm)) });
            i = endEm + delim.length; continue;
          }
        }
      }
      buf += c; i++;
    }
    flush();
    return out;
  }

  function parse(text) {
    var source = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
    return parseBlocks(source.split('\n'), 0);
  }

  function safeUrl(url) { return SAFE_URL.test(String(url).trim()) ? String(url).trim() : null; }

  function inlineToDom(doc, nodes) {
    var frag = doc.createDocumentFragment();
    nodes.forEach(function (node) {
      var el;
      switch (node.type) {
        case 'text': frag.appendChild(doc.createTextNode(node.text)); break;
        case 'br': frag.appendChild(doc.createElement('br')); break;
        case 'code': el = doc.createElement('code'); el.textContent = node.text; frag.appendChild(el); break;
        case 'strong': case 'em': case 'del':
          el = doc.createElement(node.type); el.appendChild(inlineToDom(doc, node.children)); frag.appendChild(el); break;
        case 'link':
          var href = safeUrl(node.url);
          if (!href) { frag.appendChild(inlineToDom(doc, node.children)); break; }
          el = doc.createElement('a');
          el.setAttribute('href', href);
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer nofollow');
          el.appendChild(inlineToDom(doc, node.children));
          frag.appendChild(el);
          break;
      }
    });
    return frag;
  }

  function blocksToDom(doc, blocks, tight) {
    var frag = doc.createDocumentFragment();
    blocks.forEach(function (b) {
      var el;
      switch (b.type) {
        case 'p':
          if (tight) { frag.appendChild(inlineToDom(doc, b.children)); break; }
          el = doc.createElement('p'); el.appendChild(inlineToDom(doc, b.children)); frag.appendChild(el); break;
        case 'heading':
          el = doc.createElement('h' + b.level); el.appendChild(inlineToDom(doc, b.children)); frag.appendChild(el); break;
        case 'rule': frag.appendChild(doc.createElement('hr')); break;
        case 'code':
          el = doc.createElement('pre');
          var code = doc.createElement('code'); code.textContent = b.text;
          if (b.lang) el.setAttribute('data-lang', b.lang);
          el.appendChild(code); frag.appendChild(el); break;
        case 'quote':
          el = doc.createElement('blockquote'); el.appendChild(blocksToDom(doc, b.children, false)); frag.appendChild(el); break;
        case 'list':
          el = doc.createElement(b.ordered ? 'ol' : 'ul');
          if (b.ordered && b.start && b.start !== 1) el.setAttribute('start', String(b.start));
          b.items.forEach(function (item) {
            var li = doc.createElement('li');
            if (item.checked !== undefined) {
              li.className = 'task';
              var box = doc.createElement('input');
              box.type = 'checkbox'; box.disabled = true; box.checked = item.checked;
              li.appendChild(box);
            }
            var simple = item.children.length === 1 && item.children[0].type === 'p';
            li.appendChild(blocksToDom(doc, item.children, simple));
            el.appendChild(li);
          });
          frag.appendChild(el); break;
        case 'table':
          el = doc.createElement('table');
          var thead = doc.createElement('thead'), hr = doc.createElement('tr');
          b.head.forEach(function (cell, idx) {
            var th = doc.createElement('th');
            if (b.align[idx]) th.className = 'a-' + b.align[idx];
            th.appendChild(inlineToDom(doc, cell)); hr.appendChild(th);
          });
          thead.appendChild(hr); el.appendChild(thead);
          var tbody = doc.createElement('tbody');
          b.rows.forEach(function (row) {
            var tr = doc.createElement('tr');
            b.head.forEach(function (_h, idx) {
              var td = doc.createElement('td');
              if (b.align[idx]) td.className = 'a-' + b.align[idx];
              td.appendChild(inlineToDom(doc, row[idx] || [])); tr.appendChild(td);
            });
            tbody.appendChild(tr);
          });
          el.appendChild(tbody);
          var wrap = doc.createElement('div'); wrap.className = 'table-wrap'; wrap.appendChild(el);
          frag.appendChild(wrap); break;
      }
    });
    return frag;
  }

  /** Render Markdown text into a container element (replacing its content). */
  function render(doc, container, text) {
    container.replaceChildren(blocksToDom(doc, parse(text), false));
    return container;
  }

  return { parse: parse, inline: inline, render: render, toDom: blocksToDom, safeUrl: safeUrl };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Markdown;
