// Renderer Markdown ringkas ala GitHub untuk viewer .md di panel admin.
// Output disanitasi lagi dengan sanitizeHtml (defense in depth).
// Mendukung: heading ATX, paragraf, code block berpagar, inline code,
// bold/italic/strikethrough, link, gambar (https saja), daftar ul/ol
// (termasuk task list), blockquote, hr, tabel GFM.
import { esc, sanitizeHtml } from './util.js';

const SAFE_URL = /^(https?:\/\/|\/|#|mailto:)/i;

function safeHref(u) {
  const v = String(u || '').trim();
  return SAFE_URL.test(v) ? v : '';
}

// Inline formatting pada teks yang SUDAH di-escape (jadi & < > aman).
// Code span dilindungi dulu dengan placeholder supaya tidak ikut diformat.
export function renderInline(raw) {
  let text = esc(raw);
  const codes = [];
  text = text.replace(/`([^`\n]+)`/g, (m, c) => {
    codes.push(c);
    return '\u0000' + (codes.length - 1) + '\u0000';
  });
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, url) => {
    const href = safeHref(url);
    return href ? '<img src="' + esc(href) + '" alt="' + alt + '">' : alt;
  });
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, label, url) => {
    const href = safeHref(url);
    return href ? '<a href="' + esc(href) + '">' + label + '</a>' : label;
  });
  text = text.replace(/<((https?:\/\/|mailto:)[^>\s]+)>/g, (m, url) => '<a href="' + esc(url) + '">' + url + '</a>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Underscore italic hanya bila tidak menempel di tengah kata (snake_case
  // tidak boleh jadi miring — GitHub juga begitu).
  text = text.replace(/(^|[\s(>"'])_([^_]+)_(?=$|[\s.,;:!?)"'<])/g, '$1<em>$2</em>');
  text = text.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  text = text.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + codes[Number(i)] + '</code>');
  return text;
}

function isTableSep(line) {
  const t = line.trim();
  if (!/^\|?[\s:|-]+\|?$/.test(t)) return false;
  const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.length > 0 && cells.every(c => /^:?-{1,}:?$/.test(c.trim()));
}

function parseTableRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map(c => renderInline(c.trim()));
}

export function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Code block berpagar
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { buf.push(lines[i]); i++; }
      i++; // lewati pagar penutup
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }
    // Heading ATX
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(6, h[1].length);
      out.push('<h' + level + '>' + renderInline(h[2].trim()) + '</h' + level + '>');
      i++;
      continue;
    }
    // Garis horizontal
    if (/^(\*\*\*|---|___)\s*$/.test(line.trim())) { out.push('<hr>'); i++; continue; }
    // Blockquote (rekursif — isi dirender sebagai Markdown lagi)
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push('<blockquote>' + renderMarkdown(buf.join('\n')) + '</blockquote>');
      continue;
    }
    // Tabel GFM: baris header + baris pemisah, lalu baris data
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = parseTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(parseTableRow(lines[i]));
        i++;
      }
      out.push('<table><thead><tr>' + head.map(c => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    // Daftar ul/ol (satu level; baris lanjutan berindentasi menempel ke item)
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const baseIndent = li[1].length;
      const ordered = /^\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m || m[1].length !== baseIndent || (/^\d/.test(m[2]) !== ordered)) break;
        let text = m[3];
        const task = text.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) text = (task[1].toLowerCase() === 'x' ? '☑ ' : '☐ ') + task[2];
        items.push(renderInline(text));
        i++;
        while (i < lines.length && lines[i].trim() !== '' && !lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+/) && /^\s+/.test(lines[i])) {
          items[items.length - 1] += ' ' + renderInline(lines[i].trim());
          i++;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push('<' + tag + '>' + items.map(t => '<li>' + t + '</li>').join('') + '</' + tag + '>');
      continue;
    }
    // Paragraf: baris-baris berurutan digabung (newline tunggal = spasi,
    // seperti GitHub); berhenti sebelum blok berikutnya.
    if (line.trim() !== '') {
      const buf = [];
      while (i < lines.length && lines[i].trim() !== '') {
        if (/^(#{1,6}\s|```|>)/.test(lines[i])) break;
        if (/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])) break;
        if (/^(\*\*\*|---|___)\s*$/.test(lines[i].trim())) break;
        if (lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) break;
        buf.push(lines[i].trim());
        i++;
      }
      out.push('<p>' + renderInline(buf.join(' ')) + '</p>');
      continue;
    }
    i++;
  }
  return sanitizeHtml(out.join('\n'));
}
