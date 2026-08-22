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

const fs = require('fs');
const path = require('path');
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

function expectLoadError(what, bytes, expected) {
  try {
    NES.create().load(bytes);
    check(what, false, 'aceitou o arquivo');
  } catch (err) {
    check(what, String(err.message).includes(expected), err.message);
  }
}

function header(flags6, flags7) {
  const bytes = new Uint8Array(16);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 1, 0, flags6, flags7]);
  return bytes;
}

/* O editor pode abrir CHR de ROM com mapper desconhecido, mas o nucleo nunca
   deve executar uma ROM fora da lista: rodar como NROM produz erros silenciosos. */
expectLoadError('recusa mapper nao suportado',
  header(0x50, 0), 'mapper 5');
expectLoadError('recusa espelhamento de quatro telas',
  header(0x08, 0), 'quatro telas');
expectLoadError('recusa arquivo iNES truncado',
  Uint8Array.from([0x4e, 0x45, 0x53, 0x1a, 1, 0]), 'iNES');

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


/* ==========================================================================
   Caso 6: a APU

   A ROM programa o pulso 1 com periodo 253. A conta do NES e
   f = 1789773 / (16 * (periodo + 1)), entao isso da 440,4 Hz -- um la. O teste
   conta as passagens por zero da onda que o emulador entregou e confere se a
   frequencia bate. Depois desliga o canal e confere que ficou mudo.
   ========================================================================== */
const SOM = `
        processor 6502

        seg header
        org $0000
        .byte "NES", $1A
        .byte 1
        .byte 0
        .byte 0
        ds 9

        seg prg
        org $0010
        rorg $C000

Reset
        sei
        cld
        ldx #$FF
        txs

        lda #$40
        sta $4017               ; contador de quadros de quatro passos, sem IRQ
        lda #$0F
        sta $4015               ; liga os quatro canais principais

        ; --- pulso 1: onda quadrada de 50%, volume cheio, sem parar ---
        lda #%10111111          ; duty 50%, duracao travada, volume constante 15
        sta $4000
        lda #%01111111          ; sem varredura
        sta $4001
        lda #253                ; byte baixo do periodo
        sta $4002
        lda #%00001000          ; byte alto = 0, contador de duracao carregado
        sta $4003

Loop    jmp Loop

Mudo                            ; entrada alternativa: nao toca nada
        sei
        cld
        ldx #$FF
        txs
        lda #$40
        sta $4017
        lda #0
        sta $4015               ; todos os canais desligados
.quiet  jmp .quiet

        org $400A
        rorg $FFFA
        .word Reset, Reset, Reset
`;

function frequencia(amostras, taxa) {
  /* conta as viradas de sinal e converte em Hz */
  let cruz = 0, anterior = amostras[0] > 0;
  for (let i = 1; i < amostras.length; i++) {
    const agora = amostras[i] > 0;
    if (agora !== anterior) cruz++;
    anterior = agora;
  }
  return (cruz / 2) * (taxa / amostras.length);
}

function testaApu() {
  const rom = build('som.nes', SOM);
  const nes = NES.create();
  nes.load(rom);

  /* Junta o audio de varios quadros, jogando fora os primeiros: ao ligar, o
     passa-alta ainda esta acomodando o degrau inicial, como no console. */
  const tudo = [];
  for (let f = 0; f < 14; f++) {
    const out = nes.frame();
    if (f < 4) continue;
    for (let i = 0; i < out.audio.length; i++) tudo.push(out.audio[i]);
  }
  check('a APU entregou amostras', tudo.length > 5000, tudo.length + ' amostras');

  const min = Math.min(...tudo), max = Math.max(...tudo);
  check('a onda tem amplitude', max - min > 0.05,
        'de ' + min.toFixed(3) + ' a ' + max.toFixed(3));

  const hz = frequencia(tudo, NES.AUDIO_RATE);
  const alvo = 1789773 / (16 * 254);
  check('o pulso 1 saiu na frequencia certa', Math.abs(hz - alvo) < alvo * 0.05,
        hz.toFixed(1) + ' Hz (esperado ' + alvo.toFixed(1) + ')');

  /* agora a versao muda */
  const romMudo = build('mudo.nes', SOM.replace('.word Reset, Reset, Reset',
                                                '.word Mudo, Mudo, Mudo'));
  const nes2 = NES.create();
  nes2.load(romMudo);
  const quieto = [];
  for (let f = 0; f < 12; f++) {
    const out = nes2.frame();
    if (f < 6) continue;                  // depois do transitorio de ligar
    for (let i = 0; i < out.audio.length; i++) quieto.push(out.audio[i]);
  }
  const varia = Math.max(...quieto) - Math.min(...quieto);
  check('com os canais desligados, fica mudo', varia < 0.001,
        'variacao de ' + varia.toFixed(5));
}

