; =============================================================================
; nes-salto-0.asm -- um plataforma para NES, do zero
;
; Jogo original: arte, fases e mecanica escritas aqui. Nada vem de ROM de
; terceiro. O que ele tem em comum com os plataformas classicos e o que nao
; pertence a ninguem -- a mecanica: correr com inercia, pular mais alto se voce
; segurar o botao, cair, e bater no cenario.
;
; O que este -0 cobre:
;   * fisica de plataforma com posicao e velocidade em ponto fixo 8.8
;   * pulo de altura variavel: soltar o A no meio do pulo corta a subida
;   * colisao contra o mapa de tiles, resolvida em X e depois em Y
;   * uma tela de fase, montada de uma tabela de 960 bytes
;
; A rolagem lateral e os inimigos ficam para os proximos numeros da serie.
;
; Dominio publico. Faca o que quiser com isto.
; =============================================================================

        processor 6502
        ines prg=1 chr=1 mapper=0 mirror=v

; --- registradores -----------------------------------------------------------
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
JOY2            = $4017

PULSE1          = $4000
NOISE           = $400C

; --- botoes ------------------------------------------------------------------
; O laco de leitura entrega o A primeiro e o Direita por ultimo, e cada um entra
; por baixo -- entao o A acaba no bit de cima.
BOTAO_DIREITA   = %00000001
BOTAO_ESQUERDA  = %00000010
BOTAO_BAIXO     = %00000100
BOTAO_CIMA      = %00001000
BOTAO_A         = %10000000

; --- a fisica ----------------------------------------------------------------
; Posicao e velocidade sao 8.8: um byte de pixel e um byte de fracao. Sem a
; fracao nao ha aceleracao suave -- ou o boneco anda 1 pixel por quadro, que e
; rapido demais, ou nao anda. Com ela, da para acelerar de 0 a 2 pixels por
; quadro em meio segundo, que e o que faz o controle parecer bom.
ACEL            = $18           ; ganho de velocidade por quadro andando
ATRITO          = $10           ; perda por quadro sem apertar nada
VEL_MAX         = $02           ; 2 pixels por quadro na horizontal
GRAVIDADE       = $28           ; ganho de queda por quadro
; A gravidade leve define sozinha a altura maxima do pulo: subindo com impulso
; v, o boneco sobe v*v*256/(2*g) pixels. Com o impulso 4 e g=$10 dava 128 px --
; catorze tiles, alto demais para uma fase caber na tela. Impulso 3 com g=$1E da
; uns 38, que sao os quatro tiles e meio que as plataformas pedem.
GRAV_LEVE       = $1E           ; enquanto sobe segurando o A: sobe mais alto
QUEDA_MAX       = $05           ; nao cai mais que 5 pixels por quadro
IMPULSO         = $03           ; velocidade de subida ao pular (pixels/quadro)
CORTE_PULO      = $01           ; ao soltar o A, a subida cai para isto

CHAO_Y          = 192           ; onde comeca o chao, em pixels (linha 24 x 8)
LARG            = 8             ; o boneco ocupa 8 pixels de largura
ALTU            = 16            ; e 16 de altura (sprite 8x16)

PRIMEIRO_SOLIDO = 4             ; tile 4 em diante e parede; 0 a 3 se atravessa

; --- a memoria de trabalho ---------------------------------------------------
        seg.u zeropage
        org $0000

botoes          ds 1
antes           ds 1
novos           ds 1
pronto          ds 1            ; a NMI avisa aqui que o quadro passou

xLo             ds 1            ; posicao do jogador, 8.8
xHi             ds 1
yLo             ds 1
yHi             ds 1
vxLo            ds 1            ; velocidade, 8.8 com sinal
vxHi            ds 1
vyLo            ds 1
vyHi            ds 1

noChao          ds 1            ; 1 se ha piso debaixo dos pes
pulando         ds 1            ; 1 enquanto sobe por causa do pulo
olhando         ds 1            ; 0 direita, 1 esquerda -- espelha o sprite

