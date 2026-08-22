/* ==========================================================================
   Testes do emulador de NES.

   Cada caso monta uma ROM .nes minuscula com o montador daqui (tools/dasm.js)
   e roda no nucleo (tools/nes.js), conferindo o que saiu na tela. Sem ROM
   comercial, sem fixture: o fonte de teste esta neste arquivo.

       node tools/nes-test.js

   O arquivo .nes e montado num pedaco so: o cabecalho iNES em $0000, os 16K
   de PRG logo atras e os 8K de CHR no fim. O RORG do DASM e que faz o codigo
   ser montado para $C000 (onde a CPU enxerga) enquanto e gravado no offset do
   arquivo.
   ========================================================================== */

'use strict';

const DASM = require('./dasm.js');
const NES = require('./nes.js');

let bad = 0;

function check(what, ok, detalhe) {
  console.log((ok ? 'ok     ' : 'FALHOU ') + what + (detalhe ? '  ' + detalhe : ''));
  if (!ok) bad++;
}

function build(name, source) {
  const r = DASM.assemble({ name, source });
  if (!r.ok) {
    const e = r.problems.filter(p => p.kind === 'error');
    throw new Error('a ROM de teste nao compilou: ' +
      e.slice(0, 3).map(p => p.line + ': ' + p.message).join(' | '));
  }
  return r.rom;
}

/* cor da paleta mestra, como o emulador entrega (0xRRGGBB) */
const cor = i => NES.MASTER[i & 0x3f];

/* ==========================================================================
   Caso 1: fundo, paleta e sprite
   ========================================================================== */
const TELA = `
        processor 6502

; --- cabecalho iNES ---------------------------------------------------------
        seg header
        org $0000
        .byte "NES", $1A
        .byte 1                 ; 1 x 16K de PRG
        .byte 1                 ; 1 x  8K de CHR
        .byte 0                 ; mapper 0, espelhamento horizontal
        ds 9

; --- PRG: gravado no offset $0010, montado para $C000 -----------------------
        seg prg
        org $0010
        rorg $C000

Reset
        sei
        cld
        ldx #$40
        stx $4017               ; cala o IRQ do contador de quadros da APU
        ldx #$FF
        txs
        inx                     ; X = 0
        stx $2000               ; PPUCTRL = 0
        stx $2001               ; PPUMASK = 0

.warm1  bit $2002               ; a PPU so aceita comando depois de dois vblanks
        bpl .warm1
.warm2  bit $2002
        bpl .warm2

        ; --- paleta ---
        bit $2002               ; zera o alternador de $2006
        lda #$3F
        sta $2006
        lda #$00
        sta $2006
        ldx #0
.pal    lda Palette,x
        sta $2007
        inx
        cpx #32
        bne .pal

        ; --- tabela de nomes: tres faixas de oito linhas, uma por cor ---
        bit $2002
        lda #$20
        sta $2006
        lda #$00
        sta $2006

        ldy #1                  ; faixa 1: tile 1
        jsr Row
        ldy #2
        jsr Row
        ldy #3
        jsr Row

        ldy #0                  ; o resto da tela fica no tile vazio:
        lda #3                  ; 960 - 96 = 864 = 3 x 256 + 96
        sta $12
.big    ldx #0
.b256   sty $2007
        inx
        bne .b256
        dec $12
        bne .big
        ldx #96
.b96    sty $2007
        dex
        bne .b96

        ; --- atributos: tudo na paleta 0 ---
        bit $2002
        lda #$23
        sta $2006
        lda #$C0
        sta $2006
        lda #0
        ldx #64
.attr   sta $2007
        dex
        bne .attr

        ; --- zera a rolagem ---
        ; Escrever em $2006 mexe no mesmo registrador interno que guarda a
        ; rolagem, entao sem isto a tela sai deslocada. Todo jogo faz isto
        ; depois de escrever na VRAM e antes de ligar o desenho.
        bit $2002
        lda #0
        sta $2005
        sta $2005

        ; --- sprite 0: tile 3, em (64, 32) ---
        lda #31                 ; a PPU desenha o sprite uma linha abaixo do Y
        sta $0200
        lda #3
        sta $0201
        lda #0
        sta $0202               ; paleta 4, na frente do fundo
        lda #64
        sta $0203
        lda #$FF                ; os outros 63 sprites saem da tela
        ldx #4
.hide   sta $0200,x
        inx
        bne .hide

        lda #$02
        sta $4014               ; DMA da OAM

        ; --- liga o desenho ---
        lda #$00
        sta $2000               ; tabelas em $2000, padroes em $0000
        lda #%00011110          ; fundo e sprites, inclusive nos 8 da esquerda
        sta $2001

Loop    jmp Loop

; escreve 32 tiles iguais (uma linha da tabela de nomes)
Row SUBROUTINE
        ldx #32
.put    sty $2007
        dex
        bne .put
        rts

Palette
        .byte $0F, $16, $2A, $12    ; fundo: preto, vermelho, verde, azul
        .byte $0F, $01, $02, $03
        .byte $0F, $04, $05, $06
        .byte $0F, $07, $08, $09
        .byte $0F, $06, $16, $30    ; sprite: a cor 3 e branco
        .byte $0F, $0A, $0B, $0C
        .byte $0F, $0D, $0E, $11
        .byte $0F, $13, $14, $15

; Os vetores moram no fim dos 16K. O org diz onde cai no arquivo; o rorg diz
; para que endereco a CPU vai enxergar: $0010 + ($FFFA - $C000) = $400A.
        org $400A
        rorg $FFFA
        .word Reset, Reset, Reset

; --- CHR: 8K, gravado no fim do arquivo -------------------------------------
        seg chr
        org $4010
        ds 16                   ; tile 0: vazio
        ds 8, $FF               ; tile 1: so o plano 0  -> cor 1
        ds 8, $00
        ds 8, $00               ; tile 2: so o plano 1  -> cor 2
        ds 8, $FF
        ds 8, $FF               ; tile 3: os dois       -> cor 3
        ds 8, $FF
        org $6010               ; completa os 8K
`;

