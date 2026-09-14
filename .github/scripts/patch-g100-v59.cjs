const fs = require('fs');
const path = require('path');

const root = path.resolve(process.argv[2] || '');
if (!root || !fs.existsSync(root)) throw new Error('Root app non valida');

function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function write(rel, txt) { fs.writeFileSync(path.join(root, rel), txt, 'utf8'); }
function replaceOne(rel, from, to) {
  let txt = read(rel);
  const count = txt.split(from).length - 1;
  if (count !== 1) throw new Error(`${rel}: attesa 1 occorrenza, trovate ${count}: ${from.slice(0,100)}`);
  txt = txt.replace(from, to);
  write(rel, txt);
}

const fiscal = 'electron/axon/fiscal.js';
replaceOne(
  fiscal,
  "  // CashWEB originale: ANNULLO STORNO = KOP.PVOID = 9, idx 0, browse 0.\n  // Una sola scrittura per step. Nessun retry automatico su operazioni fiscali.\n  await operationWrite(9, 0, 0);",
  "  // Protocollo G100 v5.9, tabella codici funzione: ANNULLO SCONTRINO = 11.\n  // Una sola scrittura per step. Nessun retry automatico su operazioni fiscali.\n  await operationWrite(11, 0, 0);"
);

replaceOne(
  fiscal,
  "  const serial = safeToken(payload.serial || '', 32);\n  const lottery = safeToken(payload.lottery || '', 32);",
  "  const serial = safeToken(payload.serial || '', 32);\n  const lottery = safeToken(payload.lottery || '', 32);\n  // G100 v5.9: matricola RT esterna = 11 caratteri; codice lotteria = 8 caratteri.\n  if (!sameDevice && serial.length !== 11) throw new Error('Matricola RT esterna non valida: richiesti 11 caratteri');\n  if (lottery && lottery.length !== 8) throw new Error('Codice lotteria non valido: richiesti 8 caratteri');"
);

replaceOne(
  fiscal,
  "    else opener = `+/1/${date}/${zNo}/${docNo}//${serial}//`;",
  "    else opener = `+/1/${date}/${zNo}/${docNo}/${lottery}/${serial}//`;"
);
replaceOne(
  fiscal,
  "    else opener = `-/${date}/${zNo}/${docNo}/${serial}///`;",
  "    else opener = `-/${date}/${zNo}/${docNo}/${serial}/${lottery}//`;"
);

replaceOne(
  fiscal,
  "  const commands = [opener];\n  if (!sameDevice && lottery) commands.push(`I/${lottery}/0/`);",
  "  const commands = [opener];\n\n  // G100 v5.9: se il documento originale e' nel DGFE/MDD corrente, il comando +/1\n  // genera e gestisce automaticamente l'intero documento commerciale di annullo.\n  // Il chiamante abilita questa via SOLO dopo preflight 0/4 riuscito.\n  if (type === 'void' && sameDevice && payload.autoFromCurrentEj === true) return commands;\n\n  if (!sameDevice && lottery) commands.push(`I/${lottery}/0/`);"
);

replaceOne(
  fiscal,
  "    const nature = vatRate === 0 ? safeToken(line.nature || '', 8) : '';\n    if (vatRate === 0 && !nature) throw new Error(`Natura IVA 0 mancante per il reparto ${departmentId}`);",
  "    const nature = vatRate === 0 ? safeToken(line.nature || '', 8).toUpperCase() : '';\n    if (vatRate === 0 && !nature) throw new Error(`Natura IVA 0 mancante per il reparto ${departmentId}`);\n    if (vatRate === 0 && !['N1','N2','N3','N4','N5','N6','VI'].includes(nature)) {\n      throw new Error(`Natura IVA 0 non valida per G100 v5.9 nel reparto ${departmentId}`);\n    }"
);
replaceOne(
  fiscal,
  "      commands.push(`3/${op}/${desc}//1.00/${money(g.amountCents)}/${g.departmentId}/0/${g.nature}//`);",
  "      const vatField = g.nature === 'VI' ? '' : '0';\n      commands.push(`3/${op}/${desc}//1.00/${money(g.amountCents)}/${g.departmentId}/${vatField}/${g.nature}//`);"
);

const main = 'electron/main.js';
replaceOne(
  main,
  "    const commands=buildAfterSaleCommands(payload);\n    const preflight=await executeRaw(profile(), readReceiptCommands(Number(payload?.zNo), Number(payload?.docNo)), l);\n    const before=await getRtStatus();",
  "    const preflight=await executeRaw(profile(), readReceiptCommands(Number(payload?.zNo), Number(payload?.docNo)), l);\n    const commands=buildAfterSaleCommands({\n      ...payload,\n      // Il preflight 0/4 riuscito prova che il riferimento e' leggibile dalla RT corrente.\n      autoFromCurrentEj: payload?.type === 'void' && payload?.sameDevice !== false\n    });\n    const before=await getRtStatus();"
);
replaceOne(
  main,
  "trusted(event); try{return await executeRaw(profile(),['+/'],logger('cancel-open-document'));}catch(e){return{ok:false,message:e.message,noAutomaticRetry:true};}",
  "trusted(event); try{return await executeRaw(profile(),['+/0/'],logger('cancel-open-document'));}catch(e){return{ok:false,message:e.message,noAutomaticRetry:true};}"
);