; rascunho das rotinas de colisao
alvoX           ds 1
alvoY           ds 1
tmp             ds 1
coluna          ds 1
linha           ds 1
mapaLo          ds 1
mapaHi          ds 1

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
        sei
        cld
        ldx #$FF
        txs
        inx
        stx PPUCTRL
        stx PPUMASK
        stx APUSTATUS

        lda #%01000000          ; sem interrupcao da APU
        sta JOY2

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
        jsr desenharFase

        ; o jogador nasce na coluna 3, em pe no chao
        lda #24
        sta xHi
        lda #CHAO_Y - ALTU
        sta yHi
        lda #0
        sta xLo
        sta yLo
        sta vxLo
        sta vxHi
        sta vyLo
        sta vyHi
        sta olhando

        lda #0
        sta PPUSCROLL
        sta PPUSCROLL

        lda #%10110000          ; NMI ligada, sprite 8x16, fundo no banco de $1000
        sta PPUCTRL
        lda #%00011110
        sta PPUMASK
        cli

laco    subroutine
        lda pronto
        beq laco
        lda #0
        sta pronto
        jmp laco

; -----------------------------------------------------------------------------
; NMI: um quadro
; -----------------------------------------------------------------------------
nmi     subroutine
        pha
        txa
        pha
        tya
        pha

        lda #0
        sta OAMADDR
        lda #>sprites
        sta OAMDMA

        jsr lerControle
        jsr andar
        jsr pular
        jsr moverX
        jsr moverY
        jsr montarSprites

        lda #0
        sta PPUSCROLL
        sta PPUSCROLL
        lda #%10110000
        sta PPUCTRL

        lda #1
        sta pronto

        pla
        tay
        pla
        tax
        pla
irq     rti

; -----------------------------------------------------------------------------
; Controle, com borda: novos = ligados agora e nao antes
; -----------------------------------------------------------------------------
lerControle subroutine
        lda #1
        sta JOY1
        lda #0
        sta JOY1
        ldx #8
.proximo
        lda JOY1
        lsr
        rol botoes
        dex
        bne .proximo

        lda antes
        eor #$FF
        and botoes
        sta novos
        lda botoes
        sta antes
        rts

; -----------------------------------------------------------------------------
; Andar: acelera para o lado apertado, freia sozinho quando ninguem aperta
;
; A velocidade e 16 bits com sinal (vxHi:vxLo). Somar e subtrair em 16 bits e
; chato no 6502, mas e o que da o arranque e a parada macios -- sem isso o
; boneco liga e desliga, e o jogo parece duro.
; -----------------------------------------------------------------------------
andar   subroutine
        lda botoes
        and #BOTAO_ESQUERDA
        beq .testaDireita
        lda #1
        sta olhando
        ; vx -= ACEL
        lda vxLo
        sec
        sbc #ACEL
        sta vxLo
        lda vxHi
        sbc #0
        sta vxHi
        ; limita a -VEL_MAX. Depois do BPL sabemos que e negativo, e ai o CMP
        ; sem sinal ja serve: $FE e $FF sao -2 e -1, dentro do limite.
        lda vxHi
        bpl .fim
        cmp #256-VEL_MAX
        bcs .fim
        lda #256-VEL_MAX
        sta vxHi
        lda #0
        sta vxLo
        rts

.testaDireita
        lda botoes
        and #BOTAO_DIREITA
        beq .freia
        lda #0
        sta olhando
        ; vx += ACEL
        lda vxLo
        clc
        adc #ACEL
        sta vxLo
        lda vxHi
        adc #0
        sta vxHi
        ; limita a +VEL_MAX
        lda vxHi
        bmi .fim
        cmp #VEL_MAX+1
        bcc .fim
        lda #VEL_MAX
        sta vxHi
        lda #0
        sta vxLo
        rts

.freia
        ; puxa a velocidade para zero, de qualquer um dos lados
        lda vxHi
        bmi .freiaNeg
        ora vxLo
        beq .fim                ; ja esta parado
        lda vxLo
        sec
        sbc #ATRITO
        sta vxLo
        lda vxHi
        sbc #0
        sta vxHi
        bpl .fim
        lda #0                  ; passou do zero: para de vez
        sta vxLo
        sta vxHi
        rts
