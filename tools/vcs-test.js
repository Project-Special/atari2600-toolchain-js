/* ==========================================================================
   Testes do emulador. Cada caso monta uma ROM minúscula com o montador daqui
   (tools/dasm.js), roda no núcleo (tools/vcs.js) e olha o que saiu na tela —
   sem fixture, sem ROM comercial, sem navegador.

       node tools/vcs-test.js

   Sai com status 1 se algum caso falhar.
   ========================================================================== */

'use strict';

const DASM = require('./dasm.js');
const VCS = require('./vcs.js');

let bad = 0;

function build(name, source) {
  const r = DASM.assemble({ name, source });
  if (!r.ok) {
    const first = r.problems.filter(p => p.kind === 'error')[0];
    throw new Error('a ROM de teste não compilou: ' + (first ? first.line + ': ' + first.message : '?'));
  }
  return r.rom;
}

function run(rom, frames, each) {
  const vcs = VCS.create({ palette: new Uint32Array(128).map((_, i) => i) });
  vcs.load(rom);
  vcs.frame();
  vcs.frame();                        // deixa a ROM assentar
  const out = [];
  for (let f = 0; f < frames; f++) out.push(each(vcs.frame()));
  return out;
}

function check(what, ok, detalhe) {
  console.log((ok ? 'ok     ' : 'FALHOU ') + what + (detalhe ? '  ' + detalhe : ''));
  if (!ok) bad++;
}

/* --- posicionamento horizontal --------------------------------------------
   A rotina clássica: WSYNC, laço subtraindo 15 (cada volta vale 15 color
   clocks), o resto vira o ajuste fino no HMxx, RESPx e HMOVE. É o que quase
   todo jogo do 2600 usa, e o resultado tem que ser uma reta: coluna N para
   X = N. Ela cruza a fronteira do HBLANK no primeiro bloco, então pega
   qualquer erro de um ciclo na hora em que a CPU volta do WSYNC.
   -------------------------------------------------------------------------- */
const POS_ASM = `
        processor 6502
        include "vcs.h"
        include "macro.h"

        seg.u vars
        org $80
xpos    ds 1

        seg code
        org $F000
Start
        CLEAN_START
        lda #0
        sta xpos
Frame
        VERTICAL_SYNC
        lda #2
        sta VBLANK
        lda xpos
        ldx #0
        jsr PosObject
        ldy #28
.vb     sta WSYNC
        dey
        bne .vb
        lda #$0E
        sta COLUP0
        lda #$FF
        sta GRP0
        lda #0
        sta COLUBK
        sta VBLANK
        ldy #192
.vis    sta WSYNC
        dey
        bne .vis
        lda #0
        sta GRP0
        lda #2
        sta VBLANK
        ldy #29
.os     sta WSYNC
        dey
        bne .os
        inc xpos
        jmp Frame

PosObject SUBROUTINE
        sec
        sta WSYNC
.divide
        sbc #15
        bcs .divide
        eor #7
        asl
        asl
        asl
        asl
        sta HMP0,x
        sta RESP0,x
        sta WSYNC
        sta HMOVE
        rts

        org $FFFC
        .word Start
        .word Start
`;

function testaPosicionamento() {
  const rom = build('pos.asm', POS_ASM);
  const alvo = 0x0e >> 1;
  const cols = run(rom, 120, out => {
    const line = Math.floor(out.lines / 2);
    const row = out.pixels.subarray(line * VCS.WIDTH, (line + 1) * VCS.WIDTH);
    for (let x = 0; x < VCS.WIDTH; x++) if (row[x] === alvo) return x;
    return -1;
  });

  // X de 0 a 2 encosta na borda esquerda: a rotina não alcança essas colunas
  const util = cols.slice(4);
  const passos = util.slice(1).map((v, i) => v - util[i]);
  const tortos = passos.map((p, i) => (p === 1 ? null : 'X=' + (i + 5) + ' andou ' + p))
                       .filter(Boolean);
  check('posicionamento anda 1 pixel por coluna',
        tortos.length === 0,
        tortos.length ? tortos.slice(0, 4).join(', ') : util.length + ' colunas seguidas');

  const some = cols.filter(c => c < 0).length;
  check('o sprite aparece em todos os quadros', some === 0, some ? some + ' quadro(s) sem sprite' : '');
}

/* --- a CPU volta do WSYNC no lugar certo -----------------------------------
   Depois do WSYNC o primeiro ciclo da CPU tem que acontecer inteiro dentro da
   linha nova, terminando no color clock 3. Aqui o RESP0 é o 23o ciclo depois
   da volta, ou seja o clock 69 — um clock além do HBLANK, que tem 68. Então o
   objeto cai em 69 - 68 + 5 = 6.

   Se a CPU voltar um ciclo adiantada, esse mesmo RESP0 cai no clock 66, ainda
   dentro do HBLANK, e o objeto encosta na coluna 3. Era esse ciclo a mais que
   fazia o sprite pular para trás a cada 15 colunas de movimento.
   -------------------------------------------------------------------------- */
const HBLANK_ASM = `
        processor 6502
        include "vcs.h"
        include "macro.h"
        seg code
        org $F000
Start
        CLEAN_START
Frame
        VERTICAL_SYNC
        lda #2
        sta VBLANK
        ldy #30
.vb     sta WSYNC
        dey
        bne .vb
        lda #$0E
        sta COLUP0
        lda #$FF
        sta GRP0
        lda #0
        sta COLUBK
        sta VBLANK
        sta WSYNC
        nop                     ; 20 ciclos de nop; com o sta, o RESP0 é o 23o
        nop
        nop
        nop
        nop
        nop
        nop
        nop
        nop
        nop
        sta RESP0
        ldy #190
.vis    sta WSYNC
        dey
        bne .vis
        lda #0
        sta GRP0
        lda #2
        sta VBLANK
        ldy #29
.os     sta WSYNC
        dey
        bne .os
        jmp Frame
        org $FFFC
        .word Start
        .word Start
`;

function testaHblank() {
  const rom = build('hblank.asm', HBLANK_ASM);
  const alvo = 0x0e >> 1;
  const cols = run(rom, 4, out => {
    const line = Math.floor(out.lines / 2);
    const row = out.pixels.subarray(line * VCS.WIDTH, (line + 1) * VCS.WIDTH);
    for (let x = 0; x < VCS.WIDTH; x++) if (row[x] === alvo) return x;
    return -1;
  });
  const todos = cols.every(c => c === 6);
  check('a CPU volta do WSYNC no ciclo certo', todos,
        todos ? 'RESP0 no clock 69 cai na coluna 6'
              : 'esperava coluna 6, deu ' + [...new Set(cols)].join(',') +
                (cols.every(c => c === 3) ? ' — a CPU está voltando um ciclo adiantada' : ''));
}

testaPosicionamento();
testaHblank();

console.log(bad ? bad + ' caso(s) falhando' : 'emulador ok');
process.exit(bad ? 1 : 0);
