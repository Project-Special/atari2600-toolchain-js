/* ============================================================================
   salto-mapa.js -- poe a fase e os tiles do nes-salto dentro do .asm

   A fase mora em Arq_salto/fase.txt, num formato que da para ler e editar com o
   olho: 30 linhas de 32 caracteres, um por tile, em hexa. Muito melhor do que
   960 numeros em linhas de .byte -- que e como ela precisa acabar no fonte.

   Este script faz a traducao. Edite o fase.txt, rode aqui, e o nes-salto-0.asm
   sai com a fase nova entre as marcas @mapa-inicio e @mapa-fim (e os tiles
   entre @tiles-inicio e @tiles-fim).

       node tools/salto-mapa.js
       node tools/salto-mapa.js --conferir   so valida o fase.txt, sem gravar

   O fase.txt tem duas secoes, "--- TILES ---" e "--- MAPA ---". Na dos tiles,
   linhas .byte %bbbbbbbb, dezesseis por tile: oito do plano de baixo e oito do
   de cima. Na do mapa, os 30x32 caracteres.

   Tiles 0 a 3 se atravessa; 4 em diante e parede. Essa divisao esta na colisao
   do jogo (PRIMEIRO_SOLIDO) e nao pode mudar so aqui.

   Dominio publico.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const PASTA = path.join(__dirname, '..', 'Arq_salto');
const FASE = path.join(PASTA, 'fase.txt');
const ASM = path.join(PASTA, 'nes-salto-0.asm');

function ler() {
  const txt = fs.readFileSync(FASE, 'utf8').replace(/\r\n/g, '\n');
  const iTiles = txt.indexOf('--- TILES ---');
  const iMapa = txt.indexOf('--- MAPA ---');
  if (iTiles < 0 || iMapa < 0) throw new Error('fase.txt sem as marcas --- TILES --- e --- MAPA ---');
  return {
    tiles: txt.slice(iTiles + 13, iMapa).trim().split('\n'),
    mapa: txt.slice(iMapa + 12).trim().split('\n').map(l => l.trim()).filter(Boolean),
  };
}

function conferir(tiles, mapa) {
  const erros = [];
  const linhasByte = tiles.filter(l => l.includes('.byte'));
  if (linhasByte.length !== 256) {
    erros.push('esperava 256 linhas .byte (16 tiles x 16), vieram ' + linhasByte.length);
  }
  for (const l of tiles) {
    const m = /\.byte\s+%([01]+)/.exec(l);
    if (m && m[1].length !== 8) erros.push('literal com ' + m[1].length + ' dígitos: ' + l.trim());
  }
  if (mapa.length !== 30) erros.push('esperava 30 linhas de mapa, vieram ' + mapa.length);
  mapa.forEach((l, i) => {
    if (l.length !== 32) erros.push('linha ' + i + ' do mapa tem ' + l.length + ' caracteres');
    if (!/^[0-9A-Fa-f]*$/.test(l)) erros.push('linha ' + i + ' do mapa tem caractere fora de 0-F');
  });
  return erros;
}

function main() {
  const soConferir = process.argv.includes('--conferir');
  const { tiles, mapa } = ler();

  const erros = conferir(tiles, mapa);
  if (erros.length) {
    console.log('fase.txt com problema:');
    for (const e of erros.slice(0, 10)) console.log('  ' + e);
    return 1;
  }
  console.log('ok     fase.txt: 16 tiles e ' + mapa.length + ' linhas de mapa');
  if (soConferir) return 0;

  /* O DASM le qualquer coisa na coluna 0 como rotulo -- inclusive um .byte, e
     ai o literal seguinte vira mnemonico. Por isso tudo entra indentado. */
  const tilesAsm = tiles.map(l => '        ' + l.trim()).filter(l => l.trim());

  const mapaAsm = [];
  mapa.forEach((l, i) => {
    const vals = [...l].map(c => parseInt(c, 16));
    for (let k = 0; k < 32; k += 16) {
      mapaAsm.push('        .byte ' + vals.slice(k, k + 16).join(',') +
                   (k === 0 ? '    ; linha ' + i : ''));
    }
  });

  let asm = fs.readFileSync(ASM, 'utf8');
  const quebra = asm.includes('\r\n') ? '\r\n' : '\n';
  asm = asm.replace(/\r\n/g, '\n');

  const trocar = (texto, ini, fim, linhas) => {
    const a = texto.indexOf(ini);
    const b = texto.indexOf(fim);
    if (a < 0 || b < 0) throw new Error('não achei as marcas ' + ini + ' / ' + fim);
    return texto.slice(0, a + ini.length) + '\n' + linhas.join('\n') + '\n' + texto.slice(b);
  };

  asm = trocar(asm, '; @mapa-inicio', '; @mapa-fim', mapaAsm);
  asm = trocar(asm, '; @tiles-inicio', '; @tiles-fim', tilesAsm);

  fs.writeFileSync(ASM, quebra === '\r\n' ? asm.replace(/\n/g, '\r\n') : asm);
  console.log('reposto no nes-salto-0.asm: ' + mapaAsm.length + ' linhas de mapa, ' +
              tilesAsm.filter(l => l.includes('.byte')).length + ' de tile');
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  console.log('erro: ' + err.message);
  process.exit(1);
}