.freiaNeg
        lda vxLo
        clc
        adc #ATRITO
        sta vxLo
        lda vxHi
        adc #0
        sta vxHi
        bmi .fim
        lda #0
        sta vxLo
        sta vxHi
.fim    rts

; -----------------------------------------------------------------------------
; Pular
;
; Duas coisas fazem o pulo parecer bom, e as duas estao aqui:
;
; A altura e variavel: enquanto voce segura o A e ainda esta subindo, a gravidade
; e a leve; solta antes, a subida e cortada na hora. Isso da o pulinho e o pulo
; alto com o mesmo botao.
;
; E so pula quem tem chao. Sem essa checagem da para pular no ar quantas vezes
; quiser -- o defeito classico de quem so olha o botao.
; -----------------------------------------------------------------------------
pular   subroutine
        lda novos
        and #BOTAO_A
        beq .segurando
        lda noChao
        beq .segurando          ; no ar: nao pula de novo
        lda #256-IMPULSO        ; velocidade para cima e negativa
        sta vyHi
        lda #0
        sta vyLo
        sta noChao
        lda #1
        sta pulando
        jsr somPulo
        rts

.segurando
        lda pulando
        beq .gravidade
        lda botoes
        and #BOTAO_A
        bne .gravidade          ; ainda segurando: segue subindo leve
        ; soltou no meio da subida: corta o resto dela
        lda #0
        sta pulando
        lda vyHi
        bpl .gravidade          ; ja esta caindo, nao ha o que cortar
        cmp #256-CORTE_PULO
        bcs .gravidade          ; ja esta subindo devagar
        lda #256-CORTE_PULO
        sta vyHi
        lda #0
        sta vyLo

.gravidade
        ; enquanto sobe segurando o A, a gravidade e a leve
        ldx #GRAVIDADE
        lda pulando
        beq .aplica
        lda vyHi
        bpl .aplica
        ldx #GRAV_LEVE
.aplica
        txa
        clc
        adc vyLo
        sta vyLo
        lda vyHi
        adc #0
        sta vyHi
        ; limita a queda
        bmi .fim                ; subindo, nao ha o que limitar
        cmp #QUEDA_MAX+1
        bcc .fim
        lda #QUEDA_MAX
        sta vyHi
        lda #0
        sta vyLo
.fim    rts

; -----------------------------------------------------------------------------
; Mover em X, batendo na parede
;
; Os dois eixos sao resolvidos separados, e nesta ordem. Resolver junto faz o
; boneco entalar em quina: encostou na parede de lado enquanto caia e o codigo
; nao sabe se para ou se desce.
; -----------------------------------------------------------------------------
moverX  subroutine
        lda xLo
        clc
        adc vxLo
        sta xLo
        lda xHi
        adc vxHi
        sta xHi

        ; qual borda testar depende do lado para onde vai
        lda vxHi
        bmi .indoEsquerda
        ora vxLo
        beq .fim                ; parado

        ; indo para a direita: testa a borda direita, no meio e nos pes
        lda xHi
        clc
        adc #LARG-1
        sta alvoX
        jsr paredeNaColuna
        beq .fim
        ; bateu: encosta na borda esquerda do tile e zera a velocidade
        ; a borda direita tem que ficar um pixel ANTES do tile: se o pe do
        ; calculo for LARG-1, o boneco fica com um pixel dentro da parede
        lda alvoX
        and #$F8
        sec
        sbc #LARG
        sta xHi
        lda #0
        sta xLo
        sta vxLo
        sta vxHi
        rts

.indoEsquerda
        lda xHi
        sta alvoX
        jsr paredeNaColuna
        beq .fim
        lda alvoX
        ora #$07                ; ate a borda direita do tile...
        clc
        adc #1                  ; ...e um pixel depois dela
        sta xHi
        lda #0
        sta xLo
        sta vxLo
        sta vxHi
.fim    rts