/* ---------------------------------------------------------------------------
   Os exemplos do repositorio, montados do fonte

   Os outros casos aqui usam ROMs escritas dentro deste arquivo, minimas e feitas
   para isolar um comportamento. Estes sao diferentes: pegam os nes-nave-N.asm
   que a pessoa vai abrir na aba Fonte, montam com as diretivas de NES e jogam
   com eles. E o unico teste que cobre o caminho inteiro -- fonte, cabecalho,
   PPU, controle -- do jeito que alguem aprendendo vai usar.

   A serie e numerada de proposito: cada mudanca vira um arquivo novo, e o
   teste roda em todos. Assim uma alteracao no -2 nao pode quebrar o -0 sem
   ninguem notar.
   --------------------------------------------------------------------------- */
function fontesDaSerie() {
  const dir = path.join(__dirname, '..', 'Arq_asm');
  let nomes = [];
  try { nomes = fs.readdirSync(dir); } catch (err) { return []; }
  return nomes.filter(n => /^nes-nave-\d+\.asm$/i.test(n))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10))
    .map(n => path.join(dir, n));
}

/* roda quadros, opcionalmente segurando um botao */
function jogador(n) {
  let out = null;
  return {
    anda(quadros, botao) {
      if (botao) n.setButton(0, botao, true);
      for (let f = 0; f < quadros; f++) out = n.frame();
      if (botao) n.setButton(0, botao, false);
      return out;
    },
    segura(botao, quadros) {
      n.setButton(0, botao, true);
      for (let f = 0; f < quadros; f++) out = n.frame();
      return out;
    },
    solta(botao) { n.setButton(0, botao, false); },
    get tela() { return out; },
  };
}

