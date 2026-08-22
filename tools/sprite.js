/* ==========================================================================
   Converte sprite do Atari 2600 entre tabela .byte e PNG, pelo terminal.

       export   tira uma tabela .byte do fonte e grava como PNG
       import   devolve um PNG em linhas .byte para colar no fonte

   Um sprite de player tem 8 pixels de largura e um byte por scanline: o bit 7
   é o pixel da esquerda. Byte de playfield funciona igual, mas costuma ser
   desenhado com 4x a largura — daí o --scale-x.

       node tools/sprite.js export Arq_asm/riverraid.asm --lines 2816-2833 -o jet.png
       node tools/sprite.js import jet.png

   O editor (tools/sprite-editor.html) faz o mesmo de forma visual: arraste o
   PNG para a página, ou Arquivo > Exportar sprite em PNG. Isto aqui é para
   quando você quer fazer em lote ou dentro de um script.

   PNG é escrito e lido aqui mesmo, com o zlib do Node — sem dependência.
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BYTE_RE = /^\s*(?:\w+\s+)?\.?byte\b(.*?)(?:;.*)?$/i;
const VAL_RE = /%([01]{8})|\$([0-9a-fA-F]{1,2})|#?(\d+)/g;

/* --- fonte -> valores ------------------------------------------------------ */
function parseBytes(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = BYTE_RE.exec(line);
    if (!m) continue;
    VAL_RE.lastIndex = 0;
    let v;
    while ((v = VAL_RE.exec(m[1])) !== null) {
      const val = v[1] ? parseInt(v[1], 2) : v[2] ? parseInt(v[2], 16) : parseInt(v[3], 10);
      if (val >= 0 && val <= 255) out.push(val);
    }
  }
  return out;
}