; testa a coluna de alvoX na altura da cabeca, do meio e dos pes
paredeNaColuna subroutine
        lda yHi
        clc
        adc #1
        sta alvoY
        jsr tileSolido
        bne .achou
        lda yHi
        clc
        adc #ALTU/2
        sta alvoY
        jsr tileSolido
        bne .achou
        lda yHi
        clc
        adc #ALTU-1
        sta alvoY
        jsr tileSolido
.achou  rts

; -----------------------------------------------------------------------------
; Mover em Y, pousando no chao e batendo a cabeca
; -----------------------------------------------------------------------------
moverY  subroutine
        lda #0
        sta noChao

        lda yLo
        clc
        adc vyLo
        sta yLo
        lda yHi
        adc vyHi
        sta yHi

        lda vyHi
        bmi .subindo

        ; Caindo: a sonda vai UM PIXEL ABAIXO do ultimo pixel do corpo, nao
        ; nele. Testando o proprio pe, o pouso deixa o boneco encostado mas com
        ; o pe no ar por um pixel -- e no quadro seguinte a sonda nao acha nada,
        ; entao noChao pisca entre 1 e 0 e o pulo so sai se o botao calhar no
        ; quadro certo. Um pixel abaixo, a resposta e estavel.
        lda yHi
        clc
        adc #ALTU
        sta alvoY
        jsr paredeNaLinha
        beq .fim
        ; pousou: alinha o pe com o topo do tile
        lda alvoY
        and #$F8
        sec
        sbc #ALTU
        sta yHi
        lda #0
        sta yLo
        sta vyLo
        sta vyHi
        sta pulando
        lda #1
        sta noChao
        rts

.subindo
        lda yHi
        sta alvoY
        jsr paredeNaLinha
        beq .fim
        ; bateu com a cabeca: cola embaixo do tile e cai
        lda alvoY
        ora #$07
        clc
        adc #1
        sta yHi
        lda #0
        sta yLo
        sta vyLo
        sta vyHi
        sta pulando
.fim    rts

; testa a linha de alvoY nos dois cantos do boneco
paredeNaLinha subroutine
        lda xHi
        sta alvoX
        jsr tileSolido
        bne .achou
        lda xHi
        clc
        adc #LARG-1
        sta alvoX
        jsr tileSolido
.achou  rts

; -----------------------------------------------------------------------------
; O tile em (alvoX, alvoY) e parede?
;
; Devolve Z limpo (BNE pega) se for solido. A conta e a de sempre: coluna e o
; pixel dividido por 8, linha idem, e o indice no mapa e linha*32 + coluna.
; Multiplicar por 32 e cinco deslocamentos -- feito em 16 bits porque o mapa tem
; 960 bytes e nao cabe em um.
; -----------------------------------------------------------------------------
tileSolido subroutine
        lda alvoX
        lsr
        lsr
        lsr
        sta coluna
        lda alvoY
        lsr
        lsr
        lsr
        sta linha
        cmp #30
        bcs .naoSolido          ; fora do mapa por baixo: deixa passar

        ; mapaLo:mapaHi = linha * 32
        lda #0
        sta mapaHi
        lda linha
        asl
        rol mapaHi
        asl
        rol mapaHi
        asl
        rol mapaHi
        asl
        rol mapaHi
        asl
        rol mapaHi
        clc
        adc coluna
        sta mapaLo
        lda mapaHi
        adc #0
        sta mapaHi

        ; mapaLo:mapaHi += MAPA
        lda mapaLo
        clc
        adc #<MAPA
        sta mapaLo
        lda mapaHi
        adc #>MAPA
        sta mapaHi

        ldy #0
        lda (mapaLo),y
        cmp #PRIMEIRO_SOLIDO
        bcc .naoSolido
        lda #1                  ; solido
        rts
.naoSolido
        lda #0
        rts

; -----------------------------------------------------------------------------
; Os sprites: o boneco e um 8x16, entao um sprite so
; -----------------------------------------------------------------------------
montarSprites subroutine
        lda yHi
        sec
        sbc #1                  ; a PPU desenha o sprite uma linha abaixo do y
        sta sprites+0
        lda #0                  ; tile 0 do banco de sprites (modo 8x16)
        sta sprites+1
        lda olhando
        beq .semEspelho
        lda #%01000000          ; espelha na horizontal