function testaTela() {
  const rom = build('tela.nes', TELA);
  check('o .nes tem o tamanho certo', rom.length === 16 + 16384 + 8192,
        rom.length + ' bytes (16 + 16384 + 8192 = 24592)');

  const nes = NES.create();
  nes.load(rom);
  let out;
  for (let i = 0; i < 8; i++) out = nes.frame();

  const px = (x, y) => out.pixels[y * NES.WIDTH + x];
  const info = nes.info;

  check('a CPU nao achou opcode desconhecido', info.unknownOps.length === 0,
        info.unknownOps.join(',') || '');

  check('faixa 1 do fundo saiu vermelha', px(10, 4) === cor(0x16),
        '$' + px(10, 4).toString(16));
  check('faixa 2 do fundo saiu verde', px(10, 12) === cor(0x2a),
        '$' + px(10, 12).toString(16));
  check('faixa 3 do fundo saiu azul', px(10, 20) === cor(0x12),
        '$' + px(10, 20).toString(16));
  check('abaixo das faixas fica a cor de fundo', px(10, 100) === cor(0x0f),
        '$' + px(10, 100).toString(16));

  /* o sprite 0 esta em (64,32) com o tile 3 -> cor 3 da paleta 4 = branco */
  const dentro = px(66, 34) === cor(0x30);
  const fora = px(80, 34) === cor(0x0f);
  check('o sprite 0 apareceu onde devia', dentro && fora,
        'dentro $' + px(66, 34).toString(16) + ', fora $' + px(80, 34).toString(16));

  return out;
}

/* ==========================================================================
   Caso 2: rolagem. Escrever em $2005 tem que deslocar o fundo.
   ========================================================================== */
function testaRolagem() {
  /* Com rolagem vertical de 8, a tela comeca uma linha de tiles mais abaixo:
     a faixa vermelha sai de cena, a verde sobe para o topo e a azul vem atras. */
  const rom = build('rolagem.nes', TELA.replace(
    'Loop    jmp Loop',
    `Loop
        bit $2002               ; espera o vblank
        bpl Loop
        bit $2002               ; zera o alternador de $2005
        lda #0
        sta $2005               ; rolagem horizontal = 0
        lda #8
        sta $2005               ; rolagem vertical = 8
        jmp Loop`));

  const nes = NES.create();
  nes.load(rom);
  let out;
  for (let f = 0; f < 8; f++) out = nes.frame();
  const px = (x, y) => out.pixels[y * NES.WIDTH + x];

  check('rolagem vertical de 8 sobe o fundo uma linha de tiles',
        px(10, 2) === cor(0x2a) && px(10, 10) === cor(0x12),
        'topo $' + px(10, 2).toString(16) + ', abaixo $' + px(10, 10).toString(16) +
        ' (esperado verde $' + cor(0x2a).toString(16) + ' e azul $' + cor(0x12).toString(16) + ')');
}

