; =============================================================================
; nes-nave-3.asm -- com som
;
; O que mudou do -2 para ca:
;   * o tiro tem som: um pulso que cai de tom, feito pela varredura da APU
;   * a explosao tem som: um estouro no canal de ruido, morrendo pelo envelope
;   * os dois usam o hardware em vez de mexer no som quadro a quadro -- e por
;     isso que sao cinco escritas cada um, e nao uma rotina de som
;   * o $4017 passou a ser escrito no arranque, desligando a interrupcao da APU
;
; O -0 e o mesmo programa que o nave.asm do 2600, para os dois serem lidos em
; par. Daqui em diante os numeros contam o que foi mudando -- diff entre dois
; deles e a explicacao mais curta que existe.
;
; No 2600 voce desenha a tela linha a linha, contando ciclos, e o programa e o
; kernel. Aqui nao: a PPU desenha sozinha a partir do que voce deixou na
; memoria dela, e o programa vira "arrume tudo antes do quadro comecar". Por
; isso o corpo do jogo mora na NMI, que chega uma vez por quadro, e o laco
; principal fica esperando.
;
; A outra troca: o 2600 tem 5 objetos e voce inventa o resto; o NES tem 64
; sprites e uma grade de 32x30 tiles, todos vindos do CHR -- que aqui e montado
; por tabelas no fim do arquivo, editaveis na aba Tiles.
;
; Dominio publico. Faca o que quiser com isto.
; =============================================================================

        processor 6502

; O cabecalho iNES: 1 banco de 16K de codigo, 1 de 8K de tiles, mapper 0
; (NROM, o cartucho sem troca de banco) e espelhamento vertical.
        ines prg=1 chr=1 mapper=0 mirror=v

; --- os registradores que a PPU e a APU expoem -------------------------------
PPUCTRL         = $2000
PPUMASK         = $2001
PPUSTATUS       = $2002
OAMADDR         = $2003
PPUSCROLL       = $2005
PPUADDR         = $2006
PPUDATA         = $2007
OAMDMA          = $4014
APUSTATUS       = $4015
JOY1            = $4016
JOY2            = $4017         ; o mesmo endereco e o contador de quadros da APU

; Os quatro registradores de cada canal ficam seguidos, entao vale nomear so o
; primeiro e somar: PULSE1+1 e a varredura, PULSE1+2 o periodo, e assim por
; diante.
PULSE1          = $4000
NOISE           = $400C

; --- botoes, na ordem em que o controle entrega ------------------------------
; O laco de leitura entrega o A primeiro e o Direita por ultimo, e cada um
; entra por baixo -- entao o A acaba no bit de cima.
BOTAO_DIREITA   = %00000001
BOTAO_ESQUERDA  = %00000010
BOTAO_A         = %10000000

; --- ajustes do jogo ---------------------------------------------------------
NAVE_Y          = 180           ; altura em que a nave voa
NAVE_TILE       = 1             ; qual tile do CHR e a nave
VELOCIDADE      = 2             ; pixels por quadro
X_MIN           = 8
X_MAX           = 240

TIRO_TILE       = 3             ; qual tile do CHR e o tiro
TIRO_VEL        = 4             ; sobe mais rapido do que a nave anda
TIRO_TOPO       = 16            ; acima disto o tiro some
TIRO_FORA       = 0             ; tiroY = 0 quer dizer "nenhum tiro na tela"

INIMIGO_TILE    = 4
INIMIGO_Y       = 40            ; a altura em que ele cruza
INIMIGO_VEL     = 1             ; devagar: da tempo de mirar
INIMIGO_ESPERA  = 90            ; quadros ate voltar depois de cair
PERTO           = 8             ; a caixa da colisao tem a largura de um tile

; --- som ---------------------------------------------------------------------
; A APU tem envelope e varredura no proprio hardware: uma vez armados, eles
; andam sozinhos a cada quadro. Entao "tocar" aqui e so escrever os quatro
; registradores do canal e deixar quieto -- nao ha rotina de som andando junto
; com o jogo.
TIRO_DUTY       = %10001100     ; onda 50%, envelope no lugar do volume fixo
TIRO_SWEEP      = %10010011     ; varredura ligada: o periodo cresce, o tom cai
TIRO_PERIODO    = $80           ; onde o "piu" comeca
TIRO_COMPR      = %00001000     ; contador de comprimento, periodo alto = 0

BUM_ENVELOPE    = %00001111     ; envelope no mais lento: o estouro morre devagar
BUM_TOM         = %00001000     ; ruido longo -- o grave, nao o metalico
BUM_COMPR       = %00110000     ; recarrega o comprimento e reinicia o envelope

