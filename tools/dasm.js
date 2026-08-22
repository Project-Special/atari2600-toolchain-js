/* ==========================================================================
   DASM.js — montador 6502 compatível com o DASM, escrito para o TIA Sprite
   Bench. Roda no navegador: o editor compila sem precisar de ajudante externo.

   A tabela de opcodes (incluindo os não documentados) foi extraída do próprio
   DASM 2.20 assemblando todas as combinações mnemônico × modo, então o que
   sai daqui bate byte a byte com `dasm fonte.asm -f3`.

       const r = DASM.assemble({ name: 'jogo.asm', source: texto });
       r.ok      -> true/false
       r.rom     -> Uint8Array com a ROM (formato -f3, cru)
       r.problems-> [{ file, line, kind: 'error'|'warning', message }]
       r.log     -> texto no formato das mensagens do DASM

   vcs.h e macro.h vêm embutidos; `includes: { 'nome.h': texto }` substitui os
   embutidos ou acrescenta outros arquivos.
   ========================================================================== */

const DASM = (() => {
  'use strict';

  const VERSION     = '1.0';
  const MAX_PASSES  = 16;
  const FILLER      = 0xff;   // o que o DASM põe nos buracos deixados por ORG
  const MAX_INCLUDE = 24;     // profundidade de include/macro, contra recursão

  /* --- opcodes -------------------------------------------------------------
     Modos: imp acc imm zp zpx zpy abs abx aby ind izx izy rel. Os ilegais são
     exatamente os que o DASM aceita — nem um a mais, para que um fonte que ele
     recusa seja recusado aqui também.
     ------------------------------------------------------------------------ */
  const OPTABLE = `
adc imm=69 zp=65 zpx=75 abs=6d abx=7d aby=79 izx=61 izy=71
and imm=29 zp=25 zpx=35 abs=2d abx=3d aby=39 izx=21 izy=31
asl acc=0a zp=06 zpx=16 abs=0e abx=1e
bcc rel=90
bcs rel=b0
beq rel=f0
bit zp=24 abs=2c
bmi rel=30
bne rel=d0
bpl rel=10
brk imp=00
bvc rel=50
bvs rel=70
clc imp=18
cld imp=d8
cli imp=58
clv imp=b8
cmp imm=c9 zp=c5 zpx=d5 abs=cd abx=dd aby=d9 izx=c1 izy=d1
cpx imm=e0 zp=e4 abs=ec
cpy imm=c0 zp=c4 abs=cc
dec zp=c6 zpx=d6 abs=ce abx=de
dex imp=ca
dey imp=88
eor imm=49 zp=45 zpx=55 abs=4d abx=5d aby=59 izx=41 izy=51
inc zp=e6 zpx=f6 abs=ee abx=fe
inx imp=e8
iny imp=c8
jmp abs=4c ind=6c
jsr abs=20
lda imm=a9 zp=a5 zpx=b5 abs=ad abx=bd aby=b9 izx=a1 izy=b1
ldx imm=a2 zp=a6 zpy=b6 abs=ae aby=be
ldy imm=a0 zp=a4 zpx=b4 abs=ac abx=bc
lsr acc=4a zp=46 zpx=56 abs=4e abx=5e
nop imp=ea imm=80 zp=04 zpx=14 abs=0c abx=1c
ora imm=09 zp=05 zpx=15 abs=0d abx=1d aby=19 izx=01 izy=11
pha imp=48
php imp=08
pla imp=68
plp imp=28
rol acc=2a zp=26 zpx=36 abs=2e abx=3e
ror acc=6a zp=66 zpx=76 abs=6e abx=7e
rti imp=40
rts imp=60
sbc imm=e9 zp=e5 zpx=f5 abs=ed abx=fd aby=f9 izx=e1 izy=f1
sec imp=38
sed imp=f8
sei imp=78
sta zp=85 zpx=95 abs=8d abx=9d aby=99 izx=81 izy=91
stx zp=86 zpy=96 abs=8e
sty zp=84 zpx=94 abs=8c
tax imp=aa
tay imp=a8
tsx imp=ba
txa imp=8a
txs imp=9a
tya imp=98
anc imm=0b
ane imm=8b
arr imm=6b
asr imm=4b
dcp zp=c7 zpx=d7 abs=cf abx=df aby=db izx=c3 izy=d3
isb zp=e7 zpx=f7 abs=ef abx=ff aby=fb izx=e3 izy=f3
las aby=bb
lax zp=a7 zpy=b7 abs=af aby=bf izx=a3 izy=b3
lxa imm=ab
rla zp=27 zpx=37 abs=2f abx=3f aby=3b izx=23 izy=33
rra zp=67 zpx=77 abs=6f abx=7f aby=7b izx=63 izy=73
sax zp=87 zpy=97 abs=8f izx=83
sbx imm=cb
sha aby=9f izy=93
shs aby=9b
shx aby=9e
shy abx=9c
slo zp=07 zpx=17 abs=0f abx=1f aby=1b izx=03 izy=13
sre zp=47 zpx=57 abs=4f abx=5f aby=5b izx=43 izy=53
`;

  const OPS = Object.create(null);
  for (const row of OPTABLE.trim().split('\n')) {
    const part = row.trim().split(/\s+/);
    const modes = Object.create(null);
    for (let i = 1; i < part.length; i++) {
      const eq = part[i].indexOf('=');
      modes[part[i].slice(0, eq)] = parseInt(part[i].slice(eq + 1), 16);
    }
    OPS[part[0]] = modes;
  }

  const SIZE = { imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, izx: 2, izy: 2,
                 rel: 2, abs: 3, abx: 3, aby: 3, ind: 3 };

  /* diretivas que consomem o rótulo como nome do símbolo, não como endereço */
  const NAMED = new Set(['equ', '=', 'set', 'eqm', 'mac', 'macro']);
  /* diretivas depois das quais o rótulo vale (o PC muda na própria linha) */
  const AFTER = new Set(['org', 'align', 'rorg']);

  const isSymStart = c => c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c === '_' || c === '.';
  const isSymChar  = c => isSymStart(c) || c >= '0' && c <= '9';

  class AsmError extends Error {
    constructor(msg, soft) { super(msg); this.soft = !!soft; }
  }

  /* --- texto ---------------------------------------------------------------- */

  /* tira o comentário sem se enganar com ; dentro de "texto" ou de 'c */
  function stripComment(line) {
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === ';') return line.slice(0, i);
      if (c === '"') { i++; while (i < line.length && line[i] !== '"') i++; }
      else if (c === "'") { i++; if (line[i] === "'") i++; }   // 'c ou 'c'
    }
    return line;
  }

  /* quebra "a, b+1, (c,x)" em pedaços, respeitando parênteses e aspas */
  function splitArgs(text) {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === '"') { i++; while (i < text.length && text[i] !== '"') i++; }
      else if (c === "'") { i++; if (text[i] === "'") i++; }
      else if (c === ',' && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
    }
    out.push(text.slice(start));
    return out;
  }

  /* posição do ) que fecha o ( em `from`, ou -1 */
  function matchParen(text, from) {
    let depth = 0;
    for (let i = from; i < text.length; i++) {
      const c = text[i];
      if (c === '(') depth++;
      else if (c === ')') { if (--depth === 0) return i; }
      else if (c === '"') { i++; while (i < text.length && text[i] !== '"') i++; }
      else if (c === "'") { i++; if (text[i] === "'") i++; }
    }
    return -1;
  }

  /* o operando é imediato? o DASM procura o # em qualquer posição fora de aspas */
  function hasHash(text) {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '#') return true;
      if (c === '"') { i++; while (i < text.length && text[i] !== '"') i++; }
      else if (c === "'") { i++; if (text[i] === "'") i++; }
    }
    return false;
  }

  /* 'x' / 'y' se o texto termina em ",x" ou ",y" fora de parênteses */
  function trailingIndex(text) {
    const parts = splitArgs(text);
    if (parts.length < 2) return null;
    const last = parts[parts.length - 1].trim().toLowerCase();
    return (last === 'x' || last === 'y') ? last : null;
  }

  function dropIndex(text) {
    const parts = splitArgs(text);
    parts.pop();
    return parts.join(',');
  }

  /* nome de arquivo do include, normalizado para busca */
  function baseKey(name) {
    return String(name).replace(/^["']|["']$/g, '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  }

  function parseFile(name, text) {
    const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
    const out = new Array(lines.length);
    for (let i = 0; i < lines.length; i++) out[i] = { text: lines[i], file: name, num: i + 1 };
    return out;
  }

  /* a diretiva de uma linha, só para achar ENDM/REPEND ao capturar blocos */
  function directiveOf(item) {
    let t = stripComment(item.text);
    if (!t.trim()) return '';
    if (!/^\s/.test(t)) t = t.replace(/^[^\s:=]+:?/, '');
    const m = /^\s+(\S+)/.exec(t);
    return m ? m[1].toLowerCase().replace(/^\./, '') : '';
  }

  /* ======================================================================== */
  /*  um pass                                                                 */
  /* ======================================================================== */

  function runPass(cfg) {
    const prev  = cfg.prev;              // símbolos dos passes anteriores
    const cur   = new Map();             // definidos neste pass
    const eqm   = new Map();             // símbolos textuais (EQM)
    const macros = new Map();
    const segs  = new Map();
    const conds = [];
    const stack = [];
    const problems = [];
    const echoes  = [];
    const listing = cfg.listing ? [] : null;

    const mem  = new Uint8Array(0x10000);
    const used = new Uint8Array(0x10000);
    let minA = -1, maxA = -1;
    let filler = FILLER;
    let scope = 0, nextScope = 1;
    let hard = 0, stop = false;
    let item = null;                     // linha em processamento (para erros)
    let lineBytes = null;                // bytes que a linha atual gerou, no listing
    let shown = '';                      // o texto dela já com os {1} do macro trocados

    let seg = getSeg('INITIAL CODE SEGMENT', false);

    /* --- diagnóstico ------------------------------------------------------ */
    function say(kind, msg, soft) {
      problems.push({
        file: item ? item.file : cfg.name,
        line: item ? item.num : 0,
        kind, message: msg,
      });
      if (kind === 'error' && !soft) hard++;
    }
    const warn = msg => say('warning', msg, true);

    /* --- símbolos --------------------------------------------------------- */
    const keyOf = nm => (nm.charCodeAt(0) === 46 ? scope + ' ' + nm : nm);

    function define(nm, value, kind) {
      const key = keyOf(nm);
      const had = cur.get(key);
      if (had && kind !== 'set' && had.kind !== 'set' && had.value !== value) {
        throw new AsmError('symbol already defined: ' + nm);
      }
      cur.set(key, { name: nm, key, value: value | 0, kind, local: nm[0] === '.' });
    }

    function lookup(nm) {
      const key = keyOf(nm);
      const c = cur.get(key);
      if (c) return { value: c.value, undef: false };
      if (prev.has(key)) return { value: prev.get(key), undef: false };
      return { value: 0, undef: true };
    }

    const defined = nm => cur.has(keyOf(nm)) || prev.has(keyOf(nm));

    /* --- segmentos e PC --------------------------------------------------- */
    function getSeg(name, uninit) {
      let s = segs.get(name);
      if (!s) {
        s = { name, pc: 0, rpc: null, uninit: !!uninit, started: false };
        segs.set(name, s);
      }
      return s;
    }

    const pc = () => (seg.rpc === null ? seg.pc : seg.rpc) & 0xffff;

    function step(n) {
      seg.pc = (seg.pc + n) & 0xffff;
      if (seg.rpc !== null) seg.rpc = (seg.rpc + n) & 0xffff;
    }

    function emit(byte) {
      if (lineBytes) lineBytes.push(byte & 0xff);
      if (!seg.uninit) {
        const a = seg.pc & 0xffff;
        mem[a] = byte & 0xff;
        used[a] = 1;
        if (minA < 0 || a < minA) minA = a;
        if (a > maxA) maxA = a;
        seg.started = true;
      }
      step(1);
    }

    /* --- expressões ------------------------------------------------------- */
    function evaluate(text, depth) {
      text = String(text == null ? '' : text);
      let i = 0, undef = false;

      const ws = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++; };
      const at = s => text.startsWith(s, i);

      function or()   { let a = and();  for (;;) { ws(); if (at('||')) { i += 2; const b = and();  a = (a || b) ? 1 : 0; } else return a; } }
      function and()  { let a = bor();  for (;;) { ws(); if (at('&&')) { i += 2; const b = bor();  a = (a && b) ? 1 : 0; } else return a; } }
      function bor()  { let a = bxor(); for (;;) { ws(); if (text[i] === '|' && text[i + 1] !== '|') { i++; a = a | bxor(); } else return a; } }
      function bxor() { let a = band(); for (;;) { ws(); if (text[i] === '^') { i++; a = a ^ band(); } else return a; } }
      function band() { let a = eq();   for (;;) { ws(); if (text[i] === '&' && text[i + 1] !== '&') { i++; a = a & eq(); } else return a; } }

      function eq() {
        let a = cmp();
        for (;;) {
          ws();
          if (at('==')) { i += 2; a = (a === cmp()) ? 1 : 0; }
          else if (at('!=')) { i += 2; a = (a !== cmp()) ? 1 : 0; }
          else if (text[i] === '=' && text[i + 1] !== '=') { i++; a = (a === cmp()) ? 1 : 0; }
          else return a;
        }
      }

      function cmp() {
        let a = shift();
        for (;;) {
          ws();
          if (at('<=')) { i += 2; a = (a <= shift()) ? 1 : 0; }
          else if (at('>=')) { i += 2; a = (a >= shift()) ? 1 : 0; }
          else if (text[i] === '<' && text[i + 1] !== '<') { i++; a = (a < shift()) ? 1 : 0; }
          else if (text[i] === '>' && text[i + 1] !== '>') { i++; a = (a > shift()) ? 1 : 0; }
          else return a;
        }
      }

      function shift() {
        let a = add();
        for (;;) {
          ws();
          if (at('<<')) { i += 2; a = a << add(); }
          else if (at('>>')) { i += 2; a = a >> add(); }
          else return a;
        }
      }

      function add() {
        let a = mul();
        for (;;) {
          ws();
          if (text[i] === '+') { i++; a = (a + mul()) | 0; }
          else if (text[i] === '-') { i++; a = (a - mul()) | 0; }
          else return a;
        }
      }

      function mul() {
        let a = unary();
        for (;;) {
          ws();
          if (text[i] === '*') { i++; a = Math.imul(a, unary()); }
          else if (text[i] === '/') { i++; const b = unary(); a = b === 0 ? 0 : (a / b) | 0; }
          else if (text[i] === '%') { i++; const b = unary(); a = b === 0 ? 0 : (a % b) | 0; }
          else return a;
        }
      }

      function unary() {
        ws();
        const c = text[i];
        if (c === '-') { i++; return (-unary()) | 0; }
        if (c === '+') { i++; return unary(); }
        if (c === '~') { i++; return ~unary(); }
        if (c === '!') { i++; return unary() ? 0 : 1; }
        if (c === '#') { i++; return unary(); }                 // o DASM ignora o # na expressão
        if (c === '<') { i++; return unary() & 0xff; }          // byte baixo
        if (c === '>') { i++; return (unary() >> 8) & 0xff; }   // byte alto
        return primary();
      }

      function primary() {
        ws();
        const c = text[i];
        if (c === undefined) throw new AsmError('expressão incompleta');
        if (c === '(' || c === '[') {
          const close = c === '(' ? ')' : ']';
          i++;
          const v = or();
          ws();
          if (text[i] !== close) throw new AsmError('faltou ' + close);
          i++;
          return v;
        }
        if (c === '$') {
          i++; const s = i;
          while (i < text.length && /[0-9a-fA-F]/.test(text[i])) i++;
          if (i === s) throw new AsmError('$ sem dígitos hexadecimais');
          return parseInt(text.slice(s, i), 16) | 0;
        }
        if (c === '%') {
          i++; const s = i;
          while (i < text.length && (text[i] === '0' || text[i] === '1')) i++;
          if (i === s) throw new AsmError('% sem dígitos binários');
          return parseInt(text.slice(s, i), 2) | 0;
        }
        if (c === "'") {
          i++;
          const ch = text.charCodeAt(i);
          if (isNaN(ch)) throw new AsmError("' sem caractere");
          i++;
          if (text[i] === "'") i++;
          return ch | 0;
        }
        if (c === '"') {
          i++; let v = 0, n = 0;
          while (i < text.length && text[i] !== '"') { v = (v << 8) | text.charCodeAt(i); i++; n++; }
          i++;
          if (!n) throw new AsmError('texto vazio na expressão');
          return v | 0;
        }
        if (c >= '0' && c <= '9') {
          const s = i;
          while (i < text.length && text[i] >= '0' && text[i] <= '9') i++;
          return parseInt(text.slice(s, i), 10) | 0;
        }
        if (c === '.' && !isSymChar(text[i + 1] || '')) { i++; return pc(); }
        if (c === '*') { i++; return pc(); }                    // * no início de termo é o PC
        if (isSymStart(c)) {
          const s = i;
          i++;
          while (i < text.length && isSymChar(text[i])) i++;
          const name = text.slice(s, i);
          if (eqm.has(keyOf(name))) {
            if ((depth || 0) > MAX_INCLUDE) throw new AsmError('EQM recursivo: ' + name);
            const r = evaluate(eqm.get(keyOf(name)), (depth || 0) + 1);
            if (r.undef) undef = true;
            return r.value;
          }
          const r = lookup(name);
          if (r.undef) undef = true;
          return r.value;
        }
        throw new AsmError('não entendi a expressão a partir de "' + text.slice(i) + '"');
      }

      const value = or();
      ws();
      if (i < text.length) throw new AsmError('sobrou "' + text.slice(i) + '" na expressão');
      return { value: value | 0, undef };
    }

    /* atalho: avalia e já reclama de símbolo indefinido no pass final */
    function ev(text, what) {
      const r = evaluate(text, 0);
      if (r.undef && cfg.final) say('error', 'symbol not resolved: ' + String(text).trim() + (what ? ' (' + what + ')' : ''), true);
      return r;
    }

    /* --- pilha de execução ------------------------------------------------- */
    function push(frame) {
      if (stack.length >= MAX_INCLUDE * 4) throw new AsmError('aninhamento demais (include/macro/repeat)');
      frame.i = frame.i || 0;
      frame.condDepth = conds.length;
      stack.push(frame);
    }

    function popFrame() {
      const f = stack.pop();
      if (f.kind === 'repeat' && ++f.done < f.count) { f.i = 0; stack.push(f); return; }
      if (f.scopeSave !== undefined) scope = f.scopeSave;
      if (f.condDepth !== undefined && conds.length > f.condDepth) conds.length = f.condDepth;
    }

    function unwindTo(kind) {
      while (stack.length) {
        const f = stack[stack.length - 1];
        if (f.kind === kind) { f.i = f.lines.length; if (f.kind === 'repeat') f.done = f.count; popFrame(); return true; }
        f.i = f.lines.length;
        if (f.kind === 'repeat') f.done = f.count;
        popFrame();
      }
      return false;
    }

    const active = () => conds.length === 0 || conds[conds.length - 1].on;

    /* --- captura de blocos (MAC…ENDM, REPEAT…REPEND) ----------------------- */
    function grab(frame, openers, closer) {
      const body = [];
      let depth = 1;
      while (frame.i < frame.lines.length) {
        const ln = frame.lines[frame.i++];
        const d = directiveOf(ln);
        if (openers.has(d)) depth++;
        else if (d === closer && --depth === 0) return body;
        body.push(ln);
      }
      throw new AsmError('bloco sem ' + closer.toUpperCase());
    }

    const MACOPEN = new Set(['mac', 'macro']);
    const REPOPEN = new Set(['repeat']);

    /* --- dados -------------------------------------------------------------- */
    function emitData(operand, unit) {
      // ".byte" sem operando reserva um item zerado (é assim que os fontes
      // declaram variáveis dentro de um SEG.U)
      if (!operand.trim()) { for (let b = 0; b < unit; b++) emit(0); return; }
      for (const raw of splitArgs(operand)) {
        const arg = raw.trim();
        if (!arg) continue;
        if (arg[0] === '"' && arg[arg.length - 1] === '"' && arg.length >= 2) {
          const s = arg.slice(1, -1);
          for (let k = 0; k < s.length; k++) {
            const ch = s.charCodeAt(k);
            emit(ch);
            for (let b = 1; b < unit; b++) emit(0);
          }
          continue;
        }
        const r = ev(arg);
        for (let b = 0; b < unit; b++) emit((r.value >> (8 * b)) & 0xff);
      }
    }

    function doDs(operand, unit) {
      const parts = splitArgs(operand);
      const count = ev(parts[0]).value;
      const fill = parts.length > 1 ? ev(parts[1]).value : 0;
      if (count < 0) throw new AsmError('DS com contagem negativa');
      if (seg.uninit) { step(count * unit); return; }
      for (let n = 0; n < count; n++) for (let b = 0; b < unit; b++) emit((fill >> (8 * b)) & 0xff);
    }

    function doOrg(operand) {
      const parts = splitArgs(operand);
      const target = ev(parts[0]).value & 0xffff;
      if (parts.length > 1) filler = ev(parts[1]).value & 0xff;
      if (!seg.uninit && seg.started && target > seg.pc) {
        while (seg.pc < target) emit(filler);
      } else {
        if (seg.rpc !== null) seg.rpc = (seg.rpc + (target - seg.pc)) & 0xffff;
        seg.pc = target & 0xffff;
      }
    }

    function doAlign(operand) {
      const parts = splitArgs(operand);
      const n = ev(parts[0]).value;
      const fill = parts.length > 1 ? ev(parts[1]).value & 0xff : 0;
      if (n <= 1) return;
      if (seg.uninit) { while (seg.pc % n) step(1); return; }
      while (seg.pc % n) emit(fill);
    }

    /* --- instruções --------------------------------------------------------- */
    function classify(operand) {
      const op = operand.trim();
      if (!op) return { k: 'empty' };
      if (hasHash(op)) return { k: 'imm', e: op };     // ldx (#N-1) também é imediato
      if (op[0] === '(') {
        const close = matchParen(op, 0);
        if (close > 0) {
          const inner = op.slice(1, close);
          const tail = op.slice(close + 1).replace(/\s+/g, '').toLowerCase();
          if (tail === '') {
            if (trailingIndex(inner) === 'x') return { k: 'izx', e: dropIndex(inner) };
            return { k: 'ind', e: inner };
          }
          if (tail === ',y') return { k: 'izy', e: inner };
          if (tail === ',x') return { k: 'izx', e: inner };
        }
      }
      const idx = trailingIndex(op);
      if (idx === 'x') return { k: 'idxX', e: dropIndex(op) };
      if (idx === 'y') return { k: 'idxY', e: dropIndex(op) };
      return { k: 'plain', e: op };
    }

    function doInstruction(word, operand) {
      let mne = word.toLowerCase(), force = 0;      // 0 automático, 1 zp, 2 abs
      const dot = mne.indexOf('.');
      if (dot > 0) {
        const suffix = mne.slice(dot + 1);
        mne = mne.slice(0, dot);
        const s = suffix[0];                       // o DASM só olha a 1a letra: LDA.wy
        if (s === 'b' || s === 'z') force = 1;
        else if (s === 'w' || s === 'a' || s === 'u') force = 2;
        else throw new AsmError('sufixo de tamanho desconhecido: .' + suffix);
      }
      const ops = OPS[mne];
      if (!ops) return false;

      const pick = (z, a, r) => {
        if (ops[z] === undefined) return a;
        if (ops[a] === undefined) return z;
        if (force === 1) return z;
        if (force === 2) return a;
        return (!r.undef && r.value >= 0 && r.value <= 0xff) ? z : a;
      };

      const c = classify(operand);
      let mode = null, r = { value: 0, undef: false };
      switch (c.k) {
        case 'empty': mode = ops.imp !== undefined ? 'imp' : (ops.acc !== undefined ? 'acc' : null); break;
        case 'imm':   mode = 'imm'; r = ev(c.e); break;
        case 'ind':   mode = 'ind'; r = ev(c.e); break;
        case 'izx':   mode = 'izx'; r = ev(c.e); break;
        case 'izy':   mode = 'izy'; r = ev(c.e); break;
        case 'idxX':  r = ev(c.e); mode = pick('zpx', 'abx', r); break;
        case 'idxY':  r = ev(c.e); mode = pick('zpy', 'aby', r); break;
        case 'plain':
          if (ops.rel !== undefined) { mode = 'rel'; r = ev(c.e); }
          else { r = ev(c.e); mode = pick('zp', 'abs', r); }
          break;
      }
      if (mode === null || ops[mode] === undefined) {
        throw new AsmError('illegal addressing mode: ' + mne + ' ' + operand);
      }

      emit(ops[mode]);
      if (mode === 'rel') {
        const delta = (r.value | 0) - ((pc() + 1) & 0xffff);
        if (cfg.final && !r.undef && (delta > 127 || delta < -128)) {
          say('error', 'branch out of range (' + delta + ' bytes)', true);
        }
        emit(delta & 0xff);
      } else if (SIZE[mode] === 2) {
        if (mode === 'imm' && cfg.final && !r.undef && (r.value > 255 || r.value < -255)) {
          say('error', "Value in '" + mne + ' ' + operand + "' must be <$100", true);
        }
        emit(r.value & 0xff);
      } else if (SIZE[mode] === 3) {
        emit(r.value & 0xff);
        emit((r.value >> 8) & 0xff);
      }
      return true;
    }

    /* --- uma linha ---------------------------------------------------------- */
    function processLine(frame) {
      let text = stripComment(item.text);
      if (frame.args) {
        const subst = s => s.replace(/\{(\d+)\}/g, (m, d) => {
          const n = +d;
          if (n === 0) return String(frame.args.length);
          return frame.args[n - 1] !== undefined ? frame.args[n - 1] : '';
        });
        text = subst(text);
        shown = subst(item.text);      // no listing, a linha do macro sai expandida
      }
      if (!text.trim()) return;

      let label = '', rest;
      if (/^\s/.test(text)) {
        rest = text.trim();
      } else {
        const m = /^([^\s:=]+):?\s*/.exec(text);
        label = m[1];
        rest = text.slice(m[0].length).trim();
      }

      let word = '', operand = '';
      if (rest) {
        if (rest[0] === '=') { word = '='; operand = rest.slice(1).trim(); }
        else {
          const m = /^(\S+)\s*([\s\S]*)$/.exec(rest);
          word = m[1];
          operand = m[2].trim();
        }
      }
      const dir = word.toLowerCase().replace(/^\./, '');

      /* condicionais: sempre processadas, para o aninhamento não se perder */
      if (dir === 'if' || dir === 'ifconst' || dir === 'ifnconst') {
        const parentOn = active();
        let on = false;
        if (parentOn) {
          if (dir === 'if') on = ev(operand, 'IF').value !== 0;
          else {
            const nm = operand.trim().replace(/^["']|["']$/g, '');
            on = defined(nm);
            if (dir === 'ifnconst') on = !on;
          }
        }
        conds.push({ parentOn, on, taken: on });
        return;
      }
      if (dir === 'else') {
        const c = conds[conds.length - 1];
        if (!c) throw new AsmError('ELSE sem IF');
        c.on = c.parentOn && !c.taken;
        c.taken = c.taken || c.on;
        return;
      }
      if (dir === 'endif' || dir === 'eif') {
        if (!conds.length) throw new AsmError('ENDIF sem IF');
        conds.pop();
        return;
      }
      if (!active()) return;

      /* blocos */
      if (MACOPEN.has(dir)) {
        const name = (operand || label).trim().toLowerCase();
        if (!name) throw new AsmError('MAC sem nome');
        macros.set(name, grab(frame, MACOPEN, 'endm'));
        return;
      }
      if (dir === 'endm') return;                       // ENDM solto: ignora
      if (dir === 'mexit') { unwindTo('macro'); return; }
      if (dir === 'repeat') {
        const n = ev(operand, 'REPEAT').value;
        const body = grab(frame, REPOPEN, 'repend');
        if (n > 0) push({ kind: 'repeat', lines: body, done: 0, count: n, args: frame.args });
        return;
      }
      if (dir === 'repend') return;

      /* símbolos nomeados */
      if (NAMED.has(dir)) {
        if (!label) throw new AsmError(word.toUpperCase() + ' sem rótulo');
        if (dir === 'eqm') {
          eqm.set(keyOf(label), operand);
          // o DASM ainda lista o nome na tabela de símbolos, valendo zero — o
          // texto é expandido na hora do uso, não aqui
          define(label, 0, 'set');
          return;
        }
        const r = ev(operand, label);
        define(label, r.value, dir === 'set' ? 'set' : 'equ');
        return;
      }

      if (label && !AFTER.has(dir)) define(label, pc(), 'label');

      switch (dir) {
        case '':          break;                        // linha só com rótulo
        case 'processor': break;
        case 'incdir':    break;
        case 'list':      break;
        case 'trace':     break;
        case 'subroutine': scope = nextScope++; break;

        case 'seg':
        case 'seg.u': {
          const name = operand.trim() || 'INITIAL CODE SEGMENT';
          seg = getSeg(name, dir === 'seg.u');
          if (dir === 'seg.u') seg.uninit = true;
          break;
        }

        case 'org':   doOrg(operand); break;
        case 'rorg':  seg.rpc = ev(operand, 'RORG').value & 0xffff; break;
        case 'rend':  seg.rpc = null; break;
        case 'align': doAlign(operand); break;

        case 'dc': case 'dc.b': case 'byte': emitData(operand, 1); break;
        case 'dc.w': case 'word':            emitData(operand, 2); break;
        case 'dc.l': case 'long':            emitData(operand, 4); break;
        case 'ds': case 'ds.b': doDs(operand, 1); break;
        case 'ds.w':            doDs(operand, 2); break;
        case 'ds.l':            doDs(operand, 4); break;

        case 'hex':
          for (const tok of operand.split(/[\s,]+/)) {
            if (!tok) continue;
            if (!/^[0-9a-fA-F]+$/.test(tok) || tok.length % 2) throw new AsmError('HEX inválido: ' + tok);
            for (let k = 0; k < tok.length; k += 2) emit(parseInt(tok.substr(k, 2), 16));
          }
          break;

        case 'incbin': {
          const key = baseKey(operand);
          const data = cfg.binaries[key];
          if (!data) throw new AsmError('INCBIN: não achei ' + operand.trim());
          for (let k = 0; k < data.length; k++) emit(data[k]);
          break;
        }

        case 'include': {
          const key = baseKey(operand);
          const text2 = cfg.includes[key];
          if (text2 === undefined) {
            const have = Object.keys(cfg.includes).join(', ') || 'nenhum';
            throw new AsmError('include: não achei "' + key + '" (tenho: ' + have + ')');
          }
          push({ kind: 'file', lines: parseFile(key, text2) });
          break;
        }

        case 'echo':
          echoes.push(splitArgs(operand).map(a => {
            const t = a.trim();
            if (t[0] === '"' && t[t.length - 1] === '"') return t.slice(1, -1);
            const r = evaluate(t, 0);
            return r.undef ? t : String(r.value);
          }).join(' '));
          break;

        case 'err':
          say('error', 'ERR pseudo-op encountered, aborting assembly');
          stop = true;
          break;

        case 'end':
          stop = true;
          break;

        default: {
          const body = macros.get(dir) || macros.get(word.toLowerCase());
          if (body) {
            const args = operand ? splitArgs(operand).map(a => a.trim()) : [];
            push({ kind: 'macro', lines: body, args, scopeSave: scope });
            scope = nextScope++;
            break;
          }
          if (!doInstruction(word, operand)) throw new AsmError('unknown mnemonic: ' + word);
        }
      }

      if (label && AFTER.has(dir)) define(label, pc(), 'label');
    }

    /* --- roda ---------------------------------------------------------------- */
    for (const name of Object.keys(cfg.defines)) {
      try {
        const r = evaluate(String(cfg.defines[name]), 0);
        cur.set(name, { name, value: r.value, kind: 'equ', local: false });
      } catch (err) {
        say('error', '-D ' + name + ': ' + err.message);
      }
    }

    push({ kind: 'file', lines: parseFile(cfg.name, cfg.source) });
    while (stack.length && !stop) {
      const f = stack[stack.length - 1];
      if (f.i >= f.lines.length) { popFrame(); continue; }
      item = f.lines[f.i++];
      let addr0 = 0, uninit0 = false;
      if (listing) { lineBytes = []; shown = item.text; addr0 = pc(); uninit0 = seg.uninit; }
      try {
        processLine(f);
      } catch (err) {
        if (!(err instanceof AsmError)) throw err;
        say('error', err.message, err.soft);
        if (hard > 40) break;
      }
      if (listing) {
        // linha que gerou bytes mostra onde eles começam; linha que só mexeu no
        // PC (ORG, ALIGN) mostra onde ele parou, como no listing do DASM
        listing.push({ file: item.file, num: item.num, uninit: uninit0,
                       addr: lineBytes.length ? addr0 : pc(),
                       bytes: lineBytes, text: shown });
        lineBytes = null;
      }
    }
    item = null;
    if (conds.length) say('error', 'IF sem ENDIF (' + conds.length + ' aberto(s))');

    /* --- resultado ----------------------------------------------------------- */
    let rom = new Uint8Array(0);
    if (minA >= 0) {
      rom = new Uint8Array(maxA - minA + 1);
      for (let a = minA; a <= maxA; a++) rom[a - minA] = used[a] ? mem[a] : filler;
    }

    const table = new Map(prev);
    for (const [k, s] of cur) table.set(k, s.value);

    return { rom, origin: minA < 0 ? 0 : minA, table, cur, problems, echoes, listing, hard };
  }

  /* ======================================================================== */
  /*  API                                                                     */
  /* ======================================================================== */

  function signature(st) {
    const keys = [...st.table.keys()].sort();
    let h = 0x811c9dc5;
    const mix = n => { h = Math.imul(h ^ (n & 0xff), 0x01000193); h = Math.imul(h ^ ((n >> 8) & 0xff), 0x01000193); };
    for (const k of keys) { for (let i = 0; i < k.length; i++) mix(k.charCodeAt(i)); mix(st.table.get(k)); mix(st.table.get(k) >> 16); }
    mix(st.rom.length); mix(st.rom.length >> 16); mix(st.origin);
    for (let i = 0; i < st.rom.length; i++) mix(st.rom[i]);
    return h >>> 0;
  }

  function assemble(opts) {
    opts = opts || {};
    const name = opts.name || 'source.asm';
    const source = opts.source == null ? '' : String(opts.source);

    const includes = Object.create(null);
    for (const k of Object.keys(BUILTIN)) includes[k] = BUILTIN[k];
    const extra = opts.includes || {};
    for (const k of Object.keys(extra)) includes[baseKey(k)] = String(extra[k]);

    const binaries = Object.create(null);
    const bins = opts.binaries || {};
    for (const k of Object.keys(bins)) binaries[baseKey(k)] = bins[k];

    const defines = Object.create(null);
    const given = opts.defines || {};
    for (const k of Object.keys(given)) defines[k] = given[k] === true ? 1 : given[k];

    const base = { name, source, includes, binaries, defines, listing: false, final: false };
    let prev = new Map(), sig = null, st = null, passes = 0;

    try {
      for (let p = 1; p <= MAX_PASSES; p++) {
        st = runPass(Object.assign({}, base, { prev, final: false }));
        passes = p;
        prev = st.table;
        if (st.hard) break;
        const s = signature(st);
        if (p >= 2 && s === sig) break;
        sig = s;
      }
      if (!st.hard) {
        st = runPass(Object.assign({}, base, { prev, final: true, listing: !!opts.listing }));
        passes++;
      }
    } catch (err) {
      return {
        ok: false, rom: new Uint8Array(0), size: 0, origin: 0, passes,
        problems: [{ file: name, line: 0, kind: 'error', message: 'falha interna do montador: ' + err.message }],
        log: 'falha interna do montador: ' + err.message,
        symbols: [], echoes: [],
      };
    }

    const problems = st.problems;
    const errors = problems.filter(p => p.kind === 'error');
    const ok = errors.length === 0 && st.rom.length > 0;

    const lines = [];
    for (const e of st.echoes) lines.push(e);
    for (const p of problems) lines.push(p.file + ' (' + p.line + '): ' + p.kind + ': ' + p.message + '.');
    if (errors.length) lines.push('', 'Unrecoverable error(s) in pass, aborting assembly!');
    else if (!st.rom.length) lines.push('nenhum byte gerado — o fonte tem ORG e código?');
    else lines.push('Complete. (' + passes + ' passes, ' + st.rom.length + ' bytes)');

    // tabela acumulada dos passes: um IFNCONST só define o símbolo no primeiro,
    // e ele continua valendo depois. Rótulo local sai qualificado pelo escopo,
    // como no .sym do DASM: 3.loop
    const symbols = [];
    for (const [key, value] of st.table) {
      const m = /^(\d+) (\..+)$/.exec(key);
      symbols.push({ name: m ? m[1] + m[2] : key, value, local: !!m });
    }
    symbols.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    return {
      ok,
      rom: st.rom,
      size: st.rom.length,
      origin: st.origin,
      passes,
      problems,
      symbols,
      echoes: st.echoes,
      listing: st.listing,
      log: lines.join('\n'),
    };
  }

  /* --- os dois arquivos que o DASM deixa ao lado da ROM --------------------- */

  const hex = (v, n) => (v >>> 0).toString(16).padStart(n, '0');

  /* o listing: linha, endereço, bytes gerados e o fonte. Endereço com U na
     frente é de segmento não inicializado, e * diz que a linha gerou mais bytes
     do que cabe na coluna — mesma convenção do -l do DASM. */
  function listingText(res) {
    if (!res.listing) return '';
    const out = [];
    let file = null;
    for (const l of res.listing) {
      if (l.file !== file) {
        file = l.file;
        out.push('------- FILE ' + file);
      }
      const bytes = l.bytes.slice(0, 4).map(b => hex(b, 2)).join(' ') + (l.bytes.length > 4 ? '*' : '');
      out.push(String(l.num).padStart(6) + '  ' + (l.uninit ? 'U' : ' ') + hex(l.addr, 4) +
               '  ' + bytes.padEnd(13) + l.text);
    }
    return out.join('\n') + '\n';
  }

  /* a tabela de símbolos, no formato do -s do DASM */
  function symbolText(res) {
    const out = ['--- Symbol List (sorted by symbol)'];
    for (const s of res.symbols) {
      out.push(s.name.padEnd(24) + ' ' + hex(s.value, 4) + '         (R )');
    }
    out.push('--- End of Symbol List.');
    return out.join('\n') + '\n';
  }

  /* vcs.h e macro.h embutidos, para a página compilar sem ler nada do disco */
  const BUILTIN = {
    'vcs.h': `; VCS.H
; Version 1.06, 06/SEP/2020

VERSION_VCS         = 106

; THIS IS *THE* "STANDARD" VCS.H
; THIS FILE IS EXPLICITLY SUPPORTED AS A DASM-PREFERRED COMPANION FILE
; The latest version can be found at https://dasm-assembler.github.io/
;
; This file defines hardware registers and memory mapping for the
; Atari 2600. It is distributed as a companion machine-specific support package
; for the DASM compiler. Updates to this file, DASM, and associated tools are
; available at at https://dasm-assembler.github.io/
;
; Many thanks to the people who have contributed. If you find an issue with the
; contents, or would like ot add something, please report as an issue at...
; https://github.com/dasm-assembler/dasm/issues

;
; Latest Revisions...
; 1.06  05/SEP/2020     Modified header/license and links to new versions
; 1.05  13/NOV/2003      - Correction to 1.04 - now functions as requested by MR.
;                        - Added VERSION_VCS equate (which will reflect 100x version #)
;                          This will allow conditional code to verify VCS.H being
;                          used for code assembly.
; 1.04  12/NOV/2003     Added TIA_BASE_WRITE_ADDRESS and TIA_BASE_READ_ADDRESS for
;                       convenient disassembly/reassembly compatibility for hardware
;                       mirrored reading/writing differences.  This is more a 
;                       readability issue, and binary compatibility with disassembled
;                       and reassembled sources.  Per Manuel Rotschkar's suggestion.
; 1.03  12/MAY/2003     Added SEG segment at end of file to fix old-code compatibility
;                       which was broken by the use of segments in this file, as
;                       reported by Manuel Polik on [stella] 11/MAY/2003
; 1.02  22/MAR/2003     Added TIMINT($285)
; 1.01	        		Constant offset added to allow use for 3F-style bankswitching
;						 - define TIA_BASE_ADDRESS as $40 for Tigervision carts, otherwise
;						   it is safe to leave it undefined, and the base address will
;						   be set to 0.  Thanks to Eckhard Stolberg for the suggestion.
;                          Note, may use -DLABEL=EXPRESSION to define TIA_BASE_ADDRESS
;                        - register definitions are now generated through assignment
;                          in uninitialised segments.  This allows a changeable base
;                          address architecture.
; 1.0	22/MAR/2003		Initial release


;-------------------------------------------------------------------------------

; TIA_BASE_ADDRESS
; The TIA_BASE_ADDRESS defines the base address of access to TIA registers.
; Normally 0, the base address should (externally, before including this file)
; be set to $40 when creating 3F-bankswitched (and other?) cartridges.
; The reason is that this bankswitching scheme treats any access to locations
; < $40 as a bankswitch.

			IFNCONST TIA_BASE_ADDRESS
TIA_BASE_ADDRESS	= 0
			ENDIF

; Note: The address may be defined on the command-line using the -D switch, eg:
; dasm.exe code.asm -DTIA_BASE_ADDRESS=$40 -f3 -v5 -ocode.bin
; *OR* by declaring the label before including this file, eg:
; TIA_BASE_ADDRESS = $40
;   include "vcs.h"

; Alternate read/write address capability - allows for some disassembly compatibility
; usage ; to allow reassembly to binary perfect copies).  This is essentially catering
; for the mirrored ROM hardware registers.

; Usage: As per above, define the TIA_BASE_READ_ADDRESS and/or TIA_BASE_WRITE_ADDRESS
; using the -D command-line switch, as required.  If the addresses are not defined, 
; they defaut to the TIA_BASE_ADDRESS.

     IFNCONST TIA_BASE_READ_ADDRESS
TIA_BASE_READ_ADDRESS = TIA_BASE_ADDRESS
     ENDIF

     IFNCONST TIA_BASE_WRITE_ADDRESS
TIA_BASE_WRITE_ADDRESS = TIA_BASE_ADDRESS
     ENDIF

;-------------------------------------------------------------------------------

			SEG.U TIA_REGISTERS_WRITE
			ORG TIA_BASE_WRITE_ADDRESS

	; DO NOT CHANGE THE RELATIVE ORDERING OF REGISTERS!
    
VSYNC       ds 1    ; $00   0000 00x0   Vertical Sync Set-Clear
VBLANK		ds 1	; $01   xx00 00x0   Vertical Blank Set-Clear
WSYNC		ds 1	; $02   ---- ----   Wait for Horizontal Blank
RSYNC		ds 1	; $03   ---- ----   Reset Horizontal Sync Counter
NUSIZ0		ds 1	; $04   00xx 0xxx   Number-Size player/missle 0
NUSIZ1		ds 1	; $05   00xx 0xxx   Number-Size player/missle 1
COLUP0		ds 1	; $06   xxxx xxx0   Color-Luminance Player 0
COLUP1      ds 1    ; $07   xxxx xxx0   Color-Luminance Player 1
COLUPF      ds 1    ; $08   xxxx xxx0   Color-Luminance Playfield
COLUBK      ds 1    ; $09   xxxx xxx0   Color-Luminance Background
CTRLPF      ds 1    ; $0A   00xx 0xxx   Control Playfield, Ball, Collisions
REFP0       ds 1    ; $0B   0000 x000   Reflection Player 0
REFP1       ds 1    ; $0C   0000 x000   Reflection Player 1
PF0         ds 1    ; $0D   xxxx 0000   Playfield Register Byte 0
PF1         ds 1    ; $0E   xxxx xxxx   Playfield Register Byte 1
PF2         ds 1    ; $0F   xxxx xxxx   Playfield Register Byte 2
RESP0       ds 1    ; $10   ---- ----   Reset Player 0
RESP1       ds 1    ; $11   ---- ----   Reset Player 1
RESM0       ds 1    ; $12   ---- ----   Reset Missle 0
RESM1       ds 1    ; $13   ---- ----   Reset Missle 1
RESBL       ds 1    ; $14   ---- ----   Reset Ball
AUDC0       ds 1    ; $15   0000 xxxx   Audio Control 0
AUDC1       ds 1    ; $16   0000 xxxx   Audio Control 1
AUDF0       ds 1    ; $17   000x xxxx   Audio Frequency 0
AUDF1       ds 1    ; $18   000x xxxx   Audio Frequency 1
AUDV0       ds 1    ; $19   0000 xxxx   Audio Volume 0
AUDV1       ds 1    ; $1A   0000 xxxx   Audio Volume 1
GRP0        ds 1    ; $1B   xxxx xxxx   Graphics Register Player 0
GRP1        ds 1    ; $1C   xxxx xxxx   Graphics Register Player 1
ENAM0       ds 1    ; $1D   0000 00x0   Graphics Enable Missle 0
ENAM1       ds 1    ; $1E   0000 00x0   Graphics Enable Missle 1
ENABL       ds 1    ; $1F   0000 00x0   Graphics Enable Ball
HMP0        ds 1    ; $20   xxxx 0000   Horizontal Motion Player 0
HMP1        ds 1    ; $21   xxxx 0000   Horizontal Motion Player 1
HMM0        ds 1    ; $22   xxxx 0000   Horizontal Motion Missle 0
HMM1        ds 1    ; $23   xxxx 0000   Horizontal Motion Missle 1
HMBL        ds 1    ; $24   xxxx 0000   Horizontal Motion Ball
VDELP0      ds 1    ; $25   0000 000x   Vertical Delay Player 0
VDELP1      ds 1    ; $26   0000 000x   Vertical Delay Player 1
VDELBL      ds 1    ; $27   0000 000x   Vertical Delay Ball
RESMP0      ds 1    ; $28   0000 00x0   Reset Missle 0 to Player 0
RESMP1      ds 1    ; $29   0000 00x0   Reset Missle 1 to Player 1
HMOVE       ds 1    ; $2A   ---- ----   Apply Horizontal Motion
HMCLR       ds 1    ; $2B   ---- ----   Clear Horizontal Move Registers
CXCLR       ds 1    ; $2C   ---- ----   Clear Collision Latches
 
;-------------------------------------------------------------------------------

			SEG.U TIA_REGISTERS_READ
			ORG TIA_BASE_READ_ADDRESS

                    ;											bit 7   bit 6
CXM0P       ds 1    ; $00       xx00 0000       Read Collision  M0-P1   M0-P0
CXM1P       ds 1    ; $01       xx00 0000                       M1-P0   M1-P1
CXP0FB      ds 1    ; $02       xx00 0000                       P0-PF   P0-BL
CXP1FB      ds 1    ; $03       xx00 0000                       P1-PF   P1-BL
CXM0FB      ds 1    ; $04       xx00 0000                       M0-PF   M0-BL
CXM1FB      ds 1    ; $05       xx00 0000                       M1-PF   M1-BL
CXBLPF      ds 1    ; $06       x000 0000                       BL-PF   -----
CXPPMM      ds 1    ; $07       xx00 0000                       P0-P1   M0-M1
INPT0       ds 1    ; $08       x000 0000       Read Pot Port 0
INPT1       ds 1    ; $09       x000 0000       Read Pot Port 1
INPT2       ds 1    ; $0A       x000 0000       Read Pot Port 2
INPT3       ds 1    ; $0B       x000 0000       Read Pot Port 3
INPT4       ds 1    ; $0C		x000 0000       Read Input (Trigger) 0
INPT5       ds 1	; $0D		x000 0000       Read Input (Trigger) 1

;-------------------------------------------------------------------------------

			SEG.U RIOT
			ORG $280
 
	; RIOT MEMORY MAP

SWCHA       ds 1    ; $280      Port A data register for joysticks:
					;			Bits 4-7 for player 1.  Bits 0-3 for player 2.

SWACNT      ds 1    ; $281      Port A data direction register (DDR)
SWCHB       ds 1    ; $282		Port B data (console switches)
SWBCNT      ds 1    ; $283      Port B DDR
INTIM       ds 1    ; $284		Timer output

TIMINT  	ds 1	; $285

		; Unused/undefined registers ($285-$294)

			ds 1	; $286
			ds 1	; $287
			ds 1	; $288
			ds 1	; $289
			ds 1	; $28A
			ds 1	; $28B
			ds 1	; $28C
			ds 1	; $28D
			ds 1	; $28E
			ds 1	; $28F
			ds 1	; $290
			ds 1	; $291
			ds 1	; $292
			ds 1	; $293

TIM1T       ds 1    ; $294		set 1 clock interval
TIM8T       ds 1    ; $295      set 8 clock interval
TIM64T      ds 1    ; $296      set 64 clock interval
T1024T      ds 1    ; $297      set 1024 clock interval

;-------------------------------------------------------------------------------
; The following required for back-compatibility with code which does not use
; segments.

            SEG

; EOF
`,
    'macro.h': `; MACRO.H
; Version 1.09, 05/SEP/2020

VERSION_MACRO         = 109

;
; THIS FILE IS EXPLICITLY SUPPORTED AS A DASM-PREFERRED COMPANION FILE
; The latest version can be found at https://dasm-assembler.github.io/
;
; This file defines DASM macros useful for development for the Atari 2600.
; It is distributed as a companion machine-specific support package
; for the DASM compiler.
;
; Many thanks to the people who have contributed. If you find an issue with the
; contents, or would like ot add something, please report as an issue at...
; https://github.com/dasm-assembler/dasm/issues


; Latest Revisions...
; 1.09  05/SEP/2020     - updated license/links

; 1.08  13/JUL/2020     - added use of LXA to CLEAN_START
; 1.07  19/JAN/2020     - correction to comment VERTICAL_SYNC
; 1.06  03/SEP/2004     - nice revision of VERTICAL_SYNC (Edwin Blink)
; 1.05  14/NOV/2003     - Added VERSION_MACRO equate (which will reflect 100x version #)
;                         This will allow conditional code to verify MACRO.H being
;                         used for code assembly.
; 1.04  13/NOV/2003     - SET_POINTER macro added (16-bit address load)
;
; 1.03  23/JUN/2003     - CLEAN_START macro added - clears TIA, RAM, registers
;
; 1.02  14/JUN/2003     - VERTICAL_SYNC macro added
;                         (standardised macro for vertical synch code)
; 1.01  22/MAR/2003     - SLEEP macro added. 
;                       - NO_ILLEGAL_OPCODES switch implemented
; 1.0	22/MAR/2003		Initial release

; Note: These macros use illegal opcodes.  To disable illegal opcode usage, 
;   define the symbol NO_ILLEGAL_OPCODES (-DNO_ILLEGAL_OPCODES=1 on command-line).
;   If you do not allow illegal opcode usage, you must include this file 
;   *after* including VCS.H (as the non-illegal opcodes access hardware
;   registers and require them to be defined first).

; Available macros...
;   SLEEP n             - sleep for n cycles
;   VERTICAL_SYNC       - correct 3 scanline vertical synch code
;   CLEAN_START         - set machine to known state on startup
;   SET_POINTER         - load a 16-bit absolute to a 16-bit variable

;-------------------------------------------------------------------------------
; SLEEP duration
; Original author: Thomas Jentzsch
; Inserts code which takes the specified number of cycles to execute.  This is
; useful for code where precise timing is required.
; ILLEGAL-OPCODE VERSION DOES NOT AFFECT FLAGS OR REGISTERS.
; LEGAL OPCODE VERSION MAY AFFECT FLAGS
; Uses illegal opcode (DASM 2.20.01 onwards).

            MAC SLEEP            ;usage: SLEEP n (n>1)
.CYCLES     SET {1}

                IF .CYCLES < 2
                    ECHO "MACRO ERROR: 'SLEEP': Duration must be > 1"
                    ERR
                ENDIF

                IF .CYCLES & 1
                    IFNCONST NO_ILLEGAL_OPCODES
                        nop 0
                    ELSE
                        bit VSYNC
                    ENDIF
.CYCLES             SET .CYCLES - 3
                ENDIF
            
                REPEAT .CYCLES / 2
                    nop
                REPEND
            ENDM

;-------------------------------------------------------------------------------
; VERTICAL_SYNC
; revised version by Edwin Blink -- saves bytes!
; Inserts the code required for a proper 3 scanline vertical sync sequence
; Note: Alters the accumulator

; OUT: A = 0

             MAC VERTICAL_SYNC
                lda #%1110          ; each '1' bits generate a VSYNC ON line (bits 1..3)
.VSLP1          sta WSYNC           ; 1st '0' bit resets Vsync, 2nd '0' bit exit loop
                sta VSYNC
                lsr
                bne .VSLP1          ; branch until VYSNC has been reset
             ENDM

;-------------------------------------------------------------------------------
; CLEAN_START
; Original author: Andrew Davie
; Standardised start-up code, clears stack, all TIA registers and RAM to 0
; Sets stack pointer to $FF, and all registers to 0
; Sets decimal mode off, sets interrupt flag (kind of un-necessary)
; Use as very first section of code on boot (ie: at reset)
; Code written to minimise total ROM usage - uses weird 6502 knowledge :)

            MAC CLEAN_START
                sei
                cld
            
                IFNCONST NO_ILLEGAL_OPCODES
                    lxa #0
                ELSE
                    ldx #0
                    txa
                ENDIF
                tay
.CLEAR_STACK    dex
                txs
                pha
                bne .CLEAR_STACK     ; SP=$FF, X = A = Y = 0

            ENDM

;-------------------------------------------------------
; SET_POINTER
; Original author: Manuel Rotschkar
;
; Sets a 2 byte RAM pointer to an absolute address.
;
; Usage: SET_POINTER pointer, address
; Example: SET_POINTER SpritePTR, SpriteData
;
; Note: Alters the accumulator, NZ flags
; IN 1: 2 byte RAM location reserved for pointer
; IN 2: absolute address

            MAC SET_POINTER
.POINTER    SET {1}
.ADDRESS    SET {2}

                LDA #<.ADDRESS  ; Get Lowbyte of Address
                STA .POINTER    ; Store in pointer
                LDA #>.ADDRESS  ; Get Hibyte of Address
                STA .POINTER+1  ; Store in pointer+1

            ENDM

;-------------------------------------------------------
; BOUNDARY byte#
; Original author: Denis Debro (borrowed from Bob Smith / Thomas)
;
; Push data to a certain position inside a page and keep count of how
; many free bytes the programmer will have.
;
; eg: BOUNDARY 5    ; position at byte #5 in page

.FREE_BYTES SET 0   
   MAC BOUNDARY
      REPEAT 256
         IF <. % {1} = 0
            MEXIT
         ELSE
.FREE_BYTES SET .FREE_BYTES + 1
            .byte $00
         ENDIF
      REPEND
   ENDM


; EOF
`,
  };

  return { assemble, listingText, symbolText, VERSION, OPS, BUILTIN };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DASM;