/* ==========================================================================
   Caso 3: o acerto do sprite 0, que e como quase todo jogo divide a tela
   ========================================================================== */
const SPRITE0 = TELA.replace('Loop    jmp Loop', `
Loop
        bit $2002               ; espera o vblank
        bpl Loop
        lda #0
        sta hit                 ; zera o resultado do quadro
.wait   lda $2002
        and #$40                ; bit 6 = acerto do sprite 0
        beq .wait
        lda #1
        sta hit
        jmp Loop
hit     = $11`);

function testaSprite0() {
  const rom = build('sprite0.nes', SPRITE0);
  const nes = NES.create();
  nes.load(rom);
  for (let i = 0; i < 6; i++) nes.frame();
  /* se o acerto nunca acontecesse, a ROM ficaria presa no laco .wait e o
     emulador estouraria o limite de instrucoes por quadro */
  const info = nes.info;
  check('o acerto do sprite 0 acontece todo quadro', info.frame >= 5 && info.unknownOps.length === 0,
        'quadros: ' + info.frame);
}

/* ==========================================================================
   Caso 4: o cabecalho iNES e lido direito
   ========================================================================== */
function testaCabecalho() {
  const rom = build('tela.nes', TELA);
  const nes = NES.create();
  nes.load(rom);
  const i = nes.info;
  check('cabecalho: mapper 0, 1x16K PRG, 1x8K CHR, espelhamento horizontal',
        i.mapper === 0 && i.prgBankCount === 1 && i.chrBankCount === 1 &&
        i.mirroring === 'horizontal' && !i.chrIsRam,
        JSON.stringify({ mapper: i.mapper, prg: i.prgBankCount, chr: i.chrBankCount, esp: i.mirroring }));

  let erro = null;
  try { NES.create().load(new Uint8Array([1, 2, 3, 4])); } catch (e) { erro = e.message; }
  check('recusa arquivo que nao e .nes', !!erro, erro || '');
}


/* ==========================================================================
   Caso 5: MMC3 -- bancos de CHR e o IRQ por scanline

   A tabela de nomes fica com o mesmo tile 1 na tela inteira. O que muda e o
   banco de CHR: em cima, o tile 1 e um bloco da cor 1; o IRQ do MMC3 dispara
   na linha 120 e troca o banco, entao dali para baixo o mesmo tile 1 vira um
   bloco da cor 2. E assim que os jogos partem a tela sem mexer na VRAM.
   ========================================================================== */
