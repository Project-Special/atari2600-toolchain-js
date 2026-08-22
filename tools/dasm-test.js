/* ==========================================================================
   Confere o montador embutido contra o DASM de verdade.

   Monta cada fonte do repositório com o tools/dasm.js e com o dasm.exe, e
   compara byte a byte e símbolo a símbolo. As referências são geradas na hora,
   numa pasta temporária — nada em build/ é usado nem tocado.

       node tools/dasm-test.js
       node tools/dasm-test.js --dasm C:\outro\dasm.exe

   Os fontes testados sao todos os .asm da raiz e de Arq_asm/.

   Também confere as cópias que vivem embutidas: o vcs.h/macro.h dentro do
   dasm.js, e o dasm.js, o vcs.js e o nes.js inteiros dentro do
   tools/index.html.
   Sai com status 1 se algo divergir.
   ========================================================================== */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const DASM = require('./dasm.js');

const ROOT = path.resolve(__dirname, '..');

/* os mesmos -D do build.js */
const DEFINES = {
  riverraid: ['-DTIA_BASE_READ_ADDRESS=$30'],
  pitfall:   ['-DTIA_BASE_READ_ADDRESS=$30'],
  combat:    ['-DTIA_BASE_READ_ADDRESS=$30'],
};

/* Monta todo .asm que estiver na raiz e em Arq_asm/. O repositorio traz os
   exemplos originais (barras, nave, dialeto); se voce tiver outros fontes na
   sua copia -- disassemblies, jogos seus -- eles entram no teste sozinhos.

   Fora os de NES: ines, bank e chrbank sao extensao deste montador, e o DASM de
   verdade nao as conhece -- comparar os dois byte a byte seria comparar com um
   erro de sintaxe. Quem confere esses e o nes-test.js, que monta o exemplo e
   joga com ele. */
const ehNes = arquivo => {
  try { return /^\s*ines\s/mi.test(fs.readFileSync(path.join(ROOT, arquivo), 'utf8')); }
  catch (err) { return false; }
};

function acharFontes() {
  const achados = [], nes = [];
  for (const dir of ['Arq_asm', '.']) {
    const cheio = path.join(ROOT, dir);
    let nomes = [];
    try { nomes = fs.readdirSync(cheio); } catch (err) { continue; }
    for (const n of nomes.sort()) {
      if (!/\.asm$/i.test(n)) continue;
      const rel = path.join(dir, n).replace(/\\/g, '/');
      (ehNes(rel) ? nes : achados).push(rel);
    }
  }
  for (const n of nes) {
    console.log('pula   ' + path.basename(n, '.asm').padEnd(12) +
                ' é de NES: o dasm.exe não tem as diretivas (vai no nes-test.js)');
  }
  return achados;
}

const CASES = acharFontes();

function findDasm() {
  const i = process.argv.indexOf('--dasm');
  const tries = [
    i >= 0 ? process.argv[i + 1] : null,
    process.env.DASM,
    'C:\\tools\\dasm\\dasm.exe',
    path.join(ROOT, 'tools', 'dasm.exe'),
  ];
  for (const t of tries) if (t && fs.existsSync(t)) return t;
  return null;
}

/* o .sym do DASM: "nome   valor   (R )", com ???? no que ficou sem resolver */
function readSym(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\S+)\s+([0-9a-fA-F]{4,8})\s/.exec(line);
    if (m && !line.startsWith('---') && !line.includes('????')) {
      out.set(m[1], parseInt(m[2], 16) & 0xffff);
    }
  }
  return out;
}

