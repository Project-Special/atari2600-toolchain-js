/* ==========================================================================
   NES — nucleo de Nintendo Entertainment System escrito para este projeto.

   CPU 6502 (o 2A03 e um 6502 sem modo decimal), PPU 2C02 e os mappers mais
   comuns. O relogio e o da PPU: 3 pontos de PPU por ciclo de CPU, 341 pontos
   por scanline, 262 scanlines por quadro.

       const nes = NES.create();
       nes.load(uint8ArrayComOArquivoNes);   // .nes no formato iNES
       nes.frame();                          // roda um quadro inteiro
       nes.pixels                            // Uint32Array 256 x 240, 0xRRGGBB

   Sem som: os registradores da APU sao aceitos e ignorados. O que falta esta
   anotado em cada lugar.
   ========================================================================== */

const NES = (() => {
  'use strict';

  const WIDTH = 256, HEIGHT = 240;

  /* os mappers que este nucleo entende */
  const MAPPERS = { 0: 'NROM', 1: 'MMC1', 2: 'UxROM', 3: 'CNROM', 4: 'MMC3', 7: 'AxROM' };
  const DOTS_PER_LINE = 341;
  const LINES_PER_FRAME = 262;

  /* A paleta do 2C02 em RGB. O NES nao tem paleta programavel de verdade: os
     64 valores sao fixos no silicio, e o jogo so escolhe quais entram nas 8
     paletas de 4 cores. */
  const MASTER = [
    0x7c7c7c, 0x0000fc, 0x0000bc, 0x4428bc, 0x940084, 0xa80020, 0xa81000, 0x881400,
    0x503000, 0x007800, 0x006800, 0x005800, 0x004058, 0x000000, 0x000000, 0x000000,
    0xbcbcbc, 0x0078f8, 0x0058f8, 0x6844fc, 0xd800cc, 0xe40058, 0xf83800, 0xe45c10,
    0xac7c00, 0x00b800, 0x00a800, 0x00a844, 0x008888, 0x000000, 0x000000, 0x000000,
    0xf8f8f8, 0x3cbcfc, 0x6888fc, 0x9878f8, 0xf878f8, 0xf85898, 0xf87858, 0xfca044,
    0xf8b800, 0xb8f818, 0x58d854, 0x58f898, 0x00e8d8, 0x787878, 0x000000, 0x000000,
    0xfcfcfc, 0xa4e4fc, 0xb8b8f8, 0xd8b8f8, 0xf8b8f8, 0xf8a4c0, 0xf0d0b0, 0xfce0a8,
    0xf8d878, 0xd8f878, 0xb8f8b8, 0xb8f8d8, 0x00fcfc, 0xf8d8f8, 0x000000, 0x000000,
  ];

  function create(opts) {
    opts = opts || {};
    const pixels = new Uint32Array(WIDTH * HEIGHT);

    /* =====================================================================
       Cartucho
       ===================================================================== */
    let prg = new Uint8Array(0x4000);
    let chr = new Uint8Array(0x2000);
    let chrIsRam = false;
    let prgRam = new Uint8Array(0x2000);
    let mapper = 0;
    let mirroring = 0;                 // 0 horizontal, 1 vertical, 2 e 3 = uma tela
    let prgBankCount = 1, chrBankCount = 1;

    /* Todo mapper cai no mesmo par de mapas: quatro janelas de 8K para o PRG
       e oito de 1K para a CHR, guardando o offset em bytes de cada uma. E o
       menor denominador comum -- o MMC3 troca de 8K e 1K por vez, e os outros
       so preenchem varias janelas com o mesmo banco. */
    const prgMap = new Int32Array(4);
    const chrMap = new Int32Array(8);

    /* MMC1 */
    let mmc1Shift = 0x10, mmc1Ctrl = 0x0c, mmc1Chr0 = 0, mmc1Chr1 = 0, mmc1Prg = 0;

    /* MMC3 */
    const mmc3R = new Int32Array(8);   // R0..R7
    let mmc3Select = 0;                // o registrador escolhido, mais os dois modos
    let mmc3IrqLatch = 0, mmc3IrqCounter = 0, mmc3IrqEnable = false, mmc3IrqReload = false;
    let irqPending = false;

    const prg8 = n => {                 // n-esimo banco de 8K, dando a volta
      const total = Math.max(1, prg.length >> 13);
      return (((n % total) + total) % total) * 0x2000;
    };
    const chr1 = n => {                 // n-esimo banco de 1K
      const total = Math.max(1, chr.length >> 10);
      return (((n % total) + total) % total) * 0x400;
    };

    function setPrg32(bank32) {
      for (let k = 0; k < 4; k++) prgMap[k] = prg8(bank32 * 4 + k);
    }
    function setPrg16(win, bank16) {    // win 0 = $8000, 1 = $C000
      prgMap[win * 2] = prg8(bank16 * 2);
      prgMap[win * 2 + 1] = prg8(bank16 * 2 + 1);
    }
    function setChr8(bank8) {
      for (let k = 0; k < 8; k++) chrMap[k] = chr1(bank8 * 8 + k);
    }
    function setChr4(win, bank4) {      // win 0 = $0000, 1 = $1000
      for (let k = 0; k < 4; k++) chrMap[win * 4 + k] = chr1(bank4 * 4 + k);
    }

    function load(bytes) {
      const d = new Uint8Array(bytes);
      if (d[0] !== 0x4e || d[1] !== 0x45 || d[2] !== 0x53 || d[3] !== 0x1a) {
        throw new Error('nao parece um arquivo iNES (faltou o "NES" no comeco)');
      }
      const prg16k = d[4] || 1;
      const chr8k = d[5];
      const flags6 = d[6], flags7 = d[7];
      mapper = (flags7 & 0xf0) | (flags6 >> 4);
      mirroring = (flags6 & 8) ? 2 : (flags6 & 1);
      const trainer = (flags6 & 4) ? 512 : 0;

      let p = 16 + trainer;
      prg = d.slice(p, p + prg16k * 0x4000);
      p += prg16k * 0x4000;
      if (chr8k) {
        chr = d.slice(p, p + chr8k * 0x2000);
        chrIsRam = false;
      } else {
        chr = new Uint8Array(0x2000);   // o jogo desenha os tiles em CHR-RAM
        chrIsRam = true;
      }
      prgBankCount = prg16k;
      chrBankCount = chr8k || 1;
      prgRam = new Uint8Array(0x2000);

      /* estado inicial de cada mapper */
      mmc1Shift = 0x10; mmc1Ctrl = 0x0c; mmc1Chr0 = 0; mmc1Chr1 = 0; mmc1Prg = 0;
      mmc3R.fill(0); mmc3Select = 0;
      mmc3IrqLatch = 0; mmc3IrqCounter = 0; mmc3IrqEnable = false; mmc3IrqReload = false;
      irqPending = false;

      setChr8(0);
      if (mapper === 7) setPrg32(0);
      else { setPrg16(0, 0); setPrg16(1, prg16k - 1); }   // o ultimo banco no fim
      if (mapper === 4) applyMmc3();
      reset();
    }

    /* --- leitura e escrita do cartucho ------------------------------------ */
    function prgRead(a) {
      return prg[prgMap[(a >> 13) & 3] + (a & 0x1fff)];
    }

    function prgWrite(a, v) {
      switch (mapper) {
        case 1: mmc1Write(a, v); break;
        case 2: setPrg16(0, v & 0x0f); break;             // UxROM
        case 3: setChr8(v & 3); break;                    // CNROM
        case 4: mmc3Write(a, v); break;
        case 7:                                           // AxROM
          setPrg32(v & 7);
          mirroring = (v & 0x10) ? 3 : 2;
          break;
        default: break;                                   // NROM nao tem registrador
      }
    }

    /* MMC1: um registrador de deslocamento de 5 bits, escrito um bit por vez */
    function mmc1Write(a, v) {
      if (v & 0x80) { mmc1Shift = 0x10; mmc1Ctrl |= 0x0c; applyMmc1(); return; }
      const full = mmc1Shift & 1;
      mmc1Shift = (mmc1Shift >> 1) | ((v & 1) << 4);
      if (!full) return;
      const value = mmc1Shift & 0x1f;
      mmc1Shift = 0x10;
      const reg = (a >> 13) & 3;
      if (reg === 0) mmc1Ctrl = value;
      else if (reg === 1) mmc1Chr0 = value;
      else if (reg === 2) mmc1Chr1 = value;
      else mmc1Prg = value;
      applyMmc1();
    }

    function applyMmc1() {
      mirroring = [3, 2, 1, 0][mmc1Ctrl & 3];
      const prgMode = (mmc1Ctrl >> 2) & 3;
      const bank = mmc1Prg & 0x0f;
      if (prgMode === 0 || prgMode === 1) setPrg32(bank >> 1);
      else if (prgMode === 2) { setPrg16(0, 0); setPrg16(1, bank); }
      else { setPrg16(0, bank); setPrg16(1, prgBankCount - 1); }
      if ((mmc1Ctrl >> 4) & 1) { setChr4(0, mmc1Chr0); setChr4(1, mmc1Chr1); }
      else setChr8(mmc1Chr0 >> 1);
    }

    /* MMC3: bancos de 8K no PRG, de 2K e 1K na CHR, e um contador de linhas que
       pede IRQ -- e com ele que os jogos partem a tela em duas. */
    function mmc3Write(a, v) {
      const odd = a & 1;
      switch (a & 0xe000) {
        case 0x8000:
          if (odd) mmc3R[mmc3Select & 7] = v;
          else mmc3Select = v;
          applyMmc3();
          break;
        case 0xa000:
          if (!odd) mirroring = (v & 1) ? 0 : 1;          // no MMC3, 0 e vertical
          break;
        case 0xc000:
          if (odd) { mmc3IrqCounter = 0; mmc3IrqReload = true; }
          else mmc3IrqLatch = v;
          break;
        case 0xe000:
          mmc3IrqEnable = !!odd;
          if (!odd) irqPending = false;                   // desligar tambem confirma
          break;
        default: break;
      }
    }

    function applyMmc3() {
      const last = (prg.length >> 13) - 1;
      if (mmc3Select & 0x40) {                            // $8000 fixo no penultimo
        prgMap[0] = prg8(last - 1);
        prgMap[1] = prg8(mmc3R[7]);
        prgMap[2] = prg8(mmc3R[6]);
      } else {
        prgMap[0] = prg8(mmc3R[6]);
        prgMap[1] = prg8(mmc3R[7]);
        prgMap[2] = prg8(last - 1);
      }
      prgMap[3] = prg8(last);                             // o ultimo e sempre fixo

      /* R0 e R1 sao bancos de 2K; R2..R5 sao de 1K. O bit 7 troca as metades. */
      const inv = (mmc3Select & 0x80) ? 4 : 0;
      chrMap[inv ^ 0] = chr1(mmc3R[0] & ~1);
      chrMap[inv ^ 1] = chr1((mmc3R[0] & ~1) + 1);
      chrMap[inv ^ 2] = chr1(mmc3R[1] & ~1);
      chrMap[inv ^ 3] = chr1((mmc3R[1] & ~1) + 1);
      chrMap[inv ^ 4] = chr1(mmc3R[2]);
      chrMap[inv ^ 5] = chr1(mmc3R[3]);
      chrMap[inv ^ 6] = chr1(mmc3R[4]);
      chrMap[inv ^ 7] = chr1(mmc3R[5]);
    }

    /* O contador do MMC3 anda quando a PPU passa a buscar padrao de sprite
       depois de ter buscado padrao de fundo -- na pratica, uma vez por linha
       desenhada. O ponto 260 e onde isso cai. */
    function mmc3ClockIrq() {
      if (mmc3IrqCounter === 0 || mmc3IrqReload) {
        mmc3IrqCounter = mmc3IrqLatch;
        mmc3IrqReload = false;
      } else {
        mmc3IrqCounter--;
      }
      if (mmc3IrqCounter === 0 && mmc3IrqEnable) irqPending = true;
    }

    function chrRead(a) {
      return chr[chrMap[(a >> 10) & 7] + (a & 0x3ff)];
    }

    function chrWrite(a, v) {
      if (!chrIsRam) return;
      chr[chrMap[(a >> 10) & 7] + (a & 0x3ff)] = v;
    }

    /* =====================================================================
       Memoria
       ===================================================================== */
    const ram = new Uint8Array(0x800);
    const vram = new Uint8Array(0x800);      // as duas tabelas de nomes reais
    const palRam = new Uint8Array(0x20);
    const oam = new Uint8Array(0x100);

    /* O cartucho so liga duas das quatro tabelas de nomes; qual delas cada
       endereco enxerga depende do espelhamento gravado no cabecalho. */
    function nameIndex(a) {
      const table = (a >> 10) & 3;
      const off = a & 0x3ff;
      switch (mirroring) {
        case 0: return ((table >> 1) << 10) | off;      // horizontal
        case 1: return ((table & 1) << 10) | off;       // vertical
        case 2: return off;                             // uma tela, a de baixo
        default: return 0x400 | off;                    // uma tela, a de cima
      }
    }

    function ppuRead(a) {
      a &= 0x3fff;
      if (a < 0x2000) return chrRead(a);
      if (a < 0x3f00) return vram[nameIndex(a)];
      return palRam[palIndex(a)];
    }

    function ppuWrite(a, v) {
      a &= 0x3fff;
      if (a < 0x2000) { chrWrite(a, v); return; }
      if (a < 0x3f00) { vram[nameIndex(a)] = v; return; }
      palRam[palIndex(a)] = v & 0x3f;
    }

    /* $3F10, $3F14, $3F18 e $3F1C sao espelhos da cor de fundo */
    function palIndex(a) {
      let i = a & 0x1f;
      if ((i & 3) === 0) i &= 0x0f;
      return i;
    }

    /* =====================================================================
       PPU 2C02
       ===================================================================== */
    let ctrl = 0, mask = 0, status = 0, oamAddr = 0;
    let v = 0, t = 0, fineX = 0, writeToggle = 0, readBuffer = 0;
    let scanline = 261, dot = 0, frame = 0, frameDone = false;
    let nmiPending = false;

    let ntByte = 0, atByte = 0, patLoByte = 0, patHiByte = 0;
    let bgShiftLo = 0, bgShiftHi = 0, atShiftLo = 0, atShiftHi = 0;

    /* os oito sprites escolhidos para a linha que vem */
    const spX = new Uint8Array(8), spLo = new Uint8Array(8), spHi = new Uint8Array(8);
    const spAttr = new Uint8Array(8), spIsZero = new Uint8Array(8);
    let spCount = 0;

    const rendering = () => (mask & 0x18) !== 0;

    function ppuRegRead(r) {
      switch (r) {
        case 2: {
          const out = (status & 0xe0) | (readBuffer & 0x1f);
          status &= ~0x80;                 // ler $2002 apaga o aviso de vblank
          writeToggle = 0;
          return out;
        }
        case 4: return oam[oamAddr];
        case 7: {
          let out;
          const a = v & 0x3fff;
          if (a >= 0x3f00) {
            out = palRam[palIndex(a)];
            readBuffer = vram[nameIndex(a)];
          } else {
            out = readBuffer;              // leitura de VRAM vem com um atraso
            readBuffer = ppuRead(a);
          }
          v = (v + ((ctrl & 4) ? 32 : 1)) & 0x7fff;
          return out;
        }
        default: return readBuffer & 0xff;
      }
    }

    function ppuRegWrite(r, val) {
      const value = val & 0xff;
      readBuffer = value;
      switch (r) {
        case 0:
          ctrl = value;
          t = (t & 0xf3ff) | ((value & 3) << 10);
          break;
        case 1: mask = value; break;
        case 3: oamAddr = value; break;
        case 4: oam[oamAddr] = value; oamAddr = (oamAddr + 1) & 0xff; break;
        case 5:
          if (!writeToggle) {
            t = (t & 0xffe0) | (value >> 3);
            fineX = value & 7;
            writeToggle = 1;
          } else {
            t = (t & 0x8fff) | ((value & 7) << 12);
            t = (t & 0xfc1f) | ((value & 0xf8) << 2);
            writeToggle = 0;
          }
          break;
        case 6:
          if (!writeToggle) {
            t = (t & 0x00ff) | ((value & 0x3f) << 8);
            writeToggle = 1;
          } else {
            t = (t & 0xff00) | value;
            v = t;
            writeToggle = 0;
          }
          break;
        case 7:
          ppuWrite(v, value);
          v = (v + ((ctrl & 4) ? 32 : 1)) & 0x7fff;
          break;
        default: break;
      }
    }

    /* --- os passos que o hardware da no endereco durante o desenho -------- */
    function incCoarseX() {
      if ((v & 0x001f) === 31) { v &= ~0x001f; v ^= 0x0400; }
      else v++;
    }

    function incY() {
      if ((v & 0x7000) !== 0x7000) { v += 0x1000; return; }
      v &= ~0x7000;
      let y = (v & 0x03e0) >> 5;
      if (y === 29) { y = 0; v ^= 0x0800; }
      else if (y === 31) y = 0;
      else y++;
      v = (v & ~0x03e0) | (y << 5);
    }

    const copyX = () => { v = (v & 0xfbe0) | (t & 0x041f); };
    const copyY = () => { v = (v & 0x841f) | (t & 0x7be0); };

    function loadShifters() {
      bgShiftLo = (bgShiftLo & 0xff00) | patLoByte;
      bgShiftHi = (bgShiftHi & 0xff00) | patHiByte;
      atShiftLo = (atShiftLo & 0xff00) | ((atByte & 1) ? 0xff : 0);
      atShiftHi = (atShiftHi & 0xff00) | ((atByte & 2) ? 0xff : 0);
    }

    function shiftBg() {
      bgShiftLo = (bgShiftLo << 1) & 0xffff;
      bgShiftHi = (bgShiftHi << 1) & 0xffff;
      atShiftLo = (atShiftLo << 1) & 0xffff;
      atShiftHi = (atShiftHi << 1) & 0xffff;
    }

    /* --- sprites: escolhe ate oito para a proxima linha ------------------- */
    function evaluateSprites(line) {
      spCount = 0;
      const tall = (ctrl & 0x20) ? 16 : 8;
      for (let i = 0; i < 64; i++) {
        const y = oam[i * 4];
        const row = line - y;
        if (row < 0 || row >= tall) continue;
        if (spCount === 8) { status |= 0x20; break; }   // aviso de excesso
        const tile = oam[i * 4 + 1];
        const attr = oam[i * 4 + 2];
        const flipV = attr & 0x80;
        let r = flipV ? tall - 1 - row : row;
        let addr;
        if (tall === 16) {
          const table = (tile & 1) * 0x1000;
          const base = (tile & 0xfe) * 16;
          addr = table + base + (r >= 8 ? 16 : 0) + (r & 7);
        } else {
          addr = ((ctrl & 8) ? 0x1000 : 0) + tile * 16 + r;
        }
        let lo = ppuRead(addr), hi = ppuRead(addr + 8);
        if (attr & 0x40) { lo = flipByte(lo); hi = flipByte(hi); }
        spX[spCount] = oam[i * 4 + 3];
        spLo[spCount] = lo;
        spHi[spCount] = hi;
        spAttr[spCount] = attr;
        spIsZero[spCount] = i === 0 ? 1 : 0;
        spCount++;
      }
    }

    function flipByte(b) {
      b = ((b & 0xf0) >> 4) | ((b & 0x0f) << 4);
      b = ((b & 0xcc) >> 2) | ((b & 0x33) << 2);
      return ((b & 0xaa) >> 1) | ((b & 0x55) << 1);
    }

    /* --- um pixel --------------------------------------------------------- */
    function renderPixel(x, y) {
      let bgPixel = 0, bgPal = 0;
      if ((mask & 8) && (x >= 8 || (mask & 2))) {
        const bit = 0x8000 >> fineX;
        bgPixel = ((bgShiftLo & bit) ? 1 : 0) | ((bgShiftHi & bit) ? 2 : 0);
        bgPal = ((atShiftLo & bit) ? 1 : 0) | ((atShiftHi & bit) ? 2 : 0);
      }

      let spPixel = 0, spPal = 0, spPriority = 0, spZero = false;
      if ((mask & 0x10) && (x >= 8 || (mask & 4))) {
        for (let i = 0; i < spCount; i++) {
          const dx = x - spX[i];
          if (dx < 0 || dx > 7) continue;
          const bit = 0x80 >> dx;
          const p = ((spLo[i] & bit) ? 1 : 0) | ((spHi[i] & bit) ? 2 : 0);
          if (!p) continue;
          spPixel = p;
          spPal = (spAttr[i] & 3) + 4;
          spPriority = (spAttr[i] & 0x20) === 0;
          spZero = spIsZero[i] === 1;
          break;                                  // o de menor indice ganha
        }
      }

      let index;
      if (!bgPixel && !spPixel) index = palRam[0];
      else if (!bgPixel) index = palRam[palIndex(0x3f00 | (spPal << 2) | spPixel)];
      else if (!spPixel) index = palRam[palIndex(0x3f00 | (bgPal << 2) | bgPixel)];
      else {
        if (spZero && x !== 255) status |= 0x40;   // o famoso acerto do sprite 0
        index = spPriority ? palRam[palIndex(0x3f00 | (spPal << 2) | spPixel)]
                           : palRam[palIndex(0x3f00 | (bgPal << 2) | bgPixel)];
      }
      pixels[y * WIDTH + x] = MASTER[index & 0x3f];
    }

    /* --- um ponto de PPU --------------------------------------------------- */
    function ppuTick() {
      const visible = scanline < 240;
      const pre = scanline === 261;

      if (pre && dot === 1) status &= ~0xe0;
      if (scanline === 241 && dot === 1) {
        status |= 0x80;
        if (ctrl & 0x80) nmiPending = true;
        frameDone = true;
      }

      if (rendering() && (visible || pre)) {
        if ((dot >= 2 && dot <= 257) || (dot >= 322 && dot <= 337)) shiftBg();
        if ((dot >= 1 && dot <= 256) || (dot >= 321 && dot <= 336)) {
          switch (dot & 7) {
            case 1: loadShifters(); ntByte = ppuRead(0x2000 | (v & 0x0fff)); break;
            case 3: {
              const a = 0x23c0 | (v & 0x0c00) | ((v >> 4) & 0x38) | ((v >> 2) & 7);
              let at = ppuRead(a);
              if (v & 0x40) at >>= 4;
              if (v & 0x02) at >>= 2;
              atByte = at & 3;
              break;
            }
            case 5: patLoByte = ppuRead(((ctrl & 0x10) ? 0x1000 : 0) + ntByte * 16 + ((v >> 12) & 7)); break;
            case 7: patHiByte = ppuRead(((ctrl & 0x10) ? 0x1000 : 0) + ntByte * 16 + ((v >> 12) & 7) + 8); break;
            case 0: incCoarseX(); break;
          }
        }
        if (dot === 256) incY();
        if (dot === 257) { copyX(); evaluateSprites(scanline + 1); }
        if (pre && dot >= 280 && dot <= 304) copyY();
      }

      if (visible && dot >= 1 && dot <= 256) renderPixel(dot - 1, scanline);

      /* o contador de linhas do MMC3 anda uma vez por linha desenhada */
      if (mapper === 4 && dot === 260 && rendering() && (visible || pre)) mmc3ClockIrq();

      dot++;
      if (dot >= DOTS_PER_LINE) {
        dot = 0;
        scanline++;
        if (scanline >= LINES_PER_FRAME) {
          scanline = 0;
          frame++;
          // no quadro impar, com desenho ligado, a PPU pula um ponto
          if ((frame & 1) && rendering()) dot = 1;
        }
      }
    }

    /* =====================================================================
       Controles
       ===================================================================== */
    const buttons = [0, 0];              // bit 0 A, 1 B, 2 Select, 3 Start, 4 cima...
    let padShift = [0, 0], padStrobe = 0;
    const BUTTON = { a: 0, b: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7 };

    function setButton(pad, name, down) {
      const bit = BUTTON[name];
      if (bit === undefined) return;
      if (down) buttons[pad] |= 1 << bit;
      else buttons[pad] &= ~(1 << bit);
    }

    /* =====================================================================
       Barramento da CPU
       ===================================================================== */
    let dmaStall = 0;

    function cpuRead(a) {
      a &= 0xffff;
      if (a < 0x2000) return ram[a & 0x7ff];
      if (a < 0x4000) return ppuRegRead(a & 7);
      if (a === 0x4016 || a === 0x4017) {
        const i = a & 1;
        const out = padShift[i] & 1;
        padShift[i] = (padShift[i] >> 1) | 0x80;
        return out | 0x40;
      }
      if (a < 0x4020) return 0;                    // APU: sem som por enquanto
      if (a < 0x8000) return prgRam[a & 0x1fff];
      return prgRead(a);
    }

    function cpuWrite(a, val) {
      a &= 0xffff;
      const value = val & 0xff;
      if (a < 0x2000) { ram[a & 0x7ff] = value; return; }
      if (a < 0x4000) { ppuRegWrite(a & 7, value); return; }
      if (a === 0x4014) {                           // DMA da OAM
        const base = value << 8;
        for (let i = 0; i < 256; i++) oam[(oamAddr + i) & 0xff] = cpuRead(base + i);
        dmaStall += 513;
        return;
      }
      if (a === 0x4016) {
        padStrobe = value & 1;
        if (padStrobe) { padShift[0] = buttons[0]; padShift[1] = buttons[1]; }
        return;
      }
      if (a < 0x4020) return;                       // APU
      if (a < 0x8000) { prgRam[a & 0x1fff] = value; return; }
      prgWrite(a, value);
    }

    /* =====================================================================
       CPU 6502 (2A03: sem modo decimal)
       ===================================================================== */
    let A = 0, X = 0, Y = 0, S = 0xfd, PC = 0;
    let fC = 0, fZ = 0, fI = 1, fD = 0, fV = 0, fN = 0;
    let cycles = 0;
    const unknownOps = {};

    function tick() {
      cycles++;
      ppuTick(); ppuTick(); ppuTick();
    }

    const rd = a => { tick(); return cpuRead(a); };
    const wr = (a, v2) => { tick(); cpuWrite(a, v2); };

    const setZN = n => { fZ = (n & 0xff) === 0 ? 1 : 0; fN = (n >> 7) & 1; };
    const packP = () => (fN << 7) | (fV << 6) | 0x20 | (fD << 3) | (fI << 2) | (fZ << 1) | fC;
    const unpackP = p => { fN = (p >> 7) & 1; fV = (p >> 6) & 1; fD = (p >> 3) & 1; fI = (p >> 2) & 1; fZ = (p >> 1) & 1; fC = p & 1; };
    const push = n => { wr(0x100 | S, n); S = (S - 1) & 0xff; };
    const pull = () => { S = (S + 1) & 0xff; return rd(0x100 | S); };

    const aImm = () => PC++;
    const aZp = () => rd(PC++);
    const aZpX = () => { const z = rd(PC++); tick(); return (z + X) & 0xff; };
    const aZpY = () => { const z = rd(PC++); tick(); return (z + Y) & 0xff; };
    const aAbs = () => { const lo = rd(PC++), hi = rd(PC++); return lo | (hi << 8); };
    const aAbsX = w => { const lo = rd(PC++), hi = rd(PC++); const b = lo | (hi << 8);
                         const a = (b + X) & 0xffff; if (w || ((b ^ a) & 0xff00)) tick(); return a; };
    const aAbsY = w => { const lo = rd(PC++), hi = rd(PC++); const b = lo | (hi << 8);
                         const a = (b + Y) & 0xffff; if (w || ((b ^ a) & 0xff00)) tick(); return a; };
    const aIndX = () => { const z = rd(PC++); tick(); const p = (z + X) & 0xff;
                          return rd(p) | (rd((p + 1) & 0xff) << 8); };
    const aIndY = w => { const z = rd(PC++); const b = rd(z) | (rd((z + 1) & 0xff) << 8);
                         const a = (b + Y) & 0xffff; if (w || ((b ^ a) & 0xff00)) tick(); return a; };

    function branch(take) {
      const off = rd(PC++);
      if (!take) return;
      tick();
      const target = (PC + (off < 0x80 ? off : off - 256)) & 0xffff;
      if ((target ^ PC) & 0xff00) tick();
      PC = target;
    }

    /* o 2A03 tem o modo decimal desligado no silicio: soma sempre binaria */
    function adc(n) {
      const sum = A + n + fC;
      fV = (~(A ^ n) & (A ^ sum) & 0x80) ? 1 : 0;
      fC = sum > 0xff ? 1 : 0;
      A = sum & 0xff;
      setZN(A);
    }
    const sbc = n => adc(n ^ 0xff);
    function cmpReg(reg, n) { const d = (reg - n) & 0x1ff; fC = reg >= n ? 1 : 0; setZN(d & 0xff); }

    function reset() {
      A = X = Y = 0; S = 0xfd;
      fC = fZ = fD = fV = fN = 0; fI = 1;
      PC = cpuRead(0xfffc) | (cpuRead(0xfffd) << 8);
      cycles = 0;
      scanline = 261; dot = 0; frame = 0;
      ctrl = mask = status = 0; v = t = fineX = writeToggle = 0;
      nmiPending = false; dmaStall = 0;
      ram.fill(0); vram.fill(0); palRam.fill(0); oam.fill(0);
      pixels.fill(0);
    }

    function nmi() {
      push((PC >> 8) & 0xff);
      push(PC & 0xff);
      push(packP() & ~0x10);
      fI = 1;
      PC = cpuRead(0xfffa) | (cpuRead(0xfffb) << 8);
      tick(); tick();
    }

    /* o IRQ e mascaravel: so entra com a bandeira I desligada. Quem pede aqui e
       o contador de linhas do MMC3. */
    function irq() {
      push((PC >> 8) & 0xff);
      push(PC & 0xff);
      push(packP() & ~0x10);
      fI = 1;
      PC = cpuRead(0xfffe) | (cpuRead(0xffff) << 8);
      tick(); tick();
    }

    function step() {
      if (nmiPending) { nmiPending = false; nmi(); return; }
      if (irqPending && !fI) { irq(); return; }
      if (dmaStall > 0) { dmaStall--; tick(); return; }
      const op = rd(PC++);
      let a, m;
      switch (op) {
        /* --- carga e guarda --- */
        case 0xa9: A = rd(aImm()); setZN(A); break;
        case 0xa5: A = rd(aZp()); setZN(A); break;
        case 0xb5: A = rd(aZpX()); setZN(A); break;
        case 0xad: A = rd(aAbs()); setZN(A); break;
        case 0xbd: A = rd(aAbsX(0)); setZN(A); break;
        case 0xb9: A = rd(aAbsY(0)); setZN(A); break;
        case 0xa1: A = rd(aIndX()); setZN(A); break;
        case 0xb1: A = rd(aIndY(0)); setZN(A); break;
        case 0xa2: X = rd(aImm()); setZN(X); break;
        case 0xa6: X = rd(aZp()); setZN(X); break;
        case 0xb6: X = rd(aZpY()); setZN(X); break;
        case 0xae: X = rd(aAbs()); setZN(X); break;
        case 0xbe: X = rd(aAbsY(0)); setZN(X); break;
        case 0xa0: Y = rd(aImm()); setZN(Y); break;
        case 0xa4: Y = rd(aZp()); setZN(Y); break;
        case 0xb4: Y = rd(aZpX()); setZN(Y); break;
        case 0xac: Y = rd(aAbs()); setZN(Y); break;
        case 0xbc: Y = rd(aAbsX(0)); setZN(Y); break;
        case 0x85: wr(aZp(), A); break;
        case 0x95: wr(aZpX(), A); break;
        case 0x8d: wr(aAbs(), A); break;
        case 0x9d: wr(aAbsX(1), A); break;
        case 0x99: wr(aAbsY(1), A); break;
        case 0x81: wr(aIndX(), A); break;
        case 0x91: wr(aIndY(1), A); break;
        case 0x86: wr(aZp(), X); break;
        case 0x96: wr(aZpY(), X); break;
        case 0x8e: wr(aAbs(), X); break;
        case 0x84: wr(aZp(), Y); break;
        case 0x94: wr(aZpX(), Y); break;
        case 0x8c: wr(aAbs(), Y); break;

        /* --- entre registradores --- */
        case 0xaa: X = A; setZN(X); tick(); break;
        case 0xa8: Y = A; setZN(Y); tick(); break;
        case 0xba: X = S; setZN(X); tick(); break;
        case 0x8a: A = X; setZN(A); tick(); break;
        case 0x9a: S = X; tick(); break;
        case 0x98: A = Y; setZN(A); tick(); break;

        /* --- pilha --- */
        case 0x48: tick(); push(A); break;
        case 0x08: tick(); push(packP() | 0x10); break;
        case 0x68: tick(); tick(); A = pull(); setZN(A); break;
        case 0x28: tick(); tick(); unpackP(pull()); break;

        /* --- logica e aritmetica --- */
        case 0x29: A &= rd(aImm()); setZN(A); break;
        case 0x25: A &= rd(aZp()); setZN(A); break;
        case 0x35: A &= rd(aZpX()); setZN(A); break;
        case 0x2d: A &= rd(aAbs()); setZN(A); break;
        case 0x3d: A &= rd(aAbsX(0)); setZN(A); break;
        case 0x39: A &= rd(aAbsY(0)); setZN(A); break;
        case 0x21: A &= rd(aIndX()); setZN(A); break;
        case 0x31: A &= rd(aIndY(0)); setZN(A); break;
        case 0x09: A |= rd(aImm()); setZN(A); break;
        case 0x05: A |= rd(aZp()); setZN(A); break;
        case 0x15: A |= rd(aZpX()); setZN(A); break;
        case 0x0d: A |= rd(aAbs()); setZN(A); break;
        case 0x1d: A |= rd(aAbsX(0)); setZN(A); break;
        case 0x19: A |= rd(aAbsY(0)); setZN(A); break;
        case 0x01: A |= rd(aIndX()); setZN(A); break;
        case 0x11: A |= rd(aIndY(0)); setZN(A); break;
        case 0x49: A ^= rd(aImm()); setZN(A); break;
        case 0x45: A ^= rd(aZp()); setZN(A); break;
        case 0x55: A ^= rd(aZpX()); setZN(A); break;
        case 0x4d: A ^= rd(aAbs()); setZN(A); break;
        case 0x5d: A ^= rd(aAbsX(0)); setZN(A); break;
        case 0x59: A ^= rd(aAbsY(0)); setZN(A); break;
        case 0x41: A ^= rd(aIndX()); setZN(A); break;
        case 0x51: A ^= rd(aIndY(0)); setZN(A); break;
        case 0x69: adc(rd(aImm())); break;
        case 0x65: adc(rd(aZp())); break;
        case 0x75: adc(rd(aZpX())); break;
        case 0x6d: adc(rd(aAbs())); break;
        case 0x7d: adc(rd(aAbsX(0))); break;
        case 0x79: adc(rd(aAbsY(0))); break;
        case 0x61: adc(rd(aIndX())); break;
        case 0x71: adc(rd(aIndY(0))); break;
        case 0xe9: case 0xeb: sbc(rd(aImm())); break;
        case 0xe5: sbc(rd(aZp())); break;
        case 0xf5: sbc(rd(aZpX())); break;
        case 0xed: sbc(rd(aAbs())); break;
        case 0xfd: sbc(rd(aAbsX(0))); break;
        case 0xf9: sbc(rd(aAbsY(0))); break;
        case 0xe1: sbc(rd(aIndX())); break;
        case 0xf1: sbc(rd(aIndY(0))); break;
        case 0xc9: cmpReg(A, rd(aImm())); break;
        case 0xc5: cmpReg(A, rd(aZp())); break;
        case 0xd5: cmpReg(A, rd(aZpX())); break;
        case 0xcd: cmpReg(A, rd(aAbs())); break;
        case 0xdd: cmpReg(A, rd(aAbsX(0))); break;
        case 0xd9: cmpReg(A, rd(aAbsY(0))); break;
        case 0xc1: cmpReg(A, rd(aIndX())); break;
        case 0xd1: cmpReg(A, rd(aIndY(0))); break;
        case 0xe0: cmpReg(X, rd(aImm())); break;
        case 0xe4: cmpReg(X, rd(aZp())); break;
        case 0xec: cmpReg(X, rd(aAbs())); break;
        case 0xc0: cmpReg(Y, rd(aImm())); break;
        case 0xc4: cmpReg(Y, rd(aZp())); break;
        case 0xcc: cmpReg(Y, rd(aAbs())); break;
        case 0x24: m = rd(aZp()); fZ = (A & m) === 0 ? 1 : 0; fN = (m >> 7) & 1; fV = (m >> 6) & 1; break;
        case 0x2c: m = rd(aAbs()); fZ = (A & m) === 0 ? 1 : 0; fN = (m >> 7) & 1; fV = (m >> 6) & 1; break;

        /* --- incremento e deslocamento --- */
        case 0xe6: a = aZp(); m = (rd(a) + 1) & 0xff; tick(); wr(a, m); setZN(m); break;
        case 0xf6: a = aZpX(); m = (rd(a) + 1) & 0xff; tick(); wr(a, m); setZN(m); break;
        case 0xee: a = aAbs(); m = (rd(a) + 1) & 0xff; tick(); wr(a, m); setZN(m); break;
        case 0xfe: a = aAbsX(1); m = (rd(a) + 1) & 0xff; tick(); wr(a, m); setZN(m); break;
        case 0xc6: a = aZp(); m = (rd(a) - 1) & 0xff; tick(); wr(a, m); setZN(m); break;
        case 0xd6: a = aZpX(); m = (rd(a) - 1) & 0xff; tick(); wr(a, m); setZN(m); break;
        case 0xce: a = aAbs(); m = (rd(a) - 1) & 0xff; tick(); wr(a, m); setZN(m); break;
        case 0xde: a = aAbsX(1); m = (rd(a) - 1) & 0xff; tick(); wr(a, m); setZN(m); break;
        case 0xe8: X = (X + 1) & 0xff; setZN(X); tick(); break;
        case 0xc8: Y = (Y + 1) & 0xff; setZN(Y); tick(); break;
        case 0xca: X = (X - 1) & 0xff; setZN(X); tick(); break;
        case 0x88: Y = (Y - 1) & 0xff; setZN(Y); tick(); break;
        case 0x0a: fC = (A >> 7) & 1; A = (A << 1) & 0xff; setZN(A); tick(); break;
        case 0x4a: fC = A & 1; A >>= 1; setZN(A); tick(); break;
        case 0x2a: m = (A << 1) | fC; fC = (A >> 7) & 1; A = m & 0xff; setZN(A); tick(); break;
        case 0x6a: m = (A >> 1) | (fC << 7); fC = A & 1; A = m & 0xff; setZN(A); tick(); break;
        case 0x06: a = aZp(); m = rd(a); fC = (m >> 7) & 1; m = (m << 1) & 0xff; tick(); wr(a, m); setZN(m); break;
        case 0x16: a = aZpX(); m = rd(a); fC = (m >> 7) & 1; m = (m << 1) & 0xff; tick(); wr(a, m); setZN(m); break;
        case 0x0e: a = aAbs(); m = rd(a); fC = (m >> 7) & 1; m = (m << 1) & 0xff; tick(); wr(a, m); setZN(m); break;
        case 0x1e: a = aAbsX(1); m = rd(a); fC = (m >> 7) & 1; m = (m << 1) & 0xff; tick(); wr(a, m); setZN(m); break;
        case 0x46: a = aZp(); m = rd(a); fC = m & 1; m >>= 1; tick(); wr(a, m); setZN(m); break;
        case 0x56: a = aZpX(); m = rd(a); fC = m & 1; m >>= 1; tick(); wr(a, m); setZN(m); break;
        case 0x4e: a = aAbs(); m = rd(a); fC = m & 1; m >>= 1; tick(); wr(a, m); setZN(m); break;
        case 0x5e: a = aAbsX(1); m = rd(a); fC = m & 1; m >>= 1; tick(); wr(a, m); setZN(m); break;
        case 0x26: a = aZp(); m = rd(a); { const c = fC; fC = (m >> 7) & 1; m = ((m << 1) | c) & 0xff; } tick(); wr(a, m); setZN(m); break;
        case 0x36: a = aZpX(); m = rd(a); { const c = fC; fC = (m >> 7) & 1; m = ((m << 1) | c) & 0xff; } tick(); wr(a, m); setZN(m); break;
        case 0x2e: a = aAbs(); m = rd(a); { const c = fC; fC = (m >> 7) & 1; m = ((m << 1) | c) & 0xff; } tick(); wr(a, m); setZN(m); break;
        case 0x3e: a = aAbsX(1); m = rd(a); { const c = fC; fC = (m >> 7) & 1; m = ((m << 1) | c) & 0xff; } tick(); wr(a, m); setZN(m); break;
        case 0x66: a = aZp(); m = rd(a); { const c = fC; fC = m & 1; m = (m >> 1) | (c << 7); } tick(); wr(a, m); setZN(m); break;
        case 0x76: a = aZpX(); m = rd(a); { const c = fC; fC = m & 1; m = (m >> 1) | (c << 7); } tick(); wr(a, m); setZN(m); break;
        case 0x6e: a = aAbs(); m = rd(a); { const c = fC; fC = m & 1; m = (m >> 1) | (c << 7); } tick(); wr(a, m); setZN(m); break;
        case 0x7e: a = aAbsX(1); m = rd(a); { const c = fC; fC = m & 1; m = (m >> 1) | (c << 7); } tick(); wr(a, m); setZN(m); break;

        /* --- desvios e saltos --- */
        case 0x10: branch(!fN); break;
        case 0x30: branch(fN === 1); break;
        case 0x50: branch(!fV); break;
        case 0x70: branch(fV === 1); break;
        case 0x90: branch(!fC); break;
        case 0xb0: branch(fC === 1); break;
        case 0xd0: branch(!fZ); break;
        case 0xf0: branch(fZ === 1); break;
        case 0x4c: PC = aAbs(); break;
        case 0x6c: {
          const p = aAbs();
          const lo = rd(p);
          const hi = rd((p & 0xff00) | ((p + 1) & 0xff));   // o bug da pagina
          PC = lo | (hi << 8);
          break;
        }
        case 0x20: {
          const lo = rd(PC++);
          tick();
          push(((PC) >> 8) & 0xff);
          push(PC & 0xff);
          PC = lo | (rd(PC) << 8);
          break;
        }
        case 0x60: tick(); tick(); { const lo = pull(), hi = pull(); PC = ((lo | (hi << 8)) + 1) & 0xffff; } tick(); break;
        case 0x40: tick(); tick(); unpackP(pull()); { const lo = pull(), hi = pull(); PC = lo | (hi << 8); } break;
        case 0x00: {
          PC++;
          push((PC >> 8) & 0xff);
          push(PC & 0xff);
          push(packP() | 0x10);
          fI = 1;
          PC = cpuRead(0xfffe) | (cpuRead(0xffff) << 8);
          tick();
          break;
        }

        /* --- bandeiras --- */
        case 0x18: fC = 0; tick(); break;
        case 0x38: fC = 1; tick(); break;
        case 0x58: fI = 0; tick(); break;
        case 0x78: fI = 1; tick(); break;
        case 0xb8: fV = 0; tick(); break;
        case 0xd8: fD = 0; tick(); break;
        case 0xf8: fD = 1; tick(); break;
        case 0xea: tick(); break;

        default:
          unknownOps[op] = (unknownOps[op] || 0) + 1;
          tick();
          break;
      }
      PC &= 0xffff;
    }

    /* =====================================================================
       API
       ===================================================================== */
    function frameStep() {
      frameDone = false;
      let guard = 0;
      while (!frameDone && guard++ < 200000) step();
      // roda ate o comeco do proximo quadro visivel
      while (scanline !== 0 && guard++ < 400000) step();
      return { pixels, frame };
    }

    return {
      load,
      reset,
      frame: frameStep,
      step,
      setButton,
      pixels,
      get info() {
        return {
          mapper, mapperName: MAPPERS[mapper] || ('mapper ' + mapper),
          prgBankCount, chrBankCount, chrIsRam,
          mirroring: ['horizontal', 'vertical', 'uma tela A', 'uma tela B'][mirroring],
          scanline, dot, cycles, frame, pc: PC,
          unknownOps: Object.keys(unknownOps).map(k => '$' + (+k).toString(16)),
        };
      },
      /* para o editor de tiles: a CHR crua e os dois planos de um tile */
      get chr() { return chr; },
      get chrIsRam() { return chrIsRam; },
      WIDTH, HEIGHT, MASTER,
    };
  }

  return { create, WIDTH, HEIGHT, MASTER };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = NES;
