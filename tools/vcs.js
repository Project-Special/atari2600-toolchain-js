/* ==========================================================================
   VCS — emulador de Atari 2600 escrito para o TIA Sprite Bench.

   Núcleo próprio: CPU 6507 (6502 sem os pinos de endereço altos), TIA e RIOT
   6532, mais cartucho 2K/4K/F8/F6/E0/FE. Escrito olhando a documentação de
   hardware do 2600 e o comportamento do Javatari como referência, mas sem
   reaproveitar código dele (Javatari é AGPL).

   O relógio mestre é o color clock: 1 ciclo de CPU = 3 color clocks, uma
   scanline = 228 color clocks (68 de HBLANK + 160 visíveis).

       const vcs = VCS.create({ palette });   // paleta NTSC em 0xRRGGBB
       vcs.load(uint8ArrayComOFonteCompilado);
       vcs.frame();                           // roda um quadro
       vcs.pixels                             // Uint32Array 160 x LINES, ABGR
   ========================================================================== */

const VCS = (() => {
  'use strict';

  const CLOCKS_PER_LINE = 228;
  const HBLANK = 68;
  const WIDTH = 160;
  const LINES = 240;             // o que guardamos por quadro depois do VSYNC
  const AUDIO_RATE = 31400;      // 3.579545 MHz / 114
  const CLOCKS_PER_AUDIO = 114;

  /* --- escritas na TIA ---------------------------------------------------- */
  const VSYNC = 0x00, VBLANK = 0x01, WSYNC = 0x02, RSYNC = 0x03,
        NUSIZ0 = 0x04, NUSIZ1 = 0x05, COLUP0 = 0x06, COLUP1 = 0x07,
        COLUPF = 0x08, COLUBK = 0x09, CTRLPF = 0x0a, REFP0 = 0x0b, REFP1 = 0x0c,
        PF0 = 0x0d, PF1 = 0x0e, PF2 = 0x0f, RESP0 = 0x10, RESP1 = 0x11,
        RESM0 = 0x12, RESM1 = 0x13, RESBL = 0x14, AUDC0 = 0x15, AUDC1 = 0x16,
        AUDF0 = 0x17, AUDF1 = 0x18, AUDV0 = 0x19, AUDV1 = 0x1a,
        GRP0 = 0x1b, GRP1 = 0x1c, ENAM0 = 0x1d, ENAM1 = 0x1e, ENABL = 0x1f,
        HMP0 = 0x20, HMP1 = 0x21, HMM0 = 0x22, HMM1 = 0x23, HMBL = 0x24,
        VDELP0 = 0x25, VDELP1 = 0x26, VDELBL = 0x27, RESMP0 = 0x28,
        RESMP1 = 0x29, HMOVE = 0x2a, HMCLR = 0x2b, CXCLR = 0x2c;

  /* NUSIZ: deslocamento de cada cópia e a escala do jogador */
  const COPIES = [[0], [0, 16], [0, 32], [0, 16, 32], [0, 64], [0], [0, 32, 64], [0]];
  const PLAYER_SCALE = [1, 1, 1, 1, 1, 2, 1, 4];

  function create(opts) {
    opts = opts || {};
    const palette = opts.palette || new Uint32Array(128);

    /* =====================================================================
       Memória e cartucho
       ===================================================================== */
    const ram = new Uint8Array(128);
    let rom = new Uint8Array(4096);
    let romMask = 0x0fff;
    let banking = 'flat';        // flat | F8 | F6 | F4 | E0 | FE | F8SC
    let bank = 0;                // banco corrente (offset em bytes)
    let bankCount = 1;
    let extraRam = null;         // superchip
    let e0Slice = [0, 0, 0, 7];  // E0: quatro fatias de 1K

    function loadROM(bytes) {
      const n = bytes.length;
      rom = new Uint8Array(bytes);
      extraRam = null;
      bank = 0;
      if (n <= 2048) {
        banking = 'flat';
        romMask = n - 1;
        bankCount = 1;
      } else if (n === 4096) {
        banking = 'flat';
        romMask = 0x0fff;
        bankCount = 1;
      } else if (n === 8192) {
        banking = 'F8';
        romMask = 0x0fff;
        bankCount = 2;
        bank = 4096;             // F8 liga no banco 1
      } else if (n === 12288) {
        banking = 'FE';
        romMask = 0x0fff;
        bankCount = 3;
      } else if (n === 16384) {
        banking = 'F6';
        romMask = 0x0fff;
        bankCount = 4;
      } else if (n === 32768) {
        banking = 'F4';
        romMask = 0x0fff;
        bankCount = 8;
      } else {
        banking = 'flat';
        romMask = (1 << Math.ceil(Math.log2(Math.max(n, 2)))) - 1;
        bankCount = 1;
      }
      reset();
    }

    function cartRead(a) {
      const off = a & 0x0fff;
      if (banking === 'E0') {
        const slice = e0Slice[off >> 10];
        return rom[(slice << 10) | (off & 0x3ff)];
      }
      if (extraRam) {
        if (off < 0x80) { extraRam[off] = 0; return 0; }        // janela de escrita
        if (off < 0x100) return extraRam[off - 0x80];
      }
      cartHotspot(off);
      return rom[bank + (off & romMask)];
    }

    function cartWrite(a, v) {
      const off = a & 0x0fff;
      if (extraRam && off < 0x80) { extraRam[off] = v; return; }
      cartHotspot(off);
    }

    function cartHotspot(off) {
      switch (banking) {
        case 'F8': if (off === 0xff8) bank = 0; else if (off === 0xff9) bank = 4096; break;
        case 'F6': if (off >= 0xff6 && off <= 0xff9) bank = (off - 0xff6) * 4096; break;
        case 'F4': if (off >= 0xff4 && off <= 0xffb) bank = (off - 0xff4) * 4096; break;
        case 'E0': if (off >= 0xfe0 && off <= 0xff7) {
                     const win = (off - 0xfe0) >> 3;
                     e0Slice[win] = (off - 0xfe0) & 7;
                   } break;
        default: break;
      }
    }

    /* =====================================================================
       RIOT 6532 — RAM já está acima; aqui o timer e as portas
       ===================================================================== */
    let timerValue = 0, timerInterval = 1024, timerCount = 0, timerFlag = 0;
    let swcha = 0xff, swchb = 0x3f, swacnt = 0, swbcnt = 0;

    function riotTick() {
      if (timerCount > 0) {
        timerCount--;
      } else {
        timerCount = timerInterval - 1;
        if (timerValue > 0) {
          timerValue--;
        } else {
          timerValue = 0xff;
          timerFlag = 0x80;
          timerInterval = 1;      // depois de estourar, conta de 1 em 1
        }
      }
    }

    function riotRead(a) {
      switch (a & 7) {
        case 0: return swcha & ~swacnt | (0xff & swacnt);
        case 1: return swacnt;
        case 2: return swchb & ~swbcnt | (0xff & swbcnt);
        case 3: return swbcnt;
        case 4: case 6: timerFlag = 0; return timerValue;
        case 5: case 7: { const f = timerFlag; timerFlag = 0; return f; }
        default: return 0;
      }
    }

    function riotWrite(a, v) {
      const r = a & 0x1f;
      if (r === 0x01) { swacnt = v; return; }
      if (r === 0x03) { swbcnt = v; return; }
      if (r >= 0x14 && r <= 0x17) {
        timerInterval = [1, 8, 64, 1024][r - 0x14];
        timerValue = v;
        timerCount = timerInterval - 1;
        timerFlag = 0;
      }
    }

    /* =====================================================================
       TIA
       ===================================================================== */
    const pixels = new Uint32Array(WIDTH * LINES);
    let clock = 0;               // 0..227 dentro da scanline
    let line = 0;                // linha desde o fim do VSYNC
    let frameDone = false;

    let vsync = 0, vblank = 0;
    let colup0 = 0, colup1 = 0, colupf = 0, colubk = 0;
    let ctrlpf = 0, refp0 = 0, refp1 = 0;
    let pf0 = 0, pf1 = 0, pf2 = 0, pfBits = 0;
    let nusiz0 = 0, nusiz1 = 0;
    let grp0 = 0, grp1 = 0, grp0d = 0, grp1d = 0;    // d = cópia atrasada (VDEL)
    let vdelp0 = 0, vdelp1 = 0, vdelbl = 0;
    let enam0 = 0, enam1 = 0, enabl = 0, enabld = 0;
    let resmp0 = 0, resmp1 = 0;
    let p0pos = 0, p1pos = 0, m0pos = 0, m1pos = 0, blpos = 0;
    let hmp0 = 0, hmp1 = 0, hmm0 = 0, hmm1 = 0, hmbl = 0;
    let collision = new Uint8Array(8);
    let inpt = new Uint8Array(6);    // INPT0..5, bit 7
    let wsyncHalt = false;

    function rebuildPF() {
      // 20 bits da metade esquerda: PF0 bits 4..7, PF1 bits 7..0, PF2 bits 0..7
      let b = 0;
      for (let i = 0; i < 4; i++) if (pf0 & (0x10 << i)) b |= 1 << i;
      for (let i = 0; i < 8; i++) if (pf1 & (0x80 >> i)) b |= 1 << (4 + i);
      for (let i = 0; i < 8; i++) if (pf2 & (1 << i)) b |= 1 << (12 + i);
      pfBits = b;
    }

    const signedHM = v => { const s = (v >> 4) & 0x0f; return s > 7 ? s - 16 : s; };
    const wrap = p => ((p % WIDTH) + WIDTH) % WIDTH;

    function resetPos(current) {
      // RESPx durante o HBLANK encosta o objeto na borda; depois disso vale a
      // posição do feixe mais o atraso do pipeline
      return clock < HBLANK ? 3 : wrap(clock - HBLANK + 5);
    }

    function applyHMOVE() {
      p0pos = wrap(p0pos - signedHM(hmp0));
      p1pos = wrap(p1pos - signedHM(hmp1));
      m0pos = wrap(m0pos - signedHM(hmm0));
      m1pos = wrap(m1pos - signedHM(hmm1));
      blpos = wrap(blpos - signedHM(hmbl));
    }

    function tiaWrite(reg, v) {
      switch (reg) {
        case VSYNC:
          if ((v & 2) && !vsync) { /* começou o pulso */ }
          if (!(v & 2) && vsync) { line = 0; frameDone = true; }
          vsync = v & 2;
          break;
        case VBLANK:
          vblank = v & 2;
          if (v & 0x40) { inpt[4] |= 0x80; inpt[5] |= 0x80; }   // latches desligados
          break;
        case WSYNC: wsyncHalt = true; break;
        case RSYNC: clock = 0; break;
        case NUSIZ0: nusiz0 = v; break;
        case NUSIZ1: nusiz1 = v; break;
        case COLUP0: colup0 = v & 0xfe; break;
        case COLUP1: colup1 = v & 0xfe; break;
        case COLUPF: colupf = v & 0xfe; break;
        case COLUBK: colubk = v & 0xfe; break;
        case CTRLPF: ctrlpf = v; break;
        case REFP0: refp0 = v & 8; break;
        case REFP1: refp1 = v & 8; break;
        case PF0: pf0 = v; rebuildPF(); break;
        case PF1: pf1 = v; rebuildPF(); break;
        case PF2: pf2 = v; rebuildPF(); break;
        case RESP0: p0pos = resetPos(); break;
        case RESP1: p1pos = resetPos(); break;
        case RESM0: m0pos = resetPos(); break;
        case RESM1: m1pos = resetPos(); break;
        case RESBL: blpos = resetPos(); break;
        case AUDC0: aud[0].c = v & 0x0f; break;
        case AUDC1: aud[1].c = v & 0x0f; break;
        case AUDF0: aud[0].f = v & 0x1f; break;
        case AUDF1: aud[1].f = v & 0x1f; break;
        case AUDV0: aud[0].v = v & 0x0f; break;
        case AUDV1: aud[1].v = v & 0x0f; break;
        case GRP0: grp0 = v; grp1d = grp1; break;    // escrever GRP0 transfere GRP1
        case GRP1: grp1 = v; grp0d = grp0; enabld = enabl; break;
        case ENAM0: enam0 = v & 2; break;
        case ENAM1: enam1 = v & 2; break;
        case ENABL: enabl = v & 2; break;
        case HMP0: hmp0 = v; break;
        case HMP1: hmp1 = v; break;
        case HMM0: hmm0 = v; break;
        case HMM1: hmm1 = v; break;
        case HMBL: hmbl = v; break;
        case VDELP0: vdelp0 = v & 1; break;
        case VDELP1: vdelp1 = v & 1; break;
        case VDELBL: vdelbl = v & 1; break;
        case RESMP0: resmp0 = v & 2; break;
        case RESMP1: resmp1 = v & 2; break;
        case HMOVE: applyHMOVE(); break;
        case HMCLR: hmp0 = hmp1 = hmm0 = hmm1 = hmbl = 0; break;
        case CXCLR: collision.fill(0); break;
        default: break;
      }
    }

    function tiaRead(a) {
      const r = a & 0x0f;
      if (r < 8) return collision[r];
      if (r < 14) return inpt[r - 8];
      return 0;
    }

    /* --- desenho de um pixel ---------------------------------------------- */
    function playerBit(gr, pos, nusiz, refl, x) {
      const scale = PLAYER_SCALE[nusiz & 7];
      const copies = COPIES[nusiz & 7];
      for (let i = 0; i < copies.length; i++) {
        const d = wrap(x - pos - copies[i]);
        if (d < 8 * scale) {
          const idx = (d / scale) | 0;
          return (gr >> (refl ? idx : 7 - idx)) & 1;
        }
      }
      return 0;
    }

    function blobBit(pos, size, nusiz, x, useCopies) {
      const copies = useCopies ? COPIES[nusiz & 7] : [0];
      for (let i = 0; i < copies.length; i++) {
        if (wrap(x - pos - copies[i]) < size) return 1;
      }
      return 0;
    }

    function renderPixel(x) {
      // playfield
      const half = x < 80;
      let col = (x >> 2);
      if (!half) col = (ctrlpf & 1) ? 39 - (x >> 2) : (x >> 2) - 20;
      const pf = (pfBits >> (half ? col : col)) & 1;

      const g0 = vdelp0 ? grp0d : grp0;
      const g1 = vdelp1 ? grp1d : grp1;
      const p0 = playerBit(g0, p0pos, nusiz0, refp0, x);
      const p1 = playerBit(g1, p1pos, nusiz1, refp1, x);
      const m0 = (enam0 && !resmp0) ? blobBit(m0pos, 1 << ((nusiz0 >> 4) & 3), nusiz0, x, true) : 0;
      const m1 = (enam1 && !resmp1) ? blobBit(m1pos, 1 << ((nusiz1 >> 4) & 3), nusiz1, x, true) : 0;
      const blOn = vdelbl ? enabld : enabl;
      const bl = blOn ? blobBit(blpos, 1 << ((ctrlpf >> 4) & 3), 0, x, false) : 0;

      // colisões
      if (m0 && p1) collision[0] |= 0x80;
      if (m0 && p0) collision[0] |= 0x40;
      if (m1 && p0) collision[1] |= 0x80;
      if (m1 && p1) collision[1] |= 0x40;
      if (p0 && pf) collision[2] |= 0x80;
      if (p0 && bl) collision[2] |= 0x40;
      if (p1 && pf) collision[3] |= 0x80;
      if (p1 && bl) collision[3] |= 0x40;
      if (m0 && pf) collision[4] |= 0x80;
      if (m0 && bl) collision[4] |= 0x40;
      if (m1 && pf) collision[5] |= 0x80;
      if (m1 && bl) collision[5] |= 0x40;
      if (bl && pf) collision[6] |= 0x80;
      if (p0 && p1) collision[7] |= 0x80;
      if (m0 && m1) collision[7] |= 0x40;

      // prioridade
      const pfColor = (ctrlpf & 2) ? (half ? colup0 : colup1) : colupf;   // modo score
      if (ctrlpf & 4) {
        if (bl || pf) return pfColor;
        if (p0 || m0) return colup0;
        if (p1 || m1) return colup1;
      } else {
        if (p0 || m0) return colup0;
        if (p1 || m1) return colup1;
        if (bl || pf) return pfColor;
      }
      return colubk;
    }

    /* --- áudio ------------------------------------------------------------ */
    const aud = [
      { c: 0, f: 0, v: 0, div: 0, p4: 1, p5: 1, p9: 1, out: 1, d31: 0, d6: 0, o6: 1 },
      { c: 0, f: 0, v: 0, div: 0, p4: 1, p5: 1, p9: 1, out: 1, d31: 0, d6: 0, o6: 1 },
    ];
    let audioBuf = new Float32Array(4096);
    let audioLen = 0;
    let audioClock = 0;

    function poly4(ch) { const b = ((ch.p4 ^ (ch.p4 >> 1)) & 1); ch.p4 = (ch.p4 >> 1) | (b << 3); return ch.p4 & 1; }
    function poly5(ch) { const b = ((ch.p5 ^ (ch.p5 >> 2)) & 1); ch.p5 = (ch.p5 >> 1) | (b << 4); return ch.p5 & 1; }
    function poly9(ch) { const b = ((ch.p9 ^ (ch.p9 >> 4)) & 1); ch.p9 = (ch.p9 >> 1) | (b << 8); return ch.p9 & 1; }

    function audioStep(ch) {
      if (++ch.div <= ch.f) return;
      ch.div = 0;
      const c = ch.c;
      // divisores auxiliares
      let tick31 = false, tick6 = false;
      ch.d31 = (ch.d31 + 1) % 31;
      tick31 = ch.d31 === 0 || ch.d31 === 18;      // 31 em dois trechos, ~onda quadrada
      if (++ch.d6 >= 3) { ch.d6 = 0; tick6 = true; }

      switch (c) {
        case 0x0: case 0xb: ch.out = 1; break;
        case 0x1: ch.out = poly4(ch); break;
        case 0x2: if (tick31) ch.out = poly4(ch); break;
        case 0x3: if (poly5(ch)) ch.out = poly4(ch); break;
        case 0x4: case 0x5: ch.out ^= 1; break;
        case 0x6: case 0xa: if (tick31) ch.out ^= 1; break;
        case 0x7: case 0x9: ch.out = poly5(ch); break;
        case 0x8: ch.out = poly9(ch); break;
        case 0xc: case 0xd: if (tick6) ch.out ^= 1; break;
        case 0xe: if (tick31 && tick6) ch.out ^= 1; break;
        case 0xf: if (poly5(ch) && tick6) ch.out ^= 1; break;
        default: ch.out = 1; break;
      }
    }

    function audioSample() {
      audioStep(aud[0]);
      audioStep(aud[1]);
      const s = (aud[0].out * aud[0].v + aud[1].out * aud[1].v) / 30 - 0.5;
      if (audioLen < audioBuf.length) audioBuf[audioLen++] = s * 0.6;
    }

    /* --- um color clock ---------------------------------------------------- */
    let riotPhase = 0;

    function tiaTick() {
      // o RIOT anda uma vez a cada três color clocks, sempre pelo mesmo
      // caminho — durante a CPU e durante a parada do WSYNC
      if (++riotPhase >= 3) { riotPhase = 0; riotTick(); }

      if (clock >= HBLANK) {
        const x = clock - HBLANK;
        const c = vblank ? 0 : renderPixel(x);
        if (line < LINES) pixels[line * WIDTH + x] = palette[c >> 1];
        if (resmp0) m0pos = wrap(p0pos + 4);
        if (resmp1) m1pos = wrap(p1pos + 4);
      }
      if (++clock >= CLOCKS_PER_LINE) {
        clock = 0;
        if (line < LINES) line++;
      }
      if (++audioClock >= CLOCKS_PER_AUDIO) { audioClock = 0; audioSample(); }
    }

    /* =====================================================================
       Barramento
       ===================================================================== */
    function busRead(a) {
      a &= 0x1fff;
      if (a & 0x1000) return cartRead(a);
      if ((a & 0x80) === 0) return tiaRead(a);
      if (a & 0x200) return riotRead(a);
      return ram[a & 0x7f];
    }

    function busWrite(a, v) {
      a &= 0x1fff;
      if (a & 0x1000) { cartWrite(a, v); return; }
      if ((a & 0x80) === 0) { tiaWrite(a & 0x3f, v); return; }
      if (a & 0x200) { riotWrite(a, v); return; }
      ram[a & 0x7f] = v;
    }

    /* =====================================================================
       CPU 6507
       ===================================================================== */
    let A = 0, X = 0, Y = 0, S = 0xfd, PC = 0;
    const unknownOps = {};        // opcodes não implementados que a ROM usou
    let fC = 0, fZ = 0, fI = 1, fD = 0, fV = 0, fN = 0;
    let cycles = 0;

    function tick() {
      cycles++;
      // A CPU fica parada do WSYNC até o começo da próxima scanline; o relógio
      // corre. A espera é aqui, ANTES dos três color clocks deste ciclo: o
      // ciclo que reacorda a CPU ainda tem que acontecer inteiro depois da
      // linha virar. Cobrar os três clocks antes da espera adiantava tudo em um
      // ciclo, e aí a rotina clássica de posicionar (WSYNC, laço de -15, RESPx,
      // HMOVE) escrevia o RESPx cedo demais no primeiro bloco: o objeto saltava
      // uns pixels para trás a cada 15 colunas de movimento.
      if (wsyncHalt) {
        while (clock !== 0) tiaTick();
        wsyncHalt = false;
      }
      tiaTick(); tiaTick(); tiaTick();
    }

    const rd = a => { tick(); return busRead(a); };
    const wr = (a, v) => { tick(); busWrite(a, v); };

    const setZN = v => { fZ = (v & 0xff) === 0 ? 1 : 0; fN = (v >> 7) & 1; };
    const packP = () => (fN << 7) | (fV << 6) | 0x20 | (fD << 3) | (fI << 2) | (fZ << 1) | fC;
    const unpackP = p => { fN = (p >> 7) & 1; fV = (p >> 6) & 1; fD = (p >> 3) & 1; fI = (p >> 2) & 1; fZ = (p >> 1) & 1; fC = p & 1; };

    const push = v => { wr(0x100 | S, v); S = (S - 1) & 0xff; };
    const pull = () => { S = (S + 1) & 0xff; return rd(0x100 | S); };

    /* modos de endereçamento — cada um consome os ciclos de barramento certos */
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
      const t = (PC + (off < 0x80 ? off : off - 256)) & 0xffff;
      if ((t ^ PC) & 0xff00) tick();
      PC = t;
    }

    function adc(v) {
      if (fD) {
        let lo = (A & 0x0f) + (v & 0x0f) + fC;
        let hi = (A >> 4) + (v >> 4);
        if (lo > 9) { lo += 6; hi++; }
        fZ = ((A + v + fC) & 0xff) === 0 ? 1 : 0;
        fN = (hi >> 3) & 1;
        fV = 0;
        if (hi > 9) hi += 6;
        fC = hi > 15 ? 1 : 0;
        A = ((hi << 4) | (lo & 0x0f)) & 0xff;
      } else {
        const r = A + v + fC;
        fV = (~(A ^ v) & (A ^ r) & 0x80) ? 1 : 0;
        fC = r > 0xff ? 1 : 0;
        A = r & 0xff;
        setZN(A);
      }
    }

    function sbc(v) {
      if (fD) {
        const r = A - v - (1 - fC);
        let lo = (A & 0x0f) - (v & 0x0f) - (1 - fC);
        let hi = (A >> 4) - (v >> 4);
        if (lo & 0x10) { lo -= 6; hi--; }
        if (hi & 0x10) hi -= 6;
        fC = r >= 0 ? 1 : 0;
        fV = ((A ^ v) & (A ^ (r & 0xff)) & 0x80) ? 1 : 0;
        setZN(r & 0xff);
        A = ((hi << 4) | (lo & 0x0f)) & 0xff;
      } else {
        adc(v ^ 0xff);
      }
    }

    const cmp = (r, v) => { const t = r - v; fC = t >= 0 ? 1 : 0; setZN(t & 0xff); };

    function step() {
      const op = rd(PC++);
      let a, v;
      switch (op) {
        /* --- carga e armazenamento --- */
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

        /* --- transferências --- */
        case 0xaa: tick(); X = A; setZN(X); break;
        case 0xa8: tick(); Y = A; setZN(Y); break;
        case 0x8a: tick(); A = X; setZN(A); break;
        case 0x98: tick(); A = Y; setZN(A); break;
        case 0xba: tick(); X = S; setZN(X); break;
        case 0x9a: tick(); S = X; break;

        /* --- pilha --- */
        case 0x48: tick(); push(A); break;
        case 0x08: tick(); push(packP() | 0x10); break;
        case 0x68: tick(); tick(); A = pull(); setZN(A); break;
        case 0x28: tick(); tick(); unpackP(pull()); break;

        /* --- lógica --- */
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

        case 0x24: v = rd(aZp()); fZ = (A & v) === 0 ? 1 : 0; fN = (v >> 7) & 1; fV = (v >> 6) & 1; break;
        case 0x2c: v = rd(aAbs()); fZ = (A & v) === 0 ? 1 : 0; fN = (v >> 7) & 1; fV = (v >> 6) & 1; break;

        /* --- aritmética --- */
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

        case 0xc9: cmp(A, rd(aImm())); break;
        case 0xc5: cmp(A, rd(aZp())); break;
        case 0xd5: cmp(A, rd(aZpX())); break;
        case 0xcd: cmp(A, rd(aAbs())); break;
        case 0xdd: cmp(A, rd(aAbsX(0))); break;
        case 0xd9: cmp(A, rd(aAbsY(0))); break;
        case 0xc1: cmp(A, rd(aIndX())); break;
        case 0xd1: cmp(A, rd(aIndY(0))); break;

        case 0xe0: cmp(X, rd(aImm())); break;
        case 0xe4: cmp(X, rd(aZp())); break;
        case 0xec: cmp(X, rd(aAbs())); break;
        case 0xc0: cmp(Y, rd(aImm())); break;
        case 0xc4: cmp(Y, rd(aZp())); break;
        case 0xcc: cmp(Y, rd(aAbs())); break;

        /* --- incremento e decremento --- */
        case 0xe6: a = aZp(); v = rd(a); wr(a, v); v = (v + 1) & 0xff; wr(a, v); setZN(v); break;
        case 0xf6: a = aZpX(); v = rd(a); wr(a, v); v = (v + 1) & 0xff; wr(a, v); setZN(v); break;
        case 0xee: a = aAbs(); v = rd(a); wr(a, v); v = (v + 1) & 0xff; wr(a, v); setZN(v); break;
        case 0xfe: a = aAbsX(1); v = rd(a); wr(a, v); v = (v + 1) & 0xff; wr(a, v); setZN(v); break;
        case 0xc6: a = aZp(); v = rd(a); wr(a, v); v = (v - 1) & 0xff; wr(a, v); setZN(v); break;
        case 0xd6: a = aZpX(); v = rd(a); wr(a, v); v = (v - 1) & 0xff; wr(a, v); setZN(v); break;
        case 0xce: a = aAbs(); v = rd(a); wr(a, v); v = (v - 1) & 0xff; wr(a, v); setZN(v); break;
        case 0xde: a = aAbsX(1); v = rd(a); wr(a, v); v = (v - 1) & 0xff; wr(a, v); setZN(v); break;
        case 0xe8: tick(); X = (X + 1) & 0xff; setZN(X); break;
        case 0xc8: tick(); Y = (Y + 1) & 0xff; setZN(Y); break;
        case 0xca: tick(); X = (X - 1) & 0xff; setZN(X); break;
        case 0x88: tick(); Y = (Y - 1) & 0xff; setZN(Y); break;

        /* --- deslocamentos --- */
        case 0x0a: tick(); fC = (A >> 7) & 1; A = (A << 1) & 0xff; setZN(A); break;
        case 0x06: a = aZp(); v = rd(a); wr(a, v); fC = (v >> 7) & 1; v = (v << 1) & 0xff; wr(a, v); setZN(v); break;
        case 0x16: a = aZpX(); v = rd(a); wr(a, v); fC = (v >> 7) & 1; v = (v << 1) & 0xff; wr(a, v); setZN(v); break;
        case 0x0e: a = aAbs(); v = rd(a); wr(a, v); fC = (v >> 7) & 1; v = (v << 1) & 0xff; wr(a, v); setZN(v); break;
        case 0x1e: a = aAbsX(1); v = rd(a); wr(a, v); fC = (v >> 7) & 1; v = (v << 1) & 0xff; wr(a, v); setZN(v); break;

        case 0x4a: tick(); fC = A & 1; A >>= 1; setZN(A); break;
        case 0x46: a = aZp(); v = rd(a); wr(a, v); fC = v & 1; v >>= 1; wr(a, v); setZN(v); break;
        case 0x56: a = aZpX(); v = rd(a); wr(a, v); fC = v & 1; v >>= 1; wr(a, v); setZN(v); break;
        case 0x4e: a = aAbs(); v = rd(a); wr(a, v); fC = v & 1; v >>= 1; wr(a, v); setZN(v); break;
        case 0x5e: a = aAbsX(1); v = rd(a); wr(a, v); fC = v & 1; v >>= 1; wr(a, v); setZN(v); break;

        case 0x2a: { tick(); const c = fC; fC = (A >> 7) & 1; A = ((A << 1) | c) & 0xff; setZN(A); break; }
        case 0x26: { a = aZp(); v = rd(a); wr(a, v); const c = fC; fC = (v >> 7) & 1; v = ((v << 1) | c) & 0xff; wr(a, v); setZN(v); break; }
        case 0x36: { a = aZpX(); v = rd(a); wr(a, v); const c = fC; fC = (v >> 7) & 1; v = ((v << 1) | c) & 0xff; wr(a, v); setZN(v); break; }
        case 0x2e: { a = aAbs(); v = rd(a); wr(a, v); const c = fC; fC = (v >> 7) & 1; v = ((v << 1) | c) & 0xff; wr(a, v); setZN(v); break; }
        case 0x3e: { a = aAbsX(1); v = rd(a); wr(a, v); const c = fC; fC = (v >> 7) & 1; v = ((v << 1) | c) & 0xff; wr(a, v); setZN(v); break; }

        case 0x6a: { tick(); const c = fC; fC = A & 1; A = (A >> 1) | (c << 7); setZN(A); break; }
        case 0x66: { a = aZp(); v = rd(a); wr(a, v); const c = fC; fC = v & 1; v = (v >> 1) | (c << 7); wr(a, v); setZN(v); break; }
        case 0x76: { a = aZpX(); v = rd(a); wr(a, v); const c = fC; fC = v & 1; v = (v >> 1) | (c << 7); wr(a, v); setZN(v); break; }
        case 0x6e: { a = aAbs(); v = rd(a); wr(a, v); const c = fC; fC = v & 1; v = (v >> 1) | (c << 7); wr(a, v); setZN(v); break; }
        case 0x7e: { a = aAbsX(1); v = rd(a); wr(a, v); const c = fC; fC = v & 1; v = (v >> 1) | (c << 7); wr(a, v); setZN(v); break; }

        /* --- desvios --- */
        case 0x10: branch(!fN); break;
        case 0x30: branch(fN); break;
        case 0x50: branch(!fV); break;
        case 0x70: branch(fV); break;
        case 0x90: branch(!fC); break;
        case 0xb0: branch(fC); break;
        case 0xd0: branch(!fZ); break;
        case 0xf0: branch(fZ); break;

        /* --- saltos --- */
        case 0x4c: PC = aAbs(); break;
        case 0x6c: { const p = aAbs();
                     const lo = rd(p);
                     const hi = rd((p & 0xff00) | ((p + 1) & 0xff));   // bug da página
                     PC = lo | (hi << 8); break; }
        case 0x20: { const lo = rd(PC++); tick();
                     push((PC >> 8) & 0xff); push(PC & 0xff);
                     PC = lo | (rd(PC) << 8); break; }
        case 0x60: tick(); tick(); { const lo = pull(), hi = pull(); PC = ((lo | (hi << 8)) + 1) & 0xffff; } break;
        case 0x40: tick(); tick(); unpackP(pull()); { const lo = pull(), hi = pull(); PC = lo | (hi << 8); } break;
        case 0x00: { PC++; push((PC >> 8) & 0xff); push(PC & 0xff); push(packP() | 0x10);
                     fI = 1; PC = rd(0xfffe) | (rd(0xffff) << 8); break; }

        /* --- flags --- */
        case 0x18: tick(); fC = 0; break;
        case 0x38: tick(); fC = 1; break;
        case 0x58: tick(); fI = 0; break;
        case 0x78: tick(); fI = 1; break;
        case 0xb8: tick(); fV = 0; break;
        case 0xd8: tick(); fD = 0; break;
        case 0xf8: tick(); fD = 1; break;
        case 0xea: tick(); break;

        /* --- opcodes não documentados que os jogos e o DASM usam --- */
        case 0x04: case 0x44: case 0x64: rd(aZp()); break;                       // DOP
        case 0x14: case 0x34: case 0x54: case 0x74: case 0xd4: case 0xf4: rd(aZpX()); break;
        case 0x80: case 0x82: case 0x89: case 0xc2: case 0xe2: rd(aImm()); break;
        case 0x0c: rd(aAbs()); break;                                            // TOP
        case 0x1c: case 0x3c: case 0x5c: case 0x7c: case 0xdc: case 0xfc: rd(aAbsX(0)); break;
        case 0x1a: case 0x3a: case 0x5a: case 0x7a: case 0xda: case 0xfa: tick(); break;

        case 0xa7: A = X = rd(aZp()); setZN(A); break;                            // LAX
        case 0xb7: A = X = rd(aZpY()); setZN(A); break;
        case 0xaf: A = X = rd(aAbs()); setZN(A); break;
        case 0xbf: A = X = rd(aAbsY(0)); setZN(A); break;
        case 0xa3: A = X = rd(aIndX()); setZN(A); break;
        case 0xb3: A = X = rd(aIndY(0)); setZN(A); break;

        // LXA/ATX: instável de verdade, mas o CLEAN_START do macro.h usa `lxa #0`,
        // e com operando zero todas as variantes concordam em A = X = 0. Sem isto
        // o operando virava um BRK e o programa saltava para o vetor de interrupção.
        case 0xab: A = X = rd(aImm()); setZN(A); break;

        case 0x87: wr(aZp(), A & X); break;                                       // SAX
        case 0x97: wr(aZpY(), A & X); break;
        case 0x8f: wr(aAbs(), A & X); break;
        case 0x83: wr(aIndX(), A & X); break;

        // Um opcode que eu não conheça consome o byte e segue. Se ele tinha
        // operando, o fluxo desanda — então registro quais apareceram, para o
        // problema ficar visível em vez de virar um travamento misterioso.
        default: unknownOps[op] = (unknownOps[op] || 0) + 1; tick(); break;
      }
    }

    function reset() {
      ram.fill(0);
      A = X = Y = 0; S = 0xfd;
      fC = fZ = fD = fV = fN = 0; fI = 1;
      clock = 0; line = 0; cycles = 0; riotPhase = 0;
      collision.fill(0);
      inpt.fill(0x80);
      timerValue = 0; timerInterval = 1024; timerCount = 0; timerFlag = 0;
      swcha = 0xff; swchb = 0x3f;
      pixels.fill(0);
      PC = busRead(0xfffc) | (busRead(0xfffd) << 8);
    }

    /* =====================================================================
       Quadro
       ===================================================================== */
    function frame() {
      frameDone = false;
      audioLen = 0;
      let guard = 0;
      while (!frameDone && guard++ < 40000) step();
      return { pixels, lines: Math.min(line || LINES, LINES), audio: audioBuf.subarray(0, audioLen) };
    }

    /* =====================================================================
       Entradas
       ===================================================================== */
    // SWCHA: bits 7..4 = joystick esquerdo (cima, baixo, esq, dir), 0 = pressionado
    const DIR_BIT = { up: 0x10, down: 0x20, left: 0x40, right: 0x80 };
    function joystick(dir, pressed) {
      const b = DIR_BIT[dir];
      if (!b) return;
      if (pressed) swcha &= ~b; else swcha |= b;
    }
    function fire(pressed) { if (pressed) inpt[4] &= 0x7f; else inpt[4] |= 0x80; }
    // SWCHB: bit0 reset, bit1 select, bit3 color, bits 6/7 dificuldade
    function consoleSwitch(name, pressed) {
      const b = { reset: 0x01, select: 0x02 }[name];
      if (b) { if (pressed) swchb &= ~b; else swchb |= b; return; }
      if (name === 'color') { if (pressed) swchb |= 0x08; else swchb &= ~0x08; }
      if (name === 'p0diff') { if (pressed) swchb |= 0x40; else swchb &= ~0x40; }
      if (name === 'p1diff') { if (pressed) swchb |= 0x80; else swchb &= ~0x80; }
    }

    return {
      load: loadROM,
      reset,
      frame,
      joystick,
      fire,
      consoleSwitch,
      pixels,
      get info() {
        return { banking, size: rom.length, cycles, line, pc: PC,
                 unknownOps: Object.keys(unknownOps).map(k => '$' + (+k).toString(16)) };
      },
      get audioRate() { return AUDIO_RATE; },
      WIDTH, LINES,
    };
  }

  return { create, WIDTH, LINES };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = VCS;
