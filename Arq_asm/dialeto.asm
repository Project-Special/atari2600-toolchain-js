; =============================================================================
; dialeto.asm -- exercicio do dialeto do DASM
;
; Nao e um jogo: e um fonte que passa por todo canto do montador -- macro com
; argumento, REPEAT, condicional, segmento nao inicializado, RORG, SET, EQM,
; rotulo local, expressao com precedencia, opcode nao documentado, DS/DC/HEX.
; A ROM que sai daqui nao faz nada de util na tela; o que importa e que o
; tools/dasm-test.js monta este arquivo com o montador daqui e com o dasm.exe
; e compara byte a byte. Se algum canto do dialeto sair diferente, quebra aqui.
;
; Dominio publico. Faca o que quiser com isto.
; =============================================================================

        processor 6502
        include "vcs.h"
        include "macro.h"

; --- constantes e expressoes -------------------------------------------------
BASE            = $F000
MASK            = %11001010
CHAR            = 'A
SHIFTED         = (BASE >> 8) & $FF
PRECEDENCE      = 2 + 3 * 4 - [10 / 5]          ; colchetes agrupam como ( )
COMPARE         = MASK > $80                    ; comparacao devolve 0 ou 1
NEGATED         = ~MASK & $FF

VERSION_MAJOR   = 1
VERSION_MINOR   = 7
VERSION         = VERSION_MAJOR * 100 + VERSION_MINOR

; --- um simbolo textual: o EQM guarda a expressao, nao o valor ---------------
HALF            EQM VERSION / 2

; --- macros ------------------------------------------------------------------
; Escreve um valor em varios registradores seguidos.
        MAC FILL_REGS
.REG    SET {1}
.VALUE  SET {2}
        lda #.VALUE
        REPEAT {3}
        sta .REG
.REG    SET .REG + 1
        REPEND
        ENDM

; Uma tabela de N bytes crescentes, montada em tempo de montagem.
        MAC RAMP
.N      SET 0
        REPEAT {1}
        .byte .N * {2}
.N      SET .N + 1
        REPEND
        ENDM

; -----------------------------------------------------------------------------
        seg.u variables
        org $80

counter         ds 1
pointer         ds 2
buffer          ds 4
        align 16                ; alinha o proximo dentro do segmento
aligned         ds 1

; -----------------------------------------------------------------------------
        seg code
        org BASE

Start
        CLEAN_START

        ; --- condicionais ----------------------------------------------------
        IF VERSION >= 100
        lda #<VERSION
        ELSE
        lda #0
        ENDIF

        IFCONST BASE
        sta counter
        ENDIF

        IFNCONST NAO_DEFINIDO
        lda #MASK
        ENDIF

        ; --- expressoes ------------------------------------------------------
        lda #PRECEDENCE         ; 2 + 12 - 2 = 12
        lda #COMPARE
        lda #NEGATED
        lda #SHIFTED
        lda #CHAR
        lda #HALF               ; o EQM entra como texto e so aqui vira conta
        lda #<Table             ; byte baixo
        lda #>Table             ; byte alto
        lda #[Table & $FF] ^ $80

        ; --- modos de enderecamento ------------------------------------------
        lda counter             ; zero page, resolvido para 1 byte
        lda.w counter           ; forcado a 2 bytes
        lda Table               ; absoluto
        lda Table,x
        lda Table,y
        lda (pointer),y
        lda (pointer,x)
        ldx Table,y
        sta buffer,x
        asl                     ; acumulador
        rol counter

        ; --- macros ----------------------------------------------------------
        FILL_REGS COLUP0, $0E, 4
        SLEEP 11                ; da macro.h: usa opcode nao documentado

        ; --- opcodes nao documentados ----------------------------------------
        lxa #0
        nop 0
        nop $10,x
        lax buffer
        sax buffer
        dcp buffer
        isb buffer
        slo buffer
        rla buffer
        sre buffer
        rra buffer
        anc #$0F
        asr #$0F
        arr #$0F
        sbx #$0F
        las Table,y
        shy Table,x

        ; --- rotulos locais, um por SUBROUTINE -------------------------------
        jsr First
        jsr Second

Loop
        jmp Loop

First SUBROUTINE
        ldx #3
.wait
        dex
        bne .wait               ; este .wait
        rts

Second SUBROUTINE
        ldy #3
.wait
        dey
        bne .wait               ; e este .wait sao simbolos diferentes
        rts

; =============================================================================
; Dados
; =============================================================================
        align 4

Table
        RAMP 8, 3               ; 0, 3, 6, 9, 12, 15, 18, 21
        .byte $01, $02, $03
        .byte "OI"              ; texto vira os bytes dos caracteres
        .word Start, Table
        .byte <Start, >Start
        hex 00ff8040
        ds 3                    ; tres bytes zerados
        ds 2, $EA               ; dois bytes com valor escolhido
        .byte                   ; sem operando: um byte zerado

; --- um trecho montado para rodar em outro endereco --------------------------
Relocated
        rorg $0400
        lda #0
        sta $0410
        jmp $0400
        rend

; -----------------------------------------------------------------------------
        org $FFFC
        .word Start
        .word Start