/* --- PNG -------------------------------------------------------------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/* grava um PNG RGB de 8 bits a partir de uma função (x, y) -> [r, g, b] */
function writePng(file, w, h, pixel) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;                                  // filtro: nenhum
    for (let x = 0; x < w; x++) {
      const rgb = pixel(x, y);
      raw[p++] = rgb[0]; raw[p++] = rgb[1]; raw[p++] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;                                     // bits por canal
  ihdr[9] = 2;                                     // cor: RGB
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/* lê um PNG e devolve { w, h, lum } com a luminância de cada pixel (0..255) */
function readPng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(file + ' não é um PNG');

  let w = 0, h = 0, depth = 0, color = 0, interlace = 0, plte = null;
  const idat = [];
  for (let p = 8; p + 8 <= buf.length;) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; color = data[9]; interlace = data[12];
    } else if (type === 'PLTE') plte = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (interlace) throw new Error('PNG entrelaçado (Adam7) — grave sem entrelaçamento');
  if (![1, 2, 4, 8, 16].includes(depth)) throw new Error('PNG de ' + depth + ' bits por canal');

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!channels) throw new Error('tipo de cor ' + color + ' não suportado');
  if (depth < 8 && color !== 0 && color !== 3) {
    throw new Error('PNG de ' + depth + ' bits só é lido em tons de cinza ou paleta');
  }
  const sample = Math.max(1, depth / 8);           // bytes por amostra (8/16 bits)
  const bits = channels * depth;                   // bits por pixel
  const bpp = Math.max(1, bits >> 3);              // passo do filtro, mínimo 1 byte
  const stride = Math.ceil(w * bits / 8);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const cur = Buffer.alloc(stride);
  let prev = Buffer.alloc(stride);
  const lum = new Uint8Array(w * h);

  for (let y = 0, q = 0; y < h; y++) {
    const filter = raw[q++];
    for (let i = 0; i < stride; i++) {
      const x = raw[q + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      cur[i] = (filter === 0 ? x
              : filter === 1 ? x + a
              : filter === 2 ? x + b
              : filter === 3 ? x + ((a + b) >> 1)
              : x + paeth(a, b, c)) & 0xff;
    }
    q += stride;
    for (let x = 0; x < w; x++) {
      let v;
      if (depth < 8) {                             // 1, 2 ou 4 bits: cinza ou paleta
        const bit = x * depth;
        const raw8 = (cur[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        if (color === 3) {
          const idx = raw8 * 3;
          v = 0.299 * plte[idx] + 0.587 * plte[idx + 1] + 0.114 * plte[idx + 2];
        } else {
          v = raw8 * 255 / ((1 << depth) - 1);
        }
      } else {
        const i = x * bpp;
        if (color === 3) {
          const idx = cur[i] * 3;
          v = 0.299 * plte[idx] + 0.587 * plte[idx + 1] + 0.114 * plte[idx + 2];
        } else if (color === 0 || color === 4) {
          v = cur[i];
        } else {
          v = 0.299 * cur[i] + 0.587 * cur[i + sample] + 0.114 * cur[i + 2 * sample];
        }
      }
      lum[y * w + x] = Math.round(v);
    }
    prev = Buffer.from(cur);
  }
  return { w, h, lum };
}

/* --- comandos ---------------------------------------------------------------- */
function cmdExport(args) {
  let lines = fs.readFileSync(args.source, 'latin1').split(/\r?\n/);
  if (args.lines) {
    const [a, b] = args.lines.split('-');
    lines = lines.slice(parseInt(a, 10) - 1, parseInt(b || a, 10));
  }
  const rows = parseBytes(lines.join('\n'));
  if (!rows.length) { console.error('nenhum valor .byte nesse trecho'); process.exit(1); }
  if (args.flip) rows.reverse();

  const zoom = args.zoom, sx = args.scaleX;
  const w = 8 * sx * zoom, h = rows.length * zoom;
  const out = args.out || path.basename(args.source, path.extname(args.source)) + '.png';
  writePng(out, w, h, (x, y) => {
    const on = (rows[Math.floor(y / zoom)] >> (7 - Math.floor(x / (sx * zoom)))) & 1;
    return on ? [255, 255, 255] : [0, 0, 0];
  });
  console.log(out + ': sprite 8x' + rows.length + ' (' + w + 'x' + h + ' px gravados)');
}

function cmdImport(args) {
  const img = readPng(args.png);
  if (img.w % 8) { console.error('largura ' + img.w + ' não é múltipla de 8'); process.exit(1); }
  const rows = Math.round(img.h * 8 / img.w);      // mesma proporção, 8 de largura
  const bits = [];
  for (let y = 0; y < rows; y++) {
    const sy = Math.min(img.h - 1, Math.floor((y + 0.5) * img.h / rows));
    let s = '';
    for (let x = 0; x < 8; x++) {
      const sx = Math.min(img.w - 1, Math.floor((x + 0.5) * img.w / 8));
      s += img.lum[sy * img.w + sx] >= args.threshold ? '1' : '0';
    }
    bits.push(s);
  }
  if (args.flip) bits.reverse();

  console.log(args.label || path.basename(args.png, path.extname(args.png)));
  for (const b of bits) {
    const art = b.replace(/1/g, 'X').replace(/0/g, ' ');
    console.log('    .byte %' + b + '  ; |' + art + '| $' +
      parseInt(b, 2).toString(16).toUpperCase().padStart(2, '0'));
  }
  console.error('; ' + bits.length + ' bytes');
}

/* --- linha de comando --------------------------------------------------------- */
function usage() {
  console.log([
    'uso: node tools/sprite.js export <fonte.asm> [opções]',
    '     node tools/sprite.js import <arquivo.png> [opções]',
    '',
    'export:  --lines A-B    trecho do fonte (padrão: o arquivo inteiro)',
    '         -o, --out      PNG de saída (padrão: <fonte>.png)',
    '         --zoom N       ampliação de cada pixel (padrão 8)',
    '         --scale-x N    esticada horizontal: 1 player, 4 playfield (padrão 1)',
    '         --flip         inverte a ordem das linhas',
    '',
    'import:  --label NOME   rótulo impresso acima dos dados',
    '         --threshold N  luminância a partir da qual o pixel liga (padrão 128)',
    '         --flip         inverte a ordem das linhas',
  ].join('\n'));
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  if (!cmd || cmd === '--help' || cmd === '-h') { usage(); return cmd ? 0 : 2; }
  if (cmd !== 'export' && cmd !== 'import') { console.error('comando desconhecido: ' + cmd); usage(); return 2; }

  const args = { zoom: 8, scaleX: 1, threshold: 128, flip: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--lines') args.lines = argv[++i];
    else if (a === '-o' || a === '--out') args.out = argv[++i];
    else if (a === '--zoom') args.zoom = parseInt(argv[++i], 10);
    else if (a === '--scale-x') args.scaleX = parseInt(argv[++i], 10);
    else if (a === '--label') args.label = argv[++i];
    else if (a === '--threshold') args.threshold = parseInt(argv[++i], 10);
    else if (a === '--flip') args.flip = true;
    else if (a[0] === '-') { console.error('opção desconhecida: ' + a); return 2; }
    else rest.push(a);
  }
  if (!rest.length) { usage(); return 2; }

  try {
    if (cmd === 'export') { args.source = rest[0]; cmdExport(args); }
    else { args.png = rest[0]; cmdImport(args); }
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  return 0;
}

process.exit(main());
