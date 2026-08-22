; =============================================================================
; nave.asm -- um sprite que anda com o joystick
;
; O exemplo que cobre o feijao com arroz de um jogo do 2600: sprite de player,
; posicionamento horizontal, leitura do joystick e um kernel de linha unica.
; Nao ha objetivo nem placar -- e so a nave e o chao.
;
; As tabelas .byte no fim do arquivo aparecem como sprites na galeria do
; tools/sprite-editor.html, entao da para desenhar por cima e ver o resultado
; rodando na mesma pagina.
;
; Dominio publico. Faca o que quiser com isto.
; =============================================================================

        processor 6502
        include "vcs.h"
        include "macro.h"

VBLANK_TIME     = 43
OVERSCAN_TIME   = 35
VISIBLE_LINES   = 192

SKY             = $92           ; azul
GROUND          = $D4           ; verde
SHIP_COLOR      = $0E           ; branco

SHIP_H          = 8             ; altura do sprite
SHIP_Y          = 10            ; a que altura do rodape a nave voa
SPEED           = 1             ; colunas por quadro
X_MIN           = 2
X_MAX           = 150

; -----------------------------------------------------------------------------
        seg.u variables
        org $80

shipX           ds 1            ; coluna da nave

; -----------------------------------------------------------------------------
        seg code
        org $F000

Start
        CLEAN_START
        lda #76
        sta shipX

        lda #SKY
        sta COLUBK
        lda #GROUND
        sta COLUPF
        lda #SHIP_COLOR
        sta COLUP0
        lda #%00000001          ; playfield espelhado: chao dos dois lados
        sta CTRLPF

Main
        VERTICAL_SYNC

; --- VBLANK ------------------------------------------------------------------
        lda #VBLANK_TIME
        sta TIM64T

        ; --- joystick: em SWCHA, 0 quer dizer pressionado ---
        lda SWCHA
        and #%10000000          ; bit 7 = direita
        bne .noRight
        lda shipX
        cmp #X_MAX
        bcs .noRight
        adc #SPEED
        sta shipX
.noRight
        lda SWCHA
        and #%01000000          ; bit 6 = esquerda
        bne .noLeft
        lda shipX
        cmp #X_MIN
        bcc .noLeft
        sbc #SPEED
        sta shipX
.noLeft

        lda shipX
        ldx #0
        jsr PosObject           ; gasta 2 WSYNC, cabe folgado na VBLANK

.waitVBlank
        lda INTIM
        bne .waitVBlank
        sta WSYNC
        sta VBLANK

; --- kernel ------------------------------------------------------------------
; X conta as linhas de baixo para cima, entao X - SHIP_Y da a linha do sprite.
; Pior caso: 24 ciclos dos 76.
        ldx #VISIBLE_LINES
.kernel
        sta WSYNC               ; 3

        txa                     ; 2
        sec                     ; 2
        sbc #SHIP_Y             ; 2
        cmp #SHIP_H             ; 2   esta dentro das 8 linhas da nave?
        bcs .noShip             ; 2/3
        tay                     ; 2
        lda ShipGfx,y           ; 4
        sta GRP0                ; 3
        jmp .lineDone           ; 3
.noShip
        lda #0                  ; 2
        sta GRP0                ; 3
.lineDone

        cpx #24                 ; 2   as 24 linhas de baixo sao o chao
        bcs .noGround           ; 2/3
        lda #%11110000          ; 2
        sta PF0                 ; 3
.noGround

        dex                     ; 2
        bne .kernel             ; 3

        lda #0
        sta GRP0                ; limpa, senao o sprite vaza no overscan
        sta PF0

; --- overscan ----------------------------------------------------------------
        lda #2
        sta VBLANK
        lda #OVERSCAN_TIME
        sta TIM64T
.waitOverscan
        lda INTIM
        bne .waitOverscan
        sta WSYNC

        jmp Main

; =============================================================================
; Posiciona um objeto na horizontal
;   entra: A = coluna 0..159, X = 0 para o player 0, 1 para o player 1
;
; O laco gasta 15 color clocks por volta -- a mesma largura de um "bloco
; grosso" de posicionamento -- e o resto da divisao vira o ajuste fino no
; HMxx, aplicado pelo HMOVE na linha seguinte. Gasta 2 WSYNC, entao so serve
; durante a VBLANK ou o overscan.
; =============================================================================
PosObject SUBROUTINE
        sta HMCLR               ; o HMOVE vale para os cinco objetos: sem zerar,
                                ; o ajuste do anterior seria aplicado de novo.
                                ; Fica antes do WSYNC porque e a contagem de
                                ; ciclos depois dele que define a coluna.
        sec
        sta WSYNC
.divide
        sbc #15
        bcs .divide
        eor #7                  ; o que sobrou vira o ajuste fino
        asl
        asl
        asl
        asl
        sta HMP0,x
        sta RESP0,x
        sta WSYNC
        sta HMOVE
        rts

; =============================================================================
; Tabelas
; =============================================================================

; Sprites sao guardados de baixo para cima: a primeira linha aqui e a de baixo
; na tela, porque o kernel indexa pela distancia ate a base do desenho.
ShipGfx
        .byte %00111100 ; |  XXXX  |
        .byte %01111110 ; | XXXXXX |
        .byte %11111111 ; |XXXXXXXX|
        .byte %01011010 ; | X XX X |
        .byte %00111100 ; |  XXXX  |
        .byte %00011000 ; |   XX   |
        .byte %00011000 ; |   XX   |
        .byte %00000000 ; |        |

; -----------------------------------------------------------------------------
        org $FFFC
        .word Start
        .word Start
