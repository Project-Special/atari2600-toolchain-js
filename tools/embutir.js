/* ============================================================================
   embutir.js -- repoe as copias dos modulos dentro do index.html

   O index.html e um arquivo so de proposito: abrir direto do disco, sem
   servidor, sem instalar nada. O preco e que dasm.js, vcs.js e nes.js vivem
   duplicados la dentro -- e o montador aparece duas vezes, porque cada editor
   e um documento separado e os dois precisam dele.

   Editar o modulo e esquecer de repor a copia e o erro obvio, e o dasm-test.js
   acusa quando acontece. Este script e o conserto: roda e a copia volta a
   bater. As regioes sao delimitadas por marcas no proprio index.html.

   Repoe tambem o exemplo que a aba Fonte carrega: e sempre o ultimo da serie
   Arq_asm/nes-nave-N.asm, para o botao nunca trazer uma versao anterior.

       node tools/embutir.js            repoe o que estiver velho
       node tools/embutir.js --conferir so diz o que esta velho, sem gravar

   Dominio publico.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const AQUI = __dirname;
const PAGINA = path.join(AQUI, 'index.html');

/* onde cada modulo tem que aparecer */
const ONDE = {
  'dasm.js': ['src-atari', 'src-nes'],
  'vcs.js': ['src-atari'],
  'nes.js': ['src-nes'],
};

const marcaIni = (nome, alvo) => '/* @embutido ' + nome + ' em ' + alvo + ' */';
const marcaFim = (nome, alvo) => '/* @fim ' + nome + ' em ' + alvo + ' */';

/* o modulo como ele tem que aparecer embutido: sem a linha do module.exports,
   que so faz sentido para o Node */
function corpo(nome) {
  return fs.readFileSync(path.join(AQUI, nome), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\nif \(typeof module[^\n]*\n/, '\n')
    .trim();
}

/* Acha a regiao do modulo dentro de um <template>. Com as marcas no lugar e
   direto; sem elas -- na primeira vez -- vale a assinatura do arquivo: comeca
   no cabecalho de comentario e termina no fecho da funcao que o embrulha. */
function acharRegiao(texto, nome, alvo, novo) {
  const ini = marcaIni(nome, alvo), fim = marcaFim(nome, alvo);
  const a = texto.indexOf(ini);
  if (a >= 0) {
    const b = texto.indexOf(fim, a);
    if (b < 0) throw new Error('marca de fim sumiu: ' + fim);
    return { de: a, ate: b + fim.length, tinhaMarca: true };
  }
  const cabeca = novo.slice(0, novo.indexOf('\n', novo.indexOf('\n') + 1));
  const c = texto.indexOf(cabeca);
  if (c < 0) return null;
  const d = texto.indexOf('\n})();', c);
  if (d < 0) throw new Error('não achei o fecho de ' + nome);
  return { de: c, ate: d + '\n})();'.length, tinhaMarca: false };
}

/* o ultimo da serie nes-nave-N.asm, que e o que a aba Fonte oferece */
function exemploMaisNovo() {
  const dir = path.join(AQUI, '..', 'Arq_asm');
  let nomes = [];
  try { nomes = fs.readdirSync(dir); } catch (err) { return null; }
  const serie = nomes.filter(n => /^nes-nave-\d+\.asm$/i.test(n))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
  if (!serie.length) return null;
  const nome = serie[serie.length - 1];
  return { nome, texto: fs.readFileSync(path.join(dir, nome), 'utf8').replace(/\r\n/g, '\n') };
}

function reporExemplo(plano, soConferir) {
  const ex = exemploMaisNovo();
  if (!ex) { console.log('FALTA  nenhum Arq_asm/nes-nave-N.asm'); return { plano, mexeu: 0 }; }
  const marca = /(<script type="text\/plain" id="exemploAsm">\n)([\s\S]*?)(<\/script>)/;
  const m = marca.exec(plano);
  if (!m) { console.log('FALTA  o <script id="exemploAsm"> não está no index.html'); return { plano, mexeu: 0 }; }
  if (m[2] === ex.texto) {
    console.log('ok     exemplo   ' + ex.nome + ' já está embutido');
    return { plano, mexeu: 0 };
  }
  console.log((soConferir ? 'VELHO  ' : 'reposto') + ' exemplo   agora é ' + ex.nome);
  if (soConferir) return { plano, mexeu: 1 };
  return { plano: plano.replace(marca, (t, a, b, c) => a + ex.texto + c), mexeu: 1 };
}

function main() {
  const soConferir = process.argv.includes('--conferir');
  let pagina = fs.readFileSync(PAGINA, 'utf8');
  const quebra = pagina.includes('\r\n') ? '\r\n' : '\n';
  let plano = pagina.replace(/\r\n/g, '\n');
  let mexeu = 0, ok = 0;

  for (const nome of Object.keys(ONDE)) {
    const novo = corpo(nome);
    for (const alvo of ONDE[nome]) {
      const t = new RegExp('<template id="' + alvo + '">([\\s\\S]*?)</template>');
      const m = t.exec(plano);
      if (!m) { console.log('FALTA  <template id="' + alvo + '"> não existe'); continue; }

      const dentro = m[1];
      const reg = acharRegiao(dentro, nome, alvo, novo);
      if (!reg) { console.log('FALTA  ' + nome + ' não está em ' + alvo); continue; }

      const atual = dentro.slice(reg.de, reg.ate);
      const desejado = marcaIni(nome, alvo) + '\n' + novo + '\n' + marcaFim(nome, alvo);
      if (atual === desejado) {
        console.log('ok     ' + nome.padEnd(9) + ' em ' + alvo + ' já está em dia');
        ok++;
        continue;
      }
      mexeu++;
      console.log((soConferir ? 'VELHO  ' : 'reposto') + ' ' + nome.padEnd(9) + ' em ' + alvo +
                  (reg.tinhaMarca ? '' : '  (marcas colocadas agora)'));
      if (soConferir) continue;
      const novoDentro = dentro.slice(0, reg.de) + desejado + dentro.slice(reg.ate);
      plano = plano.slice(0, m.index) +
              '<template id="' + alvo + '">' + novoDentro + '</template>' +
              plano.slice(m.index + m[0].length);
    }
  }

  const r = reporExemplo(plano, soConferir);
  plano = r.plano;
  mexeu += r.mexeu;
  if (!r.mexeu) ok++;

  if (!mexeu) { console.log(ok + ' cópia(s) em dia, nada a fazer'); return 0; }
  if (soConferir) { console.log(mexeu + ' cópia(s) velha(s) — rode sem --conferir'); return 1; }
  fs.writeFileSync(PAGINA, quebra === '\r\n' ? plano.replace(/\n/g, '\r\n') : plano);
  console.log(mexeu + ' cópia(s) reposta(s) no index.html');
  return 0;
}

process.exit(main());