function testaExemplo(caminho) {
  const nome = path.basename(caminho, '.asm');
  const r = DASM.assemble({ name: nome + '.asm', source: fs.readFileSync(caminho, 'utf8') });
  if (!r.ok) {
    const e = r.problems.filter(p => p.kind === 'error');
    check(nome + ' monta', false, e.slice(0, 2).map(p => p.line + ': ' + p.message).join(' | '));
    return;
  }
  check(nome + ' monta', true, r.size + ' bytes, ' + r.symbols.length + ' símbolos');

  const cab = Array.from(r.rom.slice(0, 8));
  check(nome + ': cabeçalho iNES certo',
    cab[0] === 0x4e && cab[1] === 0x45 && cab[2] === 0x53 && cab[3] === 0x1a &&
    cab[4] === 1 && cab[5] === 1 && (cab[6] & 1) === 1 && (cab[6] >> 4) === 0,
    'prg ' + cab[4] + ' · chr ' + cab[5] + ' · flags6 $' + cab[6].toString(16));
  check(nome + ': tamanho bate com o cabeçalho',
    r.size === 16 + cab[4] * 16384 + cab[5] * 8192, r.size + ' bytes');
  const reset = r.rom[16 + 0x3ffc] | (r.rom[16 + 0x3ffd] << 8);
  check(nome + ': o reset aponta para o código', reset >= 0xc000,
    '$' + reset.toString(16).toUpperCase());

  const n = NES.create();
  n.load(r.rom);
  const j = jogador(n);

  /* a nave e o unico objeto na faixa de ceu: acha a coluna do meio dela */
  const ondeEstaANave = () => {
    const y = 185, ceu = j.tela.pixels[y * 256 + 2];
    let x0 = -1, x1 = -1;
    for (let x = 0; x < 256; x++) {
      if (j.tela.pixels[y * 256 + x] !== ceu) { if (x0 < 0) x0 = x; x1 = x; }
    }
    return x0 < 0 ? -1 : ((x0 + x1) / 2) | 0;
  };
  /* a linha mais alta com algo desenhado acima da nave -- o tiro, quando ha */
  const alturaDoTiro = () => {
    const ceu = j.tela.pixels[10 * 256 + 2];
    for (let y = 16; y < 175; y++) {
      for (let x = 0; x < 256; x++) if (j.tela.pixels[y * 256 + x] !== ceu) return y;
    }
    return -1;
  };

  j.anda(10);
  check(nome + ': o céu é azul', j.tela.pixels[20 * 256 + 128] === cor(0x21),
    '#' + (j.tela.pixels[20 * 256 + 128] >>> 0).toString(16).padStart(6, '0'));
  const chao = new Set();
  for (let x = 0; x < 256; x++) chao.add(j.tela.pixels[215 * 256 + x]);
  check(nome + ': o chão está desenhado, em dois verdes',
    chao.size === 2 && chao.has(cor(0x1a)) && chao.has(cor(0x2a)),
    [...chao].map(c => '#' + (c >>> 0).toString(16).padStart(6, '0')).join(' '));

  const inicio = ondeEstaANave();
  check(nome + ': a nave aparece', inicio > 0, 'coluna ' + inicio);

  j.anda(30, 'right');
  const dir = ondeEstaANave();
  check(nome + ': o controle move para a direita', dir > inicio + 40,
    inicio + ' -> ' + dir + ' (' + (dir - inicio) + ' px em 30 quadros)');

  j.anda(30, 'left');
  check(nome + ': e para a esquerda', ondeEstaANave() < dir - 40, dir + ' -> ' + ondeEstaANave());

  j.anda(400, 'left');
  const borda = ondeEstaANave();
  check(nome + ': para na borda em vez de sair da tela', borda > 0 && borda < 20,
    'coluna ' + borda + ' (X_MIN é 8)');

  j.anda(120);
  check(nome + ': parada, a nave fica onde estava', ondeEstaANave() === borda, 'coluna ' + borda);

  /* o tiro so existe a partir do -1 */
  if (!/BOTAO_A/.test(fs.readFileSync(caminho, 'utf8'))) return;

  check(nome + ': sem apertar nada, não há tiro na tela', alturaDoTiro() === -1,
    'altura ' + alturaDoTiro());

  j.anda(4, 'a');
  const saiu = alturaDoTiro();
  check(nome + ': o A dispara', saiu > 150 && saiu < 175, 'tiro na linha ' + saiu);

  j.anda(10);
  const subiu = alturaDoTiro();
  check(nome + ': o tiro sobe', subiu > 0 && subiu < saiu - 30,
    saiu + ' -> ' + subiu + ' em 10 quadros');

  j.anda(60);
  check(nome + ': e some ao chegar no alto', alturaDoTiro() === -1, 'altura ' + alturaDoTiro());

  /* Segurar o botao nao pode metralhar: se nascesse um tiro por quadro, a
     linha mais alta ficaria parada logo acima da nave em vez de subir. */
  j.segura('a', 6);
  const primeiro = alturaDoTiro();
  for (let f = 0; f < 6; f++) j.anda(1);
  const depois = alturaDoTiro();
  j.solta('a');
  check(nome + ': segurar o A não metralha', depois > 0 && depois < primeiro - 15,
    primeiro + ' -> ' + depois + ' com o botão preso');
}

function testaExemplos() {
  const fontes = fontesDaSerie();
  if (!fontes.length) { check('a série nes-nave-N existe', false, 'nenhum em Arq_asm/'); return; }
  for (const f of fontes) testaExemplo(f);
}

/* -------------------------------------------------------------------------- */
testaCabecalho();
testaTela();
testaRolagem();
testaSprite0();
testaMmc3();
testaApu();
testaExemplos();

console.log(bad ? bad + ' caso(s) falhando' : 'emulador de NES ok');
process.exit(bad ? 1 : 0);