CANAIS          = %00001001     ; pulso 1 e ruido; o resto fica desligado

CHAO            = $2000 + 26*32 ; onde na grade do fundo o chao comeca

; --- a memoria de trabalho ---------------------------------------------------
; A pagina zero e a memoria rapida do 6502, igual no 2600. A diferenca e que
; aqui sobra: o NES tem 2K de RAM contra os 128 bytes do 2600.
        seg.u zeropage
        org $0000

naveX           ds 1            ; coluna da nave
botoes          ds 1            ; o que o controle 1 esta segurando
antes           ds 1            ; o que ele segurava no quadro passado
novos           ds 1            ; os que acabaram de ser apertados
pronto          ds 1            ; a NMI avisa aqui que o quadro passou
tiroX           ds 1            ; coluna do tiro
tiroY           ds 1            ; linha do tiro; 0 = nao ha tiro
inimigoX        ds 1            ; coluna do inimigo
inimigoVivo     ds 1            ; 0 = caiu, esperando voltar
espera          ds 1            ; quantos quadros faltam para ele voltar

; A pagina 2 inteira e o rascunho dos 64 sprites: 4 bytes cada (y, tile,
; atributo, x). Uma vez por quadro ela e copiada para a PPU de um golpe so.
        seg.u oam
        org $0200
sprites         ds 256

; =============================================================================
        seg code
        bank 0
        org $C000

; -----------------------------------------------------------------------------
; Arranque
; -----------------------------------------------------------------------------
reset   subroutine
        sei                     ; sem interrupcao ate estarmos prontos
        cld                     ; o 2A03 nao tem modo decimal, mas o habito fica
        ldx #$FF
        txs                     ; pilha no topo da pagina 1
        inx                     ; x = 0
        stx PPUCTRL             ; desliga a NMI enquanto arrumamos a casa
        stx PPUMASK             ; e a tela
        stx APUSTATUS           ; e o som

        ; O contador de quadros da APU nasce pedindo interrupcao. Nao usamos
        ; IRQ, e como o programa habilita interrupcao no fim do arranque, ela
        ; ficaria batendo a toa sessenta vezes por segundo. O bit 6 desliga.
        lda #%01000000
        sta JOY2

        ; A PPU leva dois quadros para acordar. Ate la ela ignora escrita, e
        ; quem nao espera acaba com paleta pela metade.
        bit PPUSTATUS
.espera1
        bit PPUSTATUS
        bpl .espera1

        jsr limparRam
        jsr esconderSprites

.espera2
        bit PPUSTATUS
        bpl .espera2

        jsr carregarPaleta
        jsr desenharChao

        lda #128
        sta naveX
        lda #1
        sta inimigoVivo         ; ele ja comeca cruzando

        lda #CANAIS             ; sem isto os canais ficam mudos, escreva o que
        sta APUSTATUS           ; escrever nos outros registradores

        ; Rolagem zerada. Sao duas escritas no mesmo registrador: a primeira e
        ; o x, a segunda o y. Sem isto a tela nasce deslocada, porque as
        ; escritas em PPUADDR ali em cima mexeram no mesmo par interno.
        lda #0
        sta PPUSCROLL
        sta PPUSCROLL

        lda #%10000000          ; liga a NMI de cada quadro
        sta PPUCTRL
        lda #%00011110          ; mostra fundo e sprites, inclusive na borda
        sta PPUMASK
        cli

; -----------------------------------------------------------------------------
; O laco principal so espera o quadro virar. Todo o trabalho esta na NMI --
; e la que da para mexer na PPU sem sujar a imagem.
; -----------------------------------------------------------------------------
laco    subroutine
        lda pronto
        beq laco
        lda #0
        sta pronto
        jmp laco

; -----------------------------------------------------------------------------
; NMI: chega uma vez por quadro, quando o feixe sai da tela
; -----------------------------------------------------------------------------
nmi     subroutine
        pha                     ; a NMI interrompe qualquer coisa: guarde tudo
        txa
        pha
        tya
        pha

        ; Copiar os 256 bytes do rascunho para a memoria de sprites da PPU.
        ; Isto tem que vir primeiro: e a operacao mais cara do quadro, e so
        ; cabe enquanto o feixe esta fora da tela.
        lda #0
        sta OAMADDR
        lda #>sprites
        sta OAMDMA

        jsr lerControle
        jsr moverNave
        jsr atirar
        jsr moverTiro
        jsr moverInimigo
        jsr colidir
        jsr montarSprites

        lda #0                  ; a rolagem se perde a cada quadro: reponha
        sta PPUSCROLL
        sta PPUSCROLL

        lda #1
        sta pronto

        pla
        tay
        pla
        tax
        pla