.semEspelho
        sta sprites+2
        lda xHi
        sta sprites+3
        rts

; -----------------------------------------------------------------------------
; Som do pulo: um pulso curto que sobe, feito pela varredura da APU
; -----------------------------------------------------------------------------
somPulo subroutine
        lda #%10001010
        sta PULSE1
        lda #%10011010          ; varredura negativa: o periodo cai, o tom sobe
        sta PULSE1+1
        lda #$C0
        sta PULSE1+2
        lda #%00001000
        sta PULSE1+3
        rts

; -----------------------------------------------------------------------------
; Zera a RAM
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
; A paleta
; -----------------------------------------------------------------------------
carregarPaleta subroutine
        bit PPUSTATUS
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
; Desenha a fase inteira: 960 tiles na grade de fundo, e depois os atributos
;
; A grade comeca em $2000 e tem 32x30. Os atributos vem logo depois, em $23C0:
; 64 bytes, um para cada quadrado de 32x32 pixels, com duas paletas por byte.
; Aqui todos usam a paleta 0, entao os 64 sao zero.
; -----------------------------------------------------------------------------
desenharFase subroutine
        bit PPUSTATUS
        lda #$20
        sta PPUADDR
        lda #$00
        sta PPUADDR

        lda #<MAPA
        sta mapaLo
        lda #>MAPA
        sta mapaHi

        ldx #0                  ; conta as 4 voltas de 240 bytes
.pagina
        ldy #0
.byteAByte
        lda (mapaLo),y
        sta PPUDATA
        iny
        cpy #240
        bne .byteAByte

        lda mapaLo              ; anda 240 no ponteiro
        clc
        adc #240
        sta mapaLo
        lda mapaHi
        adc #0
        sta mapaHi
        inx
        cpx #4
        bne .pagina

        ; atributos: tudo na paleta 0
        bit PPUSTATUS
        lda #$23
        sta PPUADDR
        lda #$C0
        sta PPUADDR
        lda #0
        ldx #64
.attr   sta PPUDATA
        dex
        bne .attr
        rts

; -----------------------------------------------------------------------------
paleta
        ; fundo
        .byte $22,$16,$27,$30   ; ceu, tijolo, laranja, branco
        .byte $22,$16,$27,$30
        .byte $22,$16,$27,$30
        .byte $22,$16,$27,$30
        ; sprites
        .byte $22,$30,$0F,$16   ; ceu, branco, preto, vermelho
        .byte $22,$30,$0F,$16
        .byte $22,$30,$0F,$16
        .byte $22,$30,$0F,$16

