; =============================================================================
; barras.asm -- o menor kernel que da uma imagem estavel
;
; Uma varredura pela paleta inteira: cada scanline recebe uma cor de fundo, e
; a cada quadro a lista anda um passo, entao as faixas escorregam pela tela.
; Serve para conferir de olho se a temporizacao do quadro esta certa -- se as
; barras tremerem ou a imagem rolar, o problema esta na contagem de linhas.
;
; Dominio publico. Faca o que quiser com isto.
; =============================================================================

        processor 6502
        include "vcs.h"
        include "macro.h"

VBLANK_TIME     = 43            ; 43 x 64 ciclos ~ 37 linhas
OVERSCAN_TIME   = 35            ; ~ 30 linhas
VISIBLE_LINES   = 192

; -----------------------------------------------------------------------------
        seg.u variables
        org $80

frame           ds 1            ; conta quadros; e o deslocamento das barras

; -----------------------------------------------------------------------------
        seg code
        org $F000

Start
        CLEAN_START

Main
        VERTICAL_SYNC           ; as tres linhas de sincronismo vertical

; --- VBLANK: 37 linhas para pensar ------------------------------------------
        lda #VBLANK_TIME
        sta TIM64T

        inc frame               ; a unica logica deste exemplo

.waitVBlank
        lda INTIM
        bne .waitVBlank
        sta WSYNC
        sta VBLANK              ; A vale 0 aqui: liga o feixe

; --- as 192 linhas visiveis --------------------------------------------------
; Cada volta gasta 13 ciclos dos 76 da linha. O COLUBK e escrito logo depois do
; WSYNC, ainda dentro do HBLANK, para a cor valer a linha inteira -- escrito no
; meio da linha, apareceria uma emenda no lugar em que a CPU chegou.
        ldy frame
        ldx #VISIBLE_LINES
.kernel
        sta WSYNC               ; 3
        sty COLUBK              ; 3   Y e a cor: $00..$FF varrendo a paleta
        iny                     ; 2
        dex                     ; 2
        bne .kernel             ; 3

        lda #0
        sta COLUBK              ; preto no rodape, senao a ultima cor vaza

; --- overscan: 30 linhas -----------------------------------------------------
        lda #2
        sta VBLANK              ; desliga o feixe
        lda #OVERSCAN_TIME
        sta TIM64T
.waitOverscan
        lda INTIM
        bne .waitOverscan
        sta WSYNC

        jmp Main

; -----------------------------------------------------------------------------
        org $FFFC
        .word Start             ; vetor de reset
        .word Start             ; vetor de IRQ (o 6507 nao usa, mas precisa ter)
