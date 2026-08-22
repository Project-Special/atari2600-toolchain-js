/* ==========================================================================
   As paletas do TIA em JavaScript, e o gerador do .gpl que o LibreSprite e o
   GIMP importam.

   O índice i é o valor do registrador i*2 — $00, $02 ... $FE — com o nibble
   alto de matiz e o baixo de luminância. São os mesmos números do
   PaletteHandler.cxx do Stella. A tabela NTSC é a que o editor de sprites e o
   emulador usam; a PAL vive só aqui.

       node tools/palette.js ntsc                       # imprime o .gpl
       node tools/palette.js pal --out atari-pal.gpl    # ou grava direto

   E como módulo:

       const P = require('./palette.js');
       P.NTSC[0x1c >> 1]   // 'd2d240', o RGB da cor $1C
   ========================================================================== */

'use strict';

/* --- NTSC: 16 matizes x 8 luminâncias ------------------------------------- */
const NTSC = [
  '000000','4a4a4a','6f6f6f','8e8e8e','aaaaaa','c0c0c0','d6d6d6','ececec',
  '484800','69690f','86861d','a2a22a','bbbb35','d2d240','e8e84a','fcfc54',
  '7c2c00','904811','a26221','b47a30','c3903d','d2a44a','dfb755','ecc860',
  '901c00','a33915','b55328','c66c3a','d5824a','e39759','f0aa67','fcbc74',
  '940000','a71a1a','b83232','c84848','d65c5c','e46f6f','f08080','fc9090',
  '840064','97197a','a8308f','b846a2','c659b3','d46cc3','e07cd2','ec8ce0',
  '500084','68199a','7d30ad','9246c0','a459d0','b56ce0','c57cee','d48cfc',
  '140090','331aa3','4e32b5','6848c6','7f5cd5','956fe3','a980f0','bc90fc',
  '000094','181aa7','2d32b8','4248c8','545cd6','656fe4','7580f0','8490fc',
  '001c88','183b9d','2d57b0','4272c2','548ad2','65a0e1','75b5ef','84c8fc',
  '003064','185080','2d6d98','4288b0','54a0c5','65b7d9','75cceb','84e0fc',
  '004030','18624e','2d8169','429e82','54b899','65d1ae','75e7c2','84fcd4',
  '004400','1a661a','328432','48a048','5cba5c','6fd26f','80e880','90fc90',
  '143c00','355f18','527e2d','6e9c42','87b754','9ed065','b4e775','c8fc84',
  '303800','505916','6d762b','88923e','a0ab4f','b7c25f','ccd86e','e0ec7c',
  '482c00','694d14','866a26','a28638','bb9f47','d2b656','e8cc63','fce070',
];

/* --- PAL: mesmas luminâncias, matizes deslocados -------------------------- */
const PAL = [
  '0b0b0b','333333','595959','7b7b7b','999999','b6b6b6','cfcfcf','e6e6e6',
  '0b0b0b','333333','595959','7b7b7b','999999','b6b6b6','cfcfcf','e6e6e6',
  '3b2400','664700','8b7000','ac9200','c5ae36','dec85e','f7e27f','fff19e',
  '004500','006f00','3b9200','65b009','85ca3d','a3e364','bffc84','d5ffa5',
  '590000','802700','a15700','bc7937','d6985f','eeb381','ffce9e','ffdcbd',
  '004900','007200','169216','45af45','6bc96b','8be38b','a9fba9','c5ffc5',
  '640012','890821','a73d4d','c26472','dc8491','f4a3ae','ffbeca','ffdae0',
  '003d29','006a48','048e63','3caa84','62c5a2','83dfbe','a1f8d9','beffe9',
  '550046','88006e','a5318d','c159aa','da7cc5','f39adf','ffb9f3','ffd4f6',
  '003651','005a7d','117e9c','429cb8','68b7d2','88d2eb','a6ebff','c3ffff',
  '4c007c','75009d','932eb8','af57d2','ca7aeb','e499ff','ecb7ff','f3d4ff',
  '002d83','003ea4','2d65bf','5685da','79a2f2','99bfff','b7dbff','d3f5ff',
  '220096','5200b6','7538cf','945fe8','b181ff','c5a0ff','d6bdff','e8daff',
  '00009a','241db6','504ad0','746fe9','928eff','b1adff','cecaff','e9e5ff',
  '0b0b0b','333333','595959','7b7b7b','999999','b6b6b6','cfcfcf','e6e6e6',
  '0b0b0b','333333','595959','7b7b7b','999999','b6b6b6','cfcfcf','e6e6e6',
];

/* o .gpl é um formato de texto simples: cabeçalho de quatro linhas e uma linha
   por cor, com R G B alinhados em três colunas e o nome depois de um tab. O
   nome aqui é o valor do registrador, que é o que você escreve em COLUP0 e
   companhia. Termina as linhas em CRLF, como os arquivos originais. */
function gpl(which) {
  const table = which.toLowerCase() === 'pal' ? PAL : NTSC;
  const name = which.toLowerCase() === 'pal' ? 'PAL' : 'NTSC';
  const out = ['GIMP Palette', 'Name: Atari 2600 ' + name, 'Columns: 8', '#'];
  table.forEach((hex, i) => {
    const rgb = [0, 2, 4].map(p => String(parseInt(hex.substr(p, 2), 16)).padStart(3));
    out.push(rgb.join(' ') + '\t$' + (i * 2).toString(16).toUpperCase().padStart(2, '0'));
  });
  return out.join('\r\n') + '\r\n';
}

const PALETTES = { NTSC, PAL, gpl };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PALETTES;

  if (require.main === module) {
    const argv = process.argv.slice(2);
    const which = argv.find(a => /^(ntsc|pal)$/i.test(a));
    const at = argv.indexOf('--out');
    if (!which) {
      console.error('uso: node tools/palette.js <ntsc|pal> [--out arquivo.gpl]');
      process.exit(2);
    }
    const text = gpl(which);
    if (at >= 0 && argv[at + 1]) {
      require('fs').writeFileSync(argv[at + 1], text, 'latin1');
      console.error(argv[at + 1] + ': 128 cores');
    } else {
      process.stdout.write(text);
    }
  }
}