; =============================================================================
; A fase: 960 bytes, um por tile, na ordem em que a PPU os quer -- linha por
; linha, da esquerda para a direita. A mesma tabela serve para duas coisas: para
; desenhar o fundo no arranque e para a colisao perguntar "o que tem aqui?".
;
; Guardar a fase assim gasta quase 1K por tela, o que e caro. Jogo de verdade
; comprime -- e por isso que os tiles daqueles cartuchos nao aparecem crus no
; arquivo. Aqui vale a clareza: da para ler a fase com o olho.
; =============================================================================
MAPA
; @mapa-inicio
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0    ; linha 0
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0    ; linha 1
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0    ; linha 2
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0    ; linha 3
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0    ; linha 4
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .byte 0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0    ; linha 5
        .byte 0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0    ; linha 6
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .byte 0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0    ; linha 7
        .byte 0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0    ; linha 8
        .byte 0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .byte 0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0    ; linha 9
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0    ; linha 10
        .byte 0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0    ; linha 11
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0    ; linha 12
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,8,9,9,10    ; linha 13
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0    ; linha 14
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .byte 0,0,0,0,0,15,6,15,0,0,0,0,0,0,0,0    ; linha 15
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,8,9,9,10
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0    ; linha 16
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .byte 0,0,0,0,0,0,0,0,0,8,9,9,10,0,0,0    ; linha 17
        .byte 0,0,8,9,9,10,0,0,0,0,0,0,0,0,0,0
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0    ; linha 18
        .byte 0,0,0,0,0,0,0,0,6,15,6,6,15,6,0,0
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0    ; linha 19
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .byte 0,0,0,0,8,9,10,0,0,0,0,0,0,0,8,9    ; linha 20
        .byte 10,0,0,0,0,0,11,12,0,0,0,0,0,0,0,0
        .byte 0,0,0,0,0,0,0,0,11,12,0,0,0,0,0,0    ; linha 21
        .byte 0,0,8,9,10,0,13,14,0,8,9,10,0,0,0,0
        .byte 0,0,0,0,0,0,0,0,13,14,0,0,0,0,0,0    ; linha 22
        .byte 0,0,0,0,0,0,13,14,0,0,0,0,0,0,0,0
        .byte 0,3,0,0,0,2,0,0,13,14,0,0,3,0,0,2    ; linha 23
        .byte 0,0,3,0,0,0,13,14,0,0,2,0,0,3,0,3
        .byte 4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4    ; linha 24
        .byte 4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4
        .byte 5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5    ; linha 25
        .byte 5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5
        .byte 5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5    ; linha 26
        .byte 5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5
        .byte 5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5    ; linha 27
        .byte 5,5,5,5,5,5,5,5,5,5,5,5,5,5,5,5
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0    ; linha 28
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0    ; linha 29
        .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
; @mapa-fim

; -----------------------------------------------------------------------------
        org $FFFA
        .word nmi
        .word reset
        .word irq

; =============================================================================
; Os tiles
;
; O banco de CHR tem 8K = 512 tiles, divididos em duas metades de 256. O PPUCTRL
; escolhe qual metade e dos sprites e qual e do fundo; aqui os sprites usam a
; primeira e o fundo a segunda.
; =============================================================================
        chrbank 0
        org $0000

; --- sprites: o boneco, em 8x16 (dois tiles empilhados) ----------------------
; No modo 8x16 a PPU usa o tile par e o impar seguinte, um em cima do outro.
        ; tile 0 -- cabeca e tronco
        .byte %00111100
        .byte %01111110
        .byte %01011010
        .byte %01111110
        .byte %00111100
        .byte %00011000
        .byte %00111100
        .byte %01111110
        .byte %00000000
        .byte %00000000
        .byte %00100100
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00011000
        .byte %00111100

        ; tile 1 -- pernas
        .byte %01111110
        .byte %01111110
        .byte %00111100
        .byte %00111100
        .byte %00111100
        .byte %00100100
        .byte %00100100
        .byte %01100110
        .byte %00111100
        .byte %00111100
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %01100110

; o resto da primeira metade fica vazio
        org $1000

