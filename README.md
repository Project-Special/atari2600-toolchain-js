# Emuladores e editores de 8 bits em JavaScript

Montador, emuladores e editores para **Atari 2600** e **NES** — tudo em
JavaScript, sem nada instalado, cada editor numa página que abre direto no
navegador. Nenhuma chamada de rede, nenhum servidor, nenhum executável.

Um arquivo só: **[tools/index.html](tools/index.html)**. Ele tem o seletor de
console no topo e os dois editores inteiros dentro, cada um guardado num
`<template>`:

- **Editor Emulador Atari** — lê o `.asm`, mostra cada tabela `.byte` como
  sprite, monta o fonte e roda a ROM ali mesmo.
- **Editor Emulador NES** — abre um `.nes`, lista os tiles da CHR, deixa
  desenhar por cima, grava o arquivo de volta e roda o jogo com o que você
  mudou.

Ao escolher um console, o conteúdo do template vai para uma moldura pelo
`srcdoc`. São documentos separados de propósito — os dois editores definem `$`,
`say`, `toast` e uma pilha de outros nomes, e no mesmo escopo um pisaria no
outro. Como o `srcdoc` herda a origem da página, o editor lá dentro continua
com acesso a arquivo: o `Ctrl+S` grava por cima do `.asm`, mesmo abrindo o
arquivo direto do disco.

O endereço aceita `#atari` e `#nes` para abrir direto num deles, e ele lembra o
último que você usou.