const MMC3 = `
        processor 6502

        seg header
        org $0000
        .byte "NES", $1A
        .byte 2                 ; 2 x 16K de PRG = quatro bancos de 8K
        .byte 1                 ; 1 x  8K de CHR = oito bancos de 1K
        .byte $40               ; mapper 4 (MMC3), espelhamento horizontal
        ds 9

; O ultimo banco de 8K do MMC3 e fixo em $E000, e e onde todo o codigo mora.
; Offset no arquivo: 16 + 32768 - 8192 = $6010.
        seg prg
        org $6010
        rorg $E000

Reset
        sei
        cld
        ldx #$40
        stx $4017
        ldx #$FF
        txs
        inx
        stx $2000
        stx $2001

.warm1  bit $2002
        bpl .warm1
.warm2  bit $2002
        bpl .warm2

        ; --- paleta ---
        bit $2002
        lda #$3F
        sta $2006
        lda #$00
        sta $2006
        ldx #0
.pal    lda Palette,x
        sta $2007
        inx
        cpx #8
        bne .pal

        ; --- a tela inteira com o tile 1 ---
        bit $2002
        lda #$20
        sta $2006
        lda #$00
        sta $2006
        lda #3
        sta $12
        ldy #1
.big    ldx #0
.b256   sty $2007
        inx
        bne .b256
        dec $12
        bne .big
        ldx #192
.b192   sty $2007
        dex
        bne .b192

        ; --- atributos zerados ---
        bit $2002
        lda #$23
        sta $2006
        lda #$C0
        sta $2006
        lda #0
        ldx #64
.attr   sta $2007
        dex
        bne .attr

        ; --- MMC3: R0 aponta para o primeiro conjunto de tiles ---
        jsr SetBankA
        lda #0
        sta $A000               ; espelhamento

        ; --- IRQ na linha 120 ---
        jsr ArmIrq

        bit $2002
        lda #0
        sta $2005
        sta $2005
        lda #$80
        sta $2000               ; NMI ligado
        lda #%00011110
        sta $2001               ; desenho ligado
        cli                     ; abre a porta do IRQ

Loop    jmp Loop

; R0 escolhe um banco de 2K para $0000; o valor e contado em bancos de 1K.
SetBankA SUBROUTINE
        lda #0
        sta $8000               ; escolhe R0, modos zerados
        lda #0
        sta $8001               ; R0 = 0  -> tiles do primeiro conjunto
        rts

SetBankB SUBROUTINE
        lda #0
        sta $8000
        lda #2
        sta $8001               ; R0 = 2  -> tiles do segundo conjunto
        rts

ArmIrq SUBROUTINE
        lda #119                ; conta 120 linhas desenhadas
        sta $C000
        sta $C001               ; recarrega o contador
        sta $E001               ; liga o IRQ
        rts

; A cada quadro o topo volta ao primeiro conjunto e o contador e rearmado.
Nmi SUBROUTINE
        pha
        txa
        pha
        jsr SetBankA
        jsr ArmIrq
        pla
        tax
        pla
        rti

; O IRQ da linha 120 troca o banco: dali para baixo, outro desenho.
Irq SUBROUTINE
        pha
        txa
        pha
        lda #0
        sta $E000               ; confirma e desliga
        jsr SetBankB
        pla
        tax
        pla
        rti

Palette
        .byte $0F, $16, $2A, $12
        .byte $0F, $01, $02, $03

        org $8010 - 6
        rorg $FFFA
        .word Nmi, Reset, Irq

; --- CHR: dois conjuntos de tiles no mesmo indice ---------------------------
        seg chr
        org $8010
        ds 16                   ; tile 0 vazio
        ds 8, $FF               ; tile 1 do conjunto A: plano 0 -> cor 1
        ds 8, $00
        org $8010 + 2048        ; banco de 1K numero 2
        ds 16                   ; tile 0 vazio
        ds 8, $00               ; tile 1 do conjunto B: plano 1 -> cor 2
        ds 8, $FF
        org $A010               ; completa os 8K
`;

function testaMmc3() {
  const rom = build('mmc3.nes', MMC3);
  check('o .nes do MMC3 tem 32K de PRG e 8K de CHR',
        rom.length === 16 + 32768 + 8192, rom.length + ' bytes');

  const nes = NES.create();
  nes.load(rom);
  const i0 = nes.info;
  check('o cabecalho diz MMC3', i0.mapper === 4 && i0.mapperName === 'MMC3',
        'mapper ' + i0.mapper + ' (' + i0.mapperName + ')');

  let out;
  for (let f = 0; f < 10; f++) out = nes.frame();
  const px = (x, y) => out.pixels[y * NES.WIDTH + x];

  check('a CPU rodou sem opcode desconhecido', nes.info.unknownOps.length === 0,
        nes.info.unknownOps.join(',') || '');
  check('em cima da divisao, o tile 1 e o conjunto A', px(100, 40) === cor(0x16),
        '$' + px(100, 40).toString(16) + ' (esperado $' + cor(0x16).toString(16) + ')');
  check('embaixo da divisao, o mesmo tile virou o conjunto B', px(100, 200) === cor(0x2a),
        '$' + px(100, 200).toString(16) + ' (esperado $' + cor(0x2a).toString(16) + ')');

  /* onde exatamente a tela virou */
  let corte = -1;
  for (let y = 1; y < 240; y++) {
    if (px(100, y) !== px(100, y - 1)) { corte = y; break; }
  }
  check('a divisao caiu perto da linha 120', corte >= 112 && corte <= 128,
        'virou na linha ' + corte);
}

/* -------------------------------------------------------------------------- */
testaCabecalho();
testaTela();
testaRolagem();
testaSprite0();
testaMmc3();

console.log(bad ? bad + ' caso(s) falhando' : 'emulador de NES ok');
process.exit(bad ? 1 : 0);