irq     rti                     ; nao usamos IRQ; o vetor cai num rti

; -----------------------------------------------------------------------------
; Le o controle 1. O trinco pede uma foto dos botoes, e depois cada leitura
; entrega um botao, do A ao Direita -- oito no total.
; -----------------------------------------------------------------------------
lerControle subroutine
        lda #1
        sta JOY1                ; trinca
        lda #0
        sta JOY1                ; solta: a foto ficou guardada
        ldx #8
.proximo
        lda JOY1
        lsr                     ; o bit 0 entra no carry
        rol botoes              ; e o carry entra por baixo em botoes
        dex
        bne .proximo

        ; Quais botoes ACABARAM de ser apertados: os que estao ligados agora e
        ; nao estavam antes. Sem isto, segurar o A metralharia -- um tiro por
        ; quadro, sessenta por segundo.
        lda antes
        eor #$FF                ; ~antes
        and botoes
        sta novos
        lda botoes
        sta antes
        rts

; -----------------------------------------------------------------------------
; Anda com a nave, respeitando as bordas
; -----------------------------------------------------------------------------
moverNave subroutine
        lda botoes
        and #BOTAO_ESQUERDA
        beq .direita
        lda naveX
        sec
        sbc #VELOCIDADE
        cmp #X_MIN
        bcc .direita            ; bateu na borda: nao anda
        sta naveX
.direita
        lda botoes
        and #BOTAO_DIREITA
        beq .fim
        lda naveX
        clc
        adc #VELOCIDADE
        cmp #X_MAX
        bcs .fim
        sta naveX
.fim    rts

; -----------------------------------------------------------------------------
; Dispara, se o A acabou de ser apertado e nao ha tiro na tela
; -----------------------------------------------------------------------------
atirar  subroutine
        lda novos
        and #BOTAO_A
        beq .fim                ; nao apertou agora
        lda tiroY
        bne .fim                ; ja tem um tiro voando
        lda naveX               ; sai do meio da nave
        sta tiroX
        lda #NAVE_Y - 6         ; e logo acima dela
        sta tiroY
        jsr somTiro
.fim    rts

; -----------------------------------------------------------------------------
; Sobe o tiro, e o apaga quando chega no alto
; -----------------------------------------------------------------------------
moverTiro subroutine
        lda tiroY
        beq .fim                ; nao ha tiro
        sec
        sbc #TIRO_VEL
        cmp #TIRO_TOPO
        bcc .some
        sta tiroY
        rts
.some   lda #TIRO_FORA
        sta tiroY
.fim    rts

; -----------------------------------------------------------------------------
; O inimigo cruza a tela; caido, conta os quadros ate voltar
; -----------------------------------------------------------------------------
moverInimigo subroutine
        lda inimigoVivo
        beq .caido

        lda inimigoX
        clc
        adc #INIMIGO_VEL
        sta inimigoX
        cmp #248                ; saiu pela direita? volta pela esquerda
        bcc .fim
        lda #0
        sta inimigoX
        rts

.caido  lda espera
        beq .volta
        dec espera
        rts
.volta  lda #1
        sta inimigoVivo
        lda #0
        sta inimigoX            ; entra de novo pela esquerda
.fim    rts

; -----------------------------------------------------------------------------
; O tiro acertou o inimigo?
;
; O NES tem deteccao de colisao no hardware, mas so para o sprite 0 contra o
; fundo -- serve para dividir a tela, nao para isto. Entao a conta e no codigo,
; e a mais barata que existe: se as duas caixas se encostam nos dois eixos,
; bateu. Como o 6502 nao tem valor absoluto, a distancia sai da subtracao e, se
; der negativo, do complemento de dois.
; -----------------------------------------------------------------------------
colidir subroutine
        lda inimigoVivo
        beq .fim                ; nao ha o que acertar
        lda tiroY
        beq .fim                ; nao ha tiro

        lda tiroX               ; distancia horizontal
        sec
        sbc inimigoX
        bcs .semSinal
        eor #$FF                ; deu negativo: inverte o sinal
        adc #1                  ; (o carry esta limpo aqui, entao isto e +1)
.semSinal
        cmp #PERTO
        bcs .fim                ; longe demais de lado

        lda tiroY               ; distancia vertical
        sec
        sbc #INIMIGO_Y
        bcs .semSinal2
        eor #$FF
        adc #1