/* --- as cópias embutidas ---------------------------------------------------- */
function checkEmbedded() {
  let bad = 0;

  for (const name of ['vcs.h', 'macro.h']) {
    const disk = fs.readFileSync(path.join(ROOT, name), 'latin1').replace(/\r\n?/g, '\n');
    const built = String(DASM.BUILTIN[name]).replace(/\r\n?/g, '\n');
    if (disk !== built) {
      bad++;
      console.log('DIFERE ' + name + ' embutido no dasm.js está diferente do arquivo na raiz');
    } else {
      console.log('ok     ' + name.padEnd(12) + ' embutido igual ao da raiz');
    }
  }

  /* os editores moram todos no index.html daqui do tools, cada um dentro de
     um <template>; e la que as copias embutidas tem que estar em dia */
  const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

  // a tabela NTSC vive duas vezes: no palette.js e dentro da página
  const inPage = /const NTSC = \[([\s\S]*?)\];/.exec(page);
  const fromPage = inPage ? (inPage[1].match(/'[0-9a-f]{6}'/g) || []).map(s => s.slice(1, -1)) : [];
  const { NTSC } = require('./palette.js');
  if (fromPage.length !== NTSC.length || fromPage.some((v, i) => v !== NTSC[i])) {
    bad++;
    console.log('DIFERE a paleta NTSC do palette.js não bate com a do index.html');
  } else {
    console.log('ok     palette.js   NTSC igual à do index.html (' + NTSC.length + ' cores)');
  }

  // dasm.js, vcs.js e nes.js vivem inteiros dentro do index.html, cada um sem a
  // sua linha final de module.exports
  // Cada editor e um documento separado, entao o montador aparece duas vezes: o
  // de Atari monta o .asm, o de NES remonta a linha reescrita no painel de
  // codigo. Conferir so a primeira copia deixaria a outra envelhecer sem
  // ninguem notar -- por isso a conta aqui e por <template>.
  const limpo = t => t.replace(/\r\n/g, '\n');
  const corpo = limpo(page);
  const trecho = id => {
    const m = corpo.match(new RegExp('<template id="' + id + '">([\\s\\S]*?)</template>'));
    return m ? m[1] : '';
  };
  const ONDE = {
    'dasm.js': ['src-atari', 'src-nes'],
    'vcs.js': ['src-atari'],
    'nes.js': ['src-nes'],
  };
  for (const name of Object.keys(ONDE)) {
    const mod = limpo(fs.readFileSync(path.join(ROOT, 'tools', name), 'utf8'))
      .replace(/\nif \(typeof module[^\n]*\n/, '\n')
      .trim();
    const faltam = ONDE[name].filter(id => !trecho(id).includes(mod));
    if (faltam.length) {
      bad++;
      console.log('DIFERE ' + name + ' embutido está velho em ' + faltam.join(' e ') +
                  ' — reembuta a versão nova');
    } else {
      console.log('ok     ' + name.padEnd(12) + ' embutido igual em ' + ONDE[name].join(' e '));
    }
  }
  return bad;
}

/* --- os fontes -------------------------------------------------------------- */
function checkSources(dasmExe, tmp) {
  let bad = 0;
  for (const rel of CASES) {
    const stem = path.basename(rel, '.asm');
    const asm = path.join(ROOT, rel);
    const source = fs.readFileSync(asm, 'latin1');

    const t0 = Date.now();
    const mine = DASM.assemble({
      name: path.basename(rel),
      source,
      defines: (DEFINES[stem] || []).reduce((o, d) => {
        const m = /^-D(\w+)=(.*)$/.exec(d);
        return m ? Object.assign(o, { [m[1]]: m[2] }) : o;
      }, {}),
    });
    const ms = Date.now() - t0;

    if (!mine.ok) {
      bad++;
      console.log('FALHOU ' + stem);
      for (const p of mine.problems.filter(p => p.kind === 'error').slice(0, 8)) {
        console.log('       ' + p.file + ':' + p.line + ' ' + p.message);
      }
      continue;
    }

    const bin = path.join(tmp, stem + '.bin');
    const sym = path.join(tmp, stem + '.sym');
    const run = spawnSync(dasmExe, [asm, '-f3', '-o' + bin, '-s' + sym, '-I' + ROOT]
      .concat(DEFINES[stem] || []), { encoding: 'latin1' });
    if (run.status !== 0 || !fs.existsSync(bin)) {
      bad++;
      console.log('DASM  ' + stem + ': o dasm.exe recusou o fonte\n' + (run.stdout || '') + (run.stderr || ''));
      continue;
    }

    const notes = [];
    const ref = fs.readFileSync(bin);
    if (ref.length !== mine.rom.length) {
      notes.push('tamanho: js=' + mine.rom.length + ' dasm=' + ref.length);
    } else {
      const diff = [];
      for (let i = 0; i < ref.length; i++) if (ref[i] !== mine.rom[i]) diff.push(i);
      if (diff.length) {
        notes.push(diff.length + ' bytes diferentes, a partir de $' +
          (mine.origin + diff[0]).toString(16) +
          ' (js=' + mine.rom[diff[0]].toString(16) + ' dasm=' + ref[diff[0]].toString(16) + ')');
      }
    }

    const refSym = readSym(fs.readFileSync(sym, 'latin1'));
    const mySym = new Map(mine.symbols.map(s => [s.name, s.value & 0xffff]));
    const missing = [], wrong = [];
    for (const [k, v] of refSym) {
      if (!mySym.has(k)) missing.push(k);
      else if (mySym.get(k) !== v) wrong.push(k + ' js=' + mySym.get(k).toString(16) + ' dasm=' + v.toString(16));
    }
    if (missing.length) notes.push(missing.length + ' símbolos faltando (' + missing.slice(0, 3) + ')');
    if (wrong.length) notes.push(wrong.length + ' símbolos errados (' + wrong.slice(0, 3) + ')');

    if (notes.length) { bad++; console.log('DIFERE ' + stem + ': ' + notes.join('; ')); }
    else {
      console.log('ok     ' + stem.padEnd(12) + ' ' + mine.size + ' bytes, ' + refSym.size +
                  ' símbolos, ' + mine.passes + ' passes, ' + ms + ' ms');
    }
  }
  return bad;
}

/* --- main -------------------------------------------------------------------- */
let bad = checkEmbedded();

const dasmExe = findDasm();
if (!dasmExe) {
  console.log('');
  console.log('não achei o dasm.exe — sem ele não dá para comparar com a referência.');
  console.log('passe o caminho com --dasm, ou ponha em C:\\tools\\dasm\\dasm.exe.');
  process.exit(bad ? 1 : 0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dasm-test-'));
try {
  bad += checkSources(dasmExe, tmp);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(bad ? bad + ' diferença(s) — veja acima'
                : CASES.length + ' fonte(s) idênticos ao ' + path.basename(dasmExe) + ', cópias embutidas em dia');
process.exit(bad ? 1 : 0);
