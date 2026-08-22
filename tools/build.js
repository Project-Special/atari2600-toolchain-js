/* ==========================================================================
   Monta um fonte do Atari 2600 pelo terminal, com o montador embutido
   (tools/dasm.js). Mesmo trabalho que o editor faz no F5, mas gravando os
   arquivos em disco — .bin, .lst e .sym.

       node tools/build.js riverraid                    # procura em Arq_asm/ e na raiz
       node tools/build.js ../Roms_meus/riverraid.asm   # ou um caminho qualquer
       node tools/build.js --all                        # todos os fontes do repo
       node tools/build.js jogo.asm --out D:\pasta      # destino fixo

   Para rodar a ROM, use o emulador embutido no editor de sprites
   (tools/index.html, no console Atari: Arquivo > Compilar e rodar).
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const DASM = require('./dasm.js');

const ROOT = path.resolve(__dirname, '..');          // tem vcs.h e macro.h
const SRC_DIRS = [ROOT, path.join(ROOT, 'Arq_asm')].filter(d => fs.existsSync(d));

/* Fontes que endereçam os registradores de leitura da TIA pelo espelho em $30,
   como as fontes originais faziam. Sem isso as leituras caem na RAM. */
const DEFINES = {
  riverraid: { TIA_BASE_READ_ADDRESS: '$30' },
  pitfall:   { TIA_BASE_READ_ADDRESS: '$30' },
  combat:    { TIA_BASE_READ_ADDRESS: '$30' },
};

/* --- linha de comando ------------------------------------------------------ */
function parseArgs(argv) {
  const opts = { all: false, out: 'build', source: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all' || a === '-All' || a === '-a') opts.all = true;
    else if (a === '--out' || a === '-o') opts.out = argv[++i];
    else if (a === '--quiet' || a === '-q') opts.quiet = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a[0] === '-') { console.error('opção desconhecida: ' + a); process.exit(2); }
    else opts.source = a;
  }
  return opts;
}

function usage() {
  console.log([
    'uso: node tools/build.js <fonte|--all> [--out DIR]',
    '',
    '  <fonte>     nome solto ("riverraid") ou caminho para um .asm',
    '  --all       compila todos os .asm de ' + SRC_DIRS.map(d => path.relative(ROOT, d) || '.').join(' e '),
    '  --out DIR   pasta de saída (padrão: build/ ao lado do fonte)',
  ].join('\n'));
}

/* --- onde está o fonte, onde vai a ROM ------------------------------------- */
function resolveSource(name) {
  if (fs.existsSync(name) && fs.statSync(name).isFile()) return path.resolve(name);
  const stem = path.basename(name, path.extname(name));
  for (const dir of SRC_DIRS) {
    const p = path.join(dir, stem + '.asm');
    if (fs.existsSync(p)) return p;
  }
  throw new Error("não achei '" + name + "'. Procurei em: " + SRC_DIRS.join(' , '));
}

/* a ROM sai num build/ ao lado do fonte; fontes do repo vão todos para o build/
   da raiz, para não espalhar uma pasta por subdiretório */
function outputDir(asm, out) {
  if (path.isAbsolute(out)) return out;
  // path.relative devolve caminho absoluto quando os dois estão em unidades
  // diferentes (D: e C:), então não basta olhar o ".." do começo
  const rel = path.relative(ROOT, asm);
  const inRepo = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  return path.join(inRepo ? ROOT : path.dirname(asm), out);
}

/* --- compila ---------------------------------------------------------------- */
function build(asm, opts) {
  const stem = path.basename(asm, path.extname(asm));
  const out = outputDir(asm, opts.out);
  fs.mkdirSync(out, { recursive: true });

  const source = fs.readFileSync(asm, 'latin1');
  const res = DASM.assemble({
    name: path.basename(asm),
    source,
    defines: DEFINES[stem] || {},
    listing: true,
    // um include ao lado do fonte tem preferência sobre o vcs.h/macro.h embutido
    includes: localIncludes(path.dirname(asm)),
  });

  // caminho absoluto na mensagem: é o que o problemMatcher do VS Code espera
  for (const p of res.problems) {
    const file = p.file === path.basename(asm) ? asm : p.file;
    console.log(file + ' (' + p.line + '): ' + p.kind + ': ' + p.message + '.');
  }
  for (const e of res.echoes) console.log(e);

  if (!res.ok) {
    console.log('FAIL  ' + stem);
    return null;
  }

  const bin = path.join(out, stem + '.bin');
  fs.writeFileSync(bin, Buffer.from(res.rom));
  fs.writeFileSync(path.join(out, stem + '.lst'), DASM.listingText(res));
  fs.writeFileSync(path.join(out, stem + '.sym'), DASM.symbolText(res));

  if (!opts.quiet) {
    const kb = (res.size / 1024).toFixed(1);
    console.log('ok    ' + stem.padEnd(12) + ' ->  ' + path.relative(process.cwd(), bin) + '  (' + kb + ' KB)');
  }
  return bin;
}

/* .h ao lado do fonte, para quem tem uma versão própria do vcs.h */
function localIncludes(dir) {
  const found = {};
  for (const d of new Set([dir, ROOT])) {
    let names = [];
    try { names = fs.readdirSync(d); } catch (err) { continue; }
    for (const n of names) {
      if (/\.(h|inc)$/i.test(n)) found[n] = fs.readFileSync(path.join(d, n), 'latin1');
    }
  }
  return found;
}

/* --- main ------------------------------------------------------------------- */
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { usage(); return 0; }

  if (opts.all) {
    const seen = new Set();
    let bad = 0;
    for (const dir of SRC_DIRS) {
      for (const name of fs.readdirSync(dir).sort()) {
        if (!/\.asm$/i.test(name) || seen.has(name)) continue;
        seen.add(name);
        if (!build(path.join(dir, name), opts)) bad++;
      }
    }
    return bad ? 1 : 0;
  }

  if (!opts.source) { usage(); return 2; }
  let asm;
  try {
    asm = resolveSource(opts.source);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  return build(asm, opts) ? 0 : 1;
}

process.exit(main());