.semSinal2
        cmp #PERTO
        bcs .fim                ; passou por cima ou ainda esta longe

        lda #0                  ; acertou: os dois somem
        sta inimigoVivo
        sta tiroY
        lda #INIMIGO_ESPERA
        sta espera
        jsr somExplosao
.fim    rts

; -----------------------------------------------------------------------------
; Monta os tres sprites no rascunho: quatro bytes cada, nesta ordem
; -----------------------------------------------------------------------------
montarSprites subroutine
        lda #NAVE_Y
        sta sprites+0           ; y
        lda #NAVE_TILE
        sta sprites+1           ; qual tile
        lda #0
        sta sprites+2           ; atributo: paleta 0, sem espelho
        lda naveX
        sta sprites+3           ; x

        ; O tiro e o sprite 1. Sem tiro na tela, y = $FF o esconde -- e o mesmo
        ; truque do esconderSprites.
        lda tiroY
        bne .tem
        lda #$FF
        sta sprites+4
        jmp .inimigo            ; sem tiro, mas o inimigo continua la
.tem    sta sprites+4           ; y
        lda #TIRO_TILE
        sta sprites+5
        lda #0
        sta sprites+6
        lda tiroX
        sta sprites+7           ; x

.inimigo
        ; O sprite 2 e o inimigo. O byte de atributo dele nao e mais zero: o 1
        ; escolhe a segunda paleta de sprites, e e so por isso que ele tem cor
        ; propria sem gastar tile nenhum a mais.
        lda inimigoVivo
        bne .vivo
        lda #$FF
        sta sprites+8
        rts
.vivo   lda #INIMIGO_Y
        sta sprites+8           ; y
        lda #INIMIGO_TILE
        sta sprites+9
        lda #1                  ; paleta 1 de sprites
        sta sprites+10
        lda inimigoX
        sta sprites+11          ; x
        rts

; -----------------------------------------------------------------------------
; O "piu" do tiro
;
; Quem faz o tom cair e a varredura da APU, nao o programa: armada uma vez, ela
; aumenta o periodo sozinha a cada quadro, e o tom desce junto. Quando o periodo
; passa do limite ela cala o canal -- entao o som termina sem ninguem mandar.
; -----------------------------------------------------------------------------
somTiro subroutine
        lda #TIRO_DUTY
        sta PULSE1
        lda #TIRO_SWEEP
        sta PULSE1+1
        lda #TIRO_PERIODO
        sta PULSE1+2
        lda #TIRO_COMPR
        sta PULSE1+3            ; escrever aqui dispara o som
        rts

; -----------------------------------------------------------------------------
; O estouro da nave inimiga
;
; O canal de ruido e um gerador de numeros pseudoaleatorios ligado no alto-
; falante -- e por isso que serve tao bem para explosao. O volume nao e fixo:
; quem o derruba e o envelope, tambem no hardware.
; -----------------------------------------------------------------------------
somExplosao subroutine
        lda #BUM_ENVELOPE
        sta NOISE
        lda #BUM_TOM
        sta NOISE+2
        lda #BUM_COMPR
        sta NOISE+3             ; e aqui que ele estoura
        rts

; -----------------------------------------------------------------------------
; Manda os 64 sprites para fora da tela. Y=$FF os esconde; sem isto o jogo
; nasce com lixo espalhado, porque a memoria acorda suja.
; -----------------------------------------------------------------------------
esconderSprites subroutine
        lda #$FF
        ldx #0
.proximo
        sta sprites,x
        inx
        inx
        inx
        inx
        bne .proximo
        rts

; -----------------------------------------------------------------------------
; Zera a RAM toda
; -----------------------------------------------------------------------------
limparRam subroutine
        lda #0
        ldx #0
.proximo
        sta $0000,x
        sta $0300,x
        sta $0400,x
        sta $0500,x
        sta $0600,x
        sta $0700,x
        inx
        bne .proximo
        rts

; -----------------------------------------------------------------------------
; A paleta mora em $3F00 dentro da PPU: 16 cores para o fundo, 16 para os
; sprites. Escrever la e sempre a mesma dança -- endereco alto, endereco
; baixo, e depois os bytes seguidos.
; -----------------------------------------------------------------------------
carregarPaleta subroutine
        bit PPUSTATUS           ; zera o meio-a-meio do PPUADDR
        lda #$3F
        sta PPUADDR
        lda #$00
        sta PPUADDR
        ldx #0