; --- fundo: os 16 tiles da fase ----------------------------------------------
; @tiles-inicio
        ; tile 0 -- vazio (ceu)
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        ; tile 1 -- nuvem
        .byte %00000000
        .byte %00110000
        .byte %01111100
        .byte %01111110
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %01111100
        .byte %00000000
        .byte %00110000
        .byte %01111100
        .byte %01111110
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %01111100
        ; tile 2 -- arbusto/moita
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00100000
        .byte %00000000
        .byte %00000000
        .byte %10000001
        .byte %00000000
        .byte %00000000
        .byte %00011000
        .byte %00111100
        .byte %01111110
        .byte %11111111
        .byte %11111111
        .byte %01111110
        ; tile 3 -- grama alta decorativa
        .byte %00000000
        .byte %00100000
        .byte %00000100
        .byte %10000000
        .byte %00000001
        .byte %00000000
        .byte %00000000
        .byte %10000001
        .byte %00000000
        .byte %00100000
        .byte %00100100
        .byte %10100100
        .byte %10100101
        .byte %10110101
        .byte %01111110
        .byte %01111110
        ; tile 4 -- chao (superficie)
        .byte %11111111
        .byte %00000000
        .byte %01000010
        .byte %00000000
        .byte %00100100
        .byte %00000000
        .byte %01000010
        .byte %00000000
        .byte %11111111
        .byte %11111111
        .byte %10111101
        .byte %11111111
        .byte %11011011
        .byte %11111111
        .byte %10111101
        .byte %11111111
        ; tile 5 -- terra (miolo)
        .byte %00000000
        .byte %00100010
        .byte %00000000
        .byte %01000100
        .byte %00000000
        .byte %00010001
        .byte %00000000
        .byte %01000010
        .byte %11111111
        .byte %11011101
        .byte %11111111
        .byte %10111011
        .byte %11111111
        .byte %11101110
        .byte %11111111
        .byte %10111101
        ; tile 6 -- tijolo
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %00010000
        .byte %00010000
        .byte %00010000
        .byte %11111111
        .byte %00000001
        .byte %00000001
        .byte %00000001
        ; tile 7 -- bloco liso (pedra)
        .byte %11111111
        .byte %10000001
        .byte %10000001
        .byte %10000001
        .byte %10000001
        .byte %10000001
        .byte %10000001
        .byte %11111111
        .byte %11111111
        .byte %11111110
        .byte %11111110
        .byte %11111110
        .byte %11111110
        .byte %11111110
        .byte %11111110
        .byte %00000000
        ; tile 8 -- plataforma ponta esquerda
        .byte %00111111
        .byte %01000000
        .byte %10000000
        .byte %10000000
        .byte %11111111
        .byte %11111111
        .byte %01111111
        .byte %00111111
        .byte %00111111
        .byte %01111111
        .byte %11111111
        .byte %11111111
        .byte %10000000
        .byte %10000000
        .byte %01000000
        .byte %00000000
        ; tile 9 -- plataforma meio
        .byte %11111111
        .byte %00000000
        .byte %00100010
        .byte %00000000
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %00000000
        .byte %00000000
        .byte %00000000
        .byte %00000000
        ; tile 10 -- plataforma ponta direita
        .byte %11111100
        .byte %00000010
        .byte %00000001
        .byte %00000001
        .byte %11111111
        .byte %11111111
        .byte %11111110
        .byte %11111100
        .byte %11111100
        .byte %11111110
        .byte %11111111
        .byte %11111111
        .byte %00000001
        .byte %00000001
        .byte %00000010
        .byte %00000000
        ; tile 11 -- cano topo esquerdo
        .byte %11111111
        .byte %10000000
        .byte %10000000
        .byte %11111111
        .byte %00110000
        .byte %00110000
        .byte %00110000
        .byte %00110000
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %10000000
        .byte %00111111
        .byte %00111111
        .byte %00111111
        .byte %00111111
        ; tile 12 -- cano topo direito
        .byte %11111111
        .byte %00000011
        .byte %00000011
        .byte %11111111
        .byte %00001100
        .byte %00001100
        .byte %00001100
        .byte %00001100
        .byte %11111111
        .byte %11111100
        .byte %11111100
        .byte %00000000
        .byte %11110000
        .byte %11110000
        .byte %11110000
        .byte %11110000
        ; tile 13 -- cano corpo esquerdo
        .byte %00110000
        .byte %00110000
        .byte %00110000
        .byte %00110000
        .byte %00110000
        .byte %00110000
        .byte %00110000
        .byte %00110000
        .byte %00111111
        .byte %00111111
        .byte %00111111
        .byte %00111111
        .byte %00111111
        .byte %00111111
        .byte %00111111
        .byte %00111111
        ; tile 14 -- cano corpo direito
        .byte %00001100
        .byte %00001100
        .byte %00001100
        .byte %00001100
        .byte %00001100
        .byte %00001100
        .byte %00001100
        .byte %00001100
        .byte %11110000
        .byte %11110000
        .byte %11110000
        .byte %11110000
        .byte %11110000
        .byte %11110000
        .byte %11110000
        .byte %11110000
        ; tile 15 -- bloco com marca
        .byte %11111111
        .byte %10000001
        .byte %10011001
        .byte %10111101
        .byte %10011001
        .byte %10000001
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %11111111
        .byte %10000001
        .byte %11111111
; @tiles-fim
