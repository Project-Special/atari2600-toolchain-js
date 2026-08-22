# Atari 2600 toolchain em JavaScript

Montador, emulador e editor de sprites para o Atari 2600 — tudo em JavaScript,
sem nada instalado. Abra `tools/sprite-editor.html` no navegador: ele lê o
`.asm`, mostra cada tabela `.byte` como sprite, monta o fonte e roda a ROM ali
mesmo. Nenhuma chamada de rede, nenhum servidor, nenhum executável.

![o editor](https://img.shields.io/badge/roda%20em-um%20arquivo%20HTML-blue)

## As ferramentas

| Ferramenta | Arquivo | O que faz |
|---|---|---|
| Editor de sprites | `tools/sprite-editor.html` | página única: desenho, código-fonte, montador e emulador |
| Montador | `tools/dasm.js` | monta 6502 falando o dialeto do DASM, no navegador ou no Node |
| Emulador | `tools/vcs.js` | núcleo próprio: CPU 6507, TIA e RIOT em lockstep com o color clock |
| Compilar pelo terminal | `tools/build.js` | grava `.bin`, `.lst` e `.sym` |
| Sprite ↔ PNG | `tools/sprite.js` | tabela `.byte` para PNG e de volta, em lote |
| Paletas do TIA | `tools/palette.js` | NTSC e PAL em JS, e gera o `.gpl` do LibreSprite/GIMP |
| Testes | `tools/dasm-test.js`, `tools/vcs-test.js` | conferem montador e emulador |

```
node tools/build.js nave               # monta um fonte
node tools/build.js --all              # monta todos
node tools/dasm-test.js                # compara byte a byte com o DASM de verdade
node tools/vcs-test.js                 # testa o emulador com ROMs montadas na hora
```

## O montador

`tools/dasm.js` fala o dialeto do DASM: `SEG`/`SEG.U`, `ORG` com preenchimento,
`RORG`/`REND`, `ALIGN`, `DC`/`DS`/`HEX` em `.b`/`.w`/`.l`, `EQU`/`=`/`SET`/`EQM`,
`SUBROUTINE` com rótulos locais, `MAC`/`ENDM`/`MEXIT` com `{1}`…`{9}`,
`REPEAT`/`REPEND`, `IF`/`IFCONST`/`IFNCONST`/`ELSE`/`ENDIF`, `ECHO`, `ERR`,
`INCBIN` e `END`. As expressões têm a mesma precedência, incluindo `<`/`>` de
byte baixo/alto, `.` e `*` como PC atual, `[ ]` como parênteses e
`%1010`/`$ff`/`'c`. Faz vários passes até a tabela de símbolos parar de mudar,
então referência para a frente vira zero page quando cabe.

A tabela de opcodes — com os não documentados (`lax`, `sax`, `dcp`, `isb`,
`slo`, `rla`, `sre`, `rra`, `anc`, `asr`, `arr`, `sbx`, `lxa`, `ane`, `las`,
`sha`, `shs`, `shx`, `shy` e o `nop` com operando) — foi extraída do próprio
DASM, montando todas as combinações mnemônico × modo e lendo o listing. O que o
DASM não conhece continua sendo recusado aqui.

`vcs.h` e `macro.h` vão embutidos no arquivo, então a página monta um fonte que
os inclui mesmo aberta de um `file://`.

**Conferido:** `node tools/dasm-test.js` monta cada `.asm` da raiz e de
`Arq_asm/` com o montador daqui e com o `dasm.exe`, e compara byte a byte e
símbolo a símbolo, rótulos locais inclusive. Se você largar outros fontes na
pasta, eles entram no teste sozinhos.

## O emulador

`tools/vcs.js` é um Atari 2600 escrito para este projeto: CPU 6507 com os
opcodes não documentados, TIA e RIOT 6532 andando em lockstep com o color clock
— 1 ciclo de CPU = 3 color clocks, 228 color clocks por scanline, 68 de HBLANK
e 160 visíveis. Cobre cartuchos 2K, 4K e os bancos F8, F6, F4, E0 e FE.

`tools/vcs-test.js` monta ROMs de teste com o montador daqui e confere o
comportamento fino: o posicionamento clássico (`WSYNC`, laço de −15, `RESPx`,
`HMOVE`) tem que dar uma reta de uma coluna por unidade, e a CPU tem que voltar
do `WSYNC` no ciclo certo.

## Os exemplos

Três fontes originais, em domínio público, em `Arq_asm/`:

| | O que é |
|---|---|
| `barras.asm` | o menor kernel que dá imagem estável: uma cor por scanline, varrendo a paleta, escorregando a cada quadro |
| `nave.asm` | um sprite que anda com o joystick — posicionamento horizontal, playfield espelhado, kernel de linha única. A tabela `.byte` dele abre na galeria do editor |
| `dialeto.asm` | não é jogo: passa por todo canto do montador (macro com argumento, `REPEAT`, condicional, `RORG`, `SET`, `EQM`, rótulo local, opcode não documentado) para o teste ter o que comparar |

Nada de jogo de terceiros aqui: nem ROMs comerciais, nem disassembly delas. Se
você tiver os seus, é só colocar em `Arq_asm/` — o `build.js` e o
`dasm-test.js` acham sozinhos, e o `.gitignore` já mantém fora do controle de
versão os que costumam aparecer.

O montador e o editor sabem passar `TIA_BASE_READ_ADDRESS=$30` para fontes que
endereçam os registradores de leitura da TIA pelo espelho em `$30`, como várias
fontes antigas fazem; a lista está no topo do `tools/build.js`.

# Useful Links

- [How to compile assembly code for games on the Atari 2600](https://medium.com/@johnidouglasmarangon/how-to-compile-assembly-code-for-games-on-the-atari-2600-16c3d79d6e50)
- [Gene Medic](http://genemedic.org/)
- [BJARS collection of Atari 2600 source code](http://www.bjars.com/sourcecode.html)
- [Learn Assembly Language by Making Games for the Atari 2600](https://www.udemy.com/course/programming-games-for-the-atari-2600/)