.proximo
        lda paleta,x
        sta PPUDATA
        inx
        cpx #32
        bne .proximo
        rts

; -----------------------------------------------------------------------------
; Desenha o chao: a grade de tiles do fundo tem 32 colunas por 30 linhas e
; mora em $2000 dentro da PPU. Aqui so as quatro ultimas linhas viram grama.
; -----------------------------------------------------------------------------
desenharChao subroutine
        bit PPUSTATUS
        ; A grade do fundo comeca em $2000 e tem 32 tiles por linha, entao a
        ; linha 26 fica em $2000 + 26*32. Os sinais < e > pegam o byte de baixo
        ; e o de cima de um endereco -- a PPU quer os dois, nesta ordem.
        lda #>CHAO
        sta PPUADDR
        lda #<CHAO
        sta PPUADDR
        ldy #4                  ; quatro linhas de grama
.linha
        ldx #32                 ; cada uma com 32 tiles
.coluna
        lda #2                  ; o tile 2 e a grama
        sta PPUDATA
        dex
        bne .coluna
        dey
        bne .linha
        rts

; -----------------------------------------------------------------------------
; As cores. Cada grupo de quatro e uma paleta; a primeira cor de todas e o
; fundo da tela, e o NES a repete em todas elas.
; -----------------------------------------------------------------------------
paleta
        ; fundo -- a cor 0 e o ceu, e o NES a repete em todas as paletas
        .byte $21,$0F,$1A,$2A   ; ceu, preto, verde escuro, verde claro
        .byte $21,$0F,$1A,$2A
        .byte $21,$0F,$1A,$2A
        .byte $21,$0F,$1A,$2A
        ; sprites -- a 0 e a nave, a 1 e o inimigo
        .byte $21,$30,$0F,$16   ; ceu, branco, preto, vermelho
        .byte $21,$27,$0F,$14   ; ceu, laranja, preto, roxo
        .byte $21,$30,$0F,$16
        .byte $21,$30,$0F,$16

; -----------------------------------------------------------------------------
; Os vetores, no fim do banco. O do meio e o reset: e o unico endereco que o
; NES conhece ao ligar, e por ele que tudo comeca.
; -----------------------------------------------------------------------------
        org $FFFA
        .word nmi
        .word reset
        .word irq

; =============================================================================
; Os tiles. Cada um sao 16 bytes: oito para o plano de baixo da cor, oito para
; o de cima. Um pixel com 1 nos dois planos usa a cor 3 da paleta.
;
; Da para desenhar por cima destes bytes na aba Tiles e ver o resultado
; rodando na mesma pagina.
; =============================================================================
        chrbank 0
        org $0000

        ; tile 0: vazio
        .byte $00,$00,$00,$00,$00,$00,$00,$00
        .byte $00,$00,$00,$00,$00,$00,$00,$00

        ; tile 1: a nave
        .byte %00011000
        .byte %00111100
        .byte %00111100
        .byte %01111110
        .byte %01111110
        .byte %11111111
        .byte %11011011
        .byte %10000001
        .byte %00011000       ; o segundo plano acende so o miolo, que fica
        .byte %00011000       ; com a cor 3 -- o vermelho da paleta
        .byte %00011000
        .byte %00011000
        .byte %00111100
        .byte %00111100
        .byte %00011000
        .byte %00000000

        ; tiles 3 e 4 vem depois da grama, la embaixo.

        ; tile 2: grama. O plano de cima esta todo aceso, entao nenhum pixel
        ; cai na cor 0 (que seria o ceu vazando); o de baixo salpica os que
        ; sobem para a cor 3, o verde claro.
        .byte %10001000
        .byte %00100010
        .byte %10001000
        .byte %00100010
        .byte %10001000
        .byte %00100010
        .byte %10001000
        .byte %00100010
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111

        ; tile 3: o tiro. So o plano de cima, entao ele sai inteiro na cor 2 --
        ; que na paleta de sprites e o preto do contorno. Dois pixels de largura
        ; no meio do tile, para sair do centro da nave.
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00011000
        .byte %00011000
        .byte %00011000
        .byte %00011000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000

        ; tile 4: a nave inimiga, um disco. O plano de baixo desenha o corpo
        ; inteiro (cor 1, o laranja da paleta 1); o de cima acende so a cupula,
        ; que vira cor 3, o roxo.
        .byte %00111100
        .byte %01111110
        .byte %11111111
        .byte %11111111
        .byte %01111110
        .byte %00111100
        .byte %01000010
        .byte %00000000
        .byte %00111100
        .byte %00111100
        .byte %00011000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