![o editor](https://img.shields.io/badge/roda%20em-um%20arquivo%20HTML-blue)

## As ferramentas

| Ferramenta | Arquivo | O que faz |
|---|---|---|
| Os editores | `tools/index.html` | arquivo único: os dois consoles, com montador e emuladores dentro |
| Montador | `tools/dasm.js` | monta 6502 falando o dialeto do DASM, no navegador ou no Node |
| Emulador | `tools/vcs.js` | núcleo próprio: CPU 6507, TIA e RIOT em lockstep com o color clock |
| Compilar pelo terminal | `tools/build.js` | grava `.bin`, `.lst` e `.sym` |
| Sprite ↔ PNG | `tools/sprite.js` | tabela `.byte` para PNG e de volta, em lote |
| Paletas do TIA | `tools/palette.js` | NTSC e PAL em JS, e gera o `.gpl` do LibreSprite/GIMP |
| Emulador de NES | `tools/nes.js` | CPU 2A03, PPU 2C02 e os mappers 0, 1, 2, 3 e 7 |
| Testes | `tools/dasm-test.js`, `tools/vcs-test.js`, `tools/nes-test.js` | conferem montador e os dois emuladores |

```
node tools/build.js nave               # monta um fonte
node tools/build.js --all              # monta todos
node tools/dasm-test.js                # compara byte a byte com o DASM de verdade
node tools/vcs-test.js                 # testa o emulador de 2600
node tools/nes-test.js                 # testa o emulador de NES
```

Os dois editores abrem ROM pronta: o de NES pelo `Abrir .nes…`, o de Atari
pelo `Abrir ROM…` — `.bin`, `.a26` ou `.rom`, de 2K a 32K, com o banco
reconhecido pelo próprio emulador (flat, F8, F6, F4, E0, FE). Arrastar o
arquivo para a página também vale nos dois.

## O montador

`tools/dasm.js` fala o dialeto do DASM: `SEG`/`SEG.U`, `ORG` com preenchimento,
`RORG`/`REND`, `ALIGN`, `DC`/`DS`/`HEX` em `.b`/`.w`/`.l`, `EQU`/`=`/`SET`/`EQM`,
`SUBROUTINE` com rótulos locais, `MAC`/`ENDM`/`MEXIT` com `{1}`…`{9}`,
`REPEAT`/`REPEND`, `IF`/`IFCONST`/`IFNCONST`/`ELSE`/`ENDIF`, `ECHO`, `ERR`,
`INCBIN` e `END`. Para o NES vão três diretivas que o DASM não tem: `INES`
escreve o cabeçalho e declara os bancos, `BANK` e `CHRBANK` escolhem para onde
os bytes seguintes vão. A partir daí o `ORG` continua recebendo endereço de
CPU — quem traduz para posição no arquivo é o banco escolhido. Cobre NROM:
mapper 0, 16 ou 32K de código e 8K de tiles. As expressões têm a mesma
precedência, incluindo `<`/`>` de
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

O `dasm.js`, o `vcs.js`, o `nes.js` e a paleta vivem duas vezes: como arquivo em
`tools/`, para o Node e para os testes, e copiados inteiros dentro do
`tools/index.html`, para a página não depender de nada. O `dasm-test.js` compara as
duas cópias e reclama quando uma fica para trás.

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

## O NES

`tools/nes.js` é um Nintendo Entertainment System escrito do zero, no mesmo
desenho do emulador de 2600: o relógio de vídeo manda e a CPU anda pendurada
nele — 3 pontos de PPU por ciclo de CPU, 341 pontos por scanline, 262
scanlines por quadro. A CPU tem os opcodes não documentados, que homebrew
pequeno usa bastante para economizar byte.

A PPU tem o pipeline de verdade, não uma aproximação por scanline: os quatro
buscas em oito pontos, os registradores de deslocamento, e os incrementos do
registrador `v` nos pontos canônicos — coarse X a cada 8, Y no 256, cópia
horizontal no 257, vertical entre 280 e 304 da linha de pré-render, vblank no
ponto 1 da linha 241 e o ponto pulado no quadro ímpar. Sprites com avaliação de
até oito por linha, 8x8 e 8x16, espelhamento, prioridade e o acerto do sprite
0, que é como quase todo jogo divide a tela.

Os mappers vão todos pelo mesmo par de mapas — quatro janelas de 8K no PRG e
oito de 1K na CHR, que é o menor denominador comum entre eles: 0 (NROM),
1 (MMC1), 2 (UxROM), 3 (CNROM), 4 (MMC3) e 7 (AxROM). O MMC3 traz o contador
de linhas que pede IRQ, que é como SMB3, Mega Man 3–6 e Kirby partem a tela.

A APU tem os cinco canais — dois pulsos com envelope e varredura, triângulo com
contador linear, ruído com o registrador de deslocamento de 15 bits e o DMC
lendo amostras do próprio PRG — mais o contador de quadros que bate a 240 Hz e
anda os envelopes e as durações. A mistura é a fórmula não-linear do NESdev, e
a saída passa por um filtro passa-alta como o do console: sem ele o sinal fica
todo de um lado do zero e canal mudo vira degrau, não silêncio.

`tools/nes-test.js` monta uma ROM `.nes` com o montador daqui — cabeçalho iNES,
16K de PRG com `RORG` para `$C000`, 8K de CHR — e confere na tela as faixas de
cor do fundo, o sprite 0 no lugar certo, a rolagem vertical e o acerto do
sprite 0. Um caso à parte cobre o MMC3: a tela inteira com o mesmo tile, e o
IRQ trocando o banco de CHR na linha 120 — em cima sai uma cor, embaixo outra,
sem tocar na VRAM. E outro mede o som: uma ROM toca um lá no pulso 1, e o teste
conta as passagens por zero da onda que saiu — 438,7 Hz dos 440,4 que a conta
do NES manda.

**Editando os gráficos:** o `.nes` guarda cada tile de 8x8 em 16 bytes, dois
planos de bits — os oito primeiros dão o bit 0 da cor de cada pixel, os oito
seguintes dão o bit 1. O editor abre o arquivo, lista os tiles, deixa desenhar
e grava de volta no lugar certo. Vale para as ROMs com CHR-ROM, que são a
maioria; as que usam CHR-RAM (Zelda, Metroid, Mega Man) montam os tiles pelo
código, e para essas não há CHR no arquivo para editar.

## Os exemplos

Tudo original e em domínio público. Em `Arq_asm/`, os fontes soltos:

| | O que é |
|---|---|
| `barras.asm` | o menor kernel que dá imagem estável: uma cor por scanline, varrendo a paleta, escorregando a cada quadro |
| `dialeto.asm` | não é jogo: passa por todo canto do montador (macro com argumento, `REPEAT`, condicional, `RORG`, `SET`, `EQM`, rótulo local, opcode não documentado) para o teste ter o que comparar |

E em `Arq_nave/`, a nave — o mesmo jogo crescendo, primeiro no 2600 e depois
no NES:

| | O que é |
|---|---|
| `nave.asm` | **2600.** Um sprite que anda com o joystick — posicionamento horizontal, playfield espelhado, kernel de linha única. A tabela `.byte` dele abre na galeria do editor |
| `nes-nave-0.asm` | **NES.** O mesmo programa, para os dois serem lidos em par: a diferença entre desenhar a tela contando ciclos e deixar a PPU desenhar |
| `nes-nave-1.asm` | com tiro: o botão A dispara (na página, a barra de espaço também), um tiro por vez, disparo por borda para segurar o botão não metralhar |
| `nes-nave-2.asm` | agora há o que derrubar: uma nave inimiga cruza o alto, o tiro a abate e ela volta pela borda depois de um tempo. A colisão é conta de caixa feita no código — o NES só tem detecção de hardware para o sprite 0, e ela não serve para isto. O inimigo usa a paleta 1 de sprites, que é o que o byte de atributo escolhe |
| `nes-nave-3.asm` | com som: o tiro é um pulso que cai de tom pela varredura da APU, a explosão é um estouro no canal de ruído morrendo pelo envelope. Os dois são cinco escritas cada e mais nada — quem toca é o hardware, não uma rotina andando junto com o jogo |

A série `nes-nave-N` é numerada de propósito: **cada mudança vira um arquivo
novo**, e o anterior fica intacto ao lado. Dá para abrir os dois, rodar um
depois do outro e ver exatamente o que mudou — inclusive com `diff`, que é a
explicação mais curta que existe. O `.nes` montado vem junto de cada um, então
dá para só abrir e jogar.

Duas coisas seguem o último da série sozinhas: o botão *Carregar o exemplo* da
aba Fonte (o `tools/embutir.js` repõe) e o `nes-test.js`, que roda em **todos**
eles — assim mexer no `-2` não pode quebrar o `-0` sem ninguém notar.

Os fontes de NES não entram na comparação contra o `dasm.exe` — as diretivas de
NES são extensão daqui, e o DASM de verdade as recusaria. Quem confere aqueles é
o `nes-test.js`, que monta cada um e joga com ele: confere o cabeçalho, o vetor
de reset, a cor do céu e do chão, que a nave anda com o controle e para na
borda, e — de onde existem — que o tiro sai, sobe, some no alto e não vira
metralhadora com o botão preso, e que o inimigo cruza a tela, cai quando é
acertado e volta depois da espera. Esse último caso **joga**: mira adiante do
alvo, porque o tiro leva 34 quadros para subir e nesse tempo o inimigo anda.

O som também é medido, não só ouvido: que fique mudo parado, que o disparo faça
barulho, que o tom caia, e que os dois sons **terminem sozinhos** — som que não
acaba é o defeito clássico de quem arma o canal e esquece o contador de
comprimento.

Nada de jogo de terceiros aqui: nem ROMs comerciais, nem disassembly delas. Se
você tiver os seus, é só colocar em `Arq_asm/` — o `build.js` e o
`dasm-test.js` varrem essa pasta, a `Arq_nave/` e a raiz, e acham sozinhos, e o `.gitignore` já mantém fora do controle de
versão os que costumam aparecer.

O montador e o editor sabem passar `TIA_BASE_READ_ADDRESS=$30` para fontes que
endereçam os registradores de leitura da TIA pelo espelho em `$30`, como várias
fontes antigas fazem; a lista está no topo do `tools/build.js`.

# Useful Links

- [How to compile assembly code for games on the Atari 2600](https://medium.com/@johnidouglasmarangon/how-to-compile-assembly-code-for-games-on-the-atari-2600-16c3d79d6e50)
- [Gene Medic](http://genemedic.org/)
- [BJARS collection of Atari 2600 source code](http://www.bjars.com/sourcecode.html)
- [Learn Assembly Language by Making Games for the Atari 2600](https://www.udemy.com/course/programming-games-for-the-atari-2600/)