// Nuovi test di conformita' alla documentazione ufficiale G100 v5.9.
const testPath = path.join(root, 'tests', 'vendor-protocol-v59.test.js');
fs.writeFileSync(testPath, `const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst { buildAfterSaleCommands } = require('../electron/axon/fiscal');\n\nconst mainSrc = fs.readFileSync(path.join(__dirname,'..','electron','main.js'),'utf8');\nconst fiscalSrc = fs.readFileSync(path.join(__dirname,'..','electron','axon','fiscal.js'),'utf8');\nconst base = { date:'2026-09-14', zNo:123, docNo:45, lines:[{qty:1,unitPriceCents:1000,departmentId:1,vatRate:22}] };\n\ntest('G100 v5.9 annulla documento aperto con +/0/', () => {\n  assert.match(mainSrc, /\\['\\+\\/0\\/'\\]/);\n});\n\ntest('G100 v5.9 funzione ANNULLO SCONTRINO usa codice 11', () => {\n  assert.match(fiscalSrc, /operationWrite\\(11, 0, 0\\)/);\n  assert.doesNotMatch(fiscalSrc, /operationWrite\\(9, 0, 0\\)/);\n});\n\ntest('annullo stessa RT letto da 0/4 usa solo apertura automatica G100', () => {\n  const out = buildAfterSaleCommands({ ...base, type:'void', sameDevice:true, autoFromCurrentEj:true });\n  assert.deepEqual(out, ['+/1/14092026/123/45////']);\n});\n\ntest('riferimenti altra RT includono matricola e lotteria nei field ufficiali', () => {\n  const common = { ...base, sameDevice:false, serial:'12345678901', lottery:'ABCDEFGH' };\n  const annul = buildAfterSaleCommands({ ...common, type:'void' });\n  const ret = buildAfterSaleCommands({ ...common, type:'return' });\n  assert.equal(annul[0], '+/1/14092026/123/45/ABCDEFGH/12345678901//');\n  assert.equal(ret[0], '-/14092026/123/45/12345678901/ABCDEFGH//');\n  assert.equal(annul[1], 'I/ABCDEFGH/0/');\n  assert.equal(ret[1], 'I/ABCDEFGH/0/');\n});\n\ntest('matricola e lotteria esterne rispettano lunghezze G100', () => {\n  assert.throws(() => buildAfterSaleCommands({ ...base, type:'return', sameDevice:false, serial:'123', lottery:'' }), /11 caratteri/);\n  assert.throws(() => buildAfterSaleCommands({ ...base, type:'return', sameDevice:false, serial:'12345678901', lottery:'ABC' }), /8 caratteri/);\n});\n\ntest('natura IVA zero viene validata secondo tabella G100', () => {\n  const valid = buildAfterSaleCommands({ ...base, type:'return', lines:[{qty:1,unitPriceCents:1000,departmentId:1,vatRate:0,nature:'VI'}] });\n  assert.match(valid[1], /\\/1\\/\\/VI\\/\\/$/);\n  assert.throws(() => buildAfterSaleCommands({ ...base, type:'return', lines:[{qty:1,unitPriceCents:1000,departmentId:1,vatRate:0,nature:'N2.2'}] }), /Natura IVA 0 non valida/);\n});\n`, 'utf8');

// Release 3.5.10: npm aggiornera' package.json + package-lock.json nel workflow.
replaceOne('scripts/check-project.js', 'pkg.version !== "3.5.9") { console.error("Versione candidata attesa: 3.5.9"', 'pkg.version !== "3.5.10") { console.error("Versione candidata attesa: 3.5.10"');
replaceOne('tests/auto-update.test.js', "assert.equal(pkg.version, '3.5.9');", "assert.equal(pkg.version, '3.5.10');");

fs.writeFileSync(path.join(root, 'VERSIONE_3_5_10_PROTOCOLLO_G100.txt'), `RIFLESSABEAUTYAPP REGISTRATORE - VERSIONE 3.5.10\nAllineamento protocollo ufficiale Axon Micrelec G100 v5.9\nData: 14/09/2026\n\n- annullo documento aperto: +/0/ come specifica ufficiale;\n- ANNULLO SCONTRINO via OPER_WRITE: codice funzione 11;\n- annullo same-RT con riferimento verificato 0/4: usa emissione automatica prevista dal G100, senza inviare righe/pagamenti aggiuntivi dopo il comando +/1;\n- documenti di altro RT: matricola (11 char) e lotteria (8 char) vengono inserite nei field di riferimento corretti;\n- natura IVA 0 validata sui valori G100 N1-N6/VI; per VI il field aliquota resta vuoto come da specifica;\n- nessuna modifica alla sequenza WebSocket W/ e alla Z x/7/// catturate sul DADO reale: la documentazione non giustifica di sostituire flussi gia' verificati.\n`, 'utf8');

console.log('Patch G100 v5.9 applicata.');
