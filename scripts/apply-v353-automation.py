from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("uso: apply-v353-automation.py <repo-root>")

root = Path(sys.argv[1])
app_dir = root / "riflessahairbeauty-app-registratore/Riflessabeautyapp_v3.5.2_receipt_actions"
app = app_dir / "js/app.js"
index = app_dir / "index.html"
main = app_dir / "electron/main.js"
guide_old = root / "Guida_Riflessa_App_Registratore_3.5.2.txt"
guide_new = root / "Guida_Riflessa_App_Registratore_3.5.3.txt"

# ---------------- app.js ----------------
s = app.read_text(encoding="utf-8")

# Elimina il vecchio fallback di registrazione Z manuale.
s = s.replace('$("confirmFiscalCloseBtn").onclick = confirmFiscalClose;\n', '')
s, n = re.subn(
    r'\nasync function confirmFiscalClose\(\)\{.*?\n\}\nfunction renderFiscalClose\(\)\{',
    '\nfunction renderFiscalClose(){',
    s,
    count=1,
    flags=re.S,
)
if n != 1:
    raise SystemExit(f"confirmFiscalClose non rimossa: {n}")

# La pressione del pulsante Z e' gia' l'azione deliberata: elimina doppia/tripla conferma.
s = s.replace('  if(!$("fiscalCloseArm").checked)return toast("Spunta la conferma prima di eseguire la chiusura fiscale","error");\n', '')
s = s.replace('  if(!confirm("Eseguire ora la chiusura fiscale? L’operazione verrà inviata una sola volta."))return;\n', '')

# Sostituisce il salvataggio minimale della Z con uno snapshot gestionale completo e collegamenti.
pattern = re.compile(
    r'    const z=r\?\.status\?\.ej\?\.lastdoc\?\.zno\|\|"";\n'
    r'    await addDoc\(collection\(db,"fiscalClosures"\),\{.*?\}\);\n'
    r'    \$\("fiscalCloseArm"\)\.checked=false;',
    re.S,
)
replacement = '''    const z=r?.status?.ej?.lastdoc?.zno||"";
    const daySales=printedSales().filter(s=>session?s.cashSessionId===session.id:s.businessDate===today);
    const dayReturns=state.returns.filter(x=>(session?x.cashSessionId===session.id:x.businessDate===today)&&x.status!=="cancelled");
    const dayExpenses=state.expenses.filter(x=>session?x.cashSessionId===session.id:x.businessDate===today);
    const dayMovements=state.cashMovements.filter(x=>session?x.cashSessionId===session.id:x.businessDate===today);
    const salesTotalCents=daySales.reduce((a,x)=>a+Number(x.totalCents||0),0);
    const returnsTotalCents=dayReturns.reduce((a,x)=>a+Number(x.totalCents||0),0);
    const receiptRefs=daySales.map(x=>({
      id:x.id,fiscalZ:x.fiscalZ||"",fiscalDocNo:x.fiscalDocNo||"",totalCents:Number(x.totalCents||0),
      paymentMethod:x.paymentMethod||"",payments:Array.isArray(x.payments)?x.payments:[],createdAtClient:x.createdAtClient||"",
      operatorUid:x.operatorUid||"",staffId:x.staffId||"",staffName:x.staffName||""
    }));
    const returnRefs=dayReturns.map(x=>({id:x.id,saleId:x.saleId||"",type:x.type||"",totalCents:Number(x.totalCents||0),refundMethod:x.refundMethod||"",createdAtClient:x.createdAtClient||""}));
    const expenseRefs=dayExpenses.map(x=>({id:x.id,amountCents:Number(x.amountCents||0),category:x.category||"",paymentMethod:x.paymentMethod||"",createdAtClient:x.createdAtClient||""}));
    const movementRefs=dayMovements.map(x=>({id:x.id,type:x.type||"",amountCents:Number(x.amountCents||0),reason:x.reason||"",createdAtClient:x.createdAtClient||""}));
    const cashSessionSnapshot=session?{
      id:session.id,openedAtClient:session.openedAtClient||"",closedAtClient:session.closedAtClient||"",
      openingFloatCents:Number(session.openingFloatCents||0),cashSalesCents:Number(session.cashSalesCents||0),
      cardSalesCents:Number(session.cardSalesCents||0),cashReturnsCents:Number(session.cashReturnsCents||0),
      cardReturnsCents:Number(session.cardReturnsCents||0),otherSalesCents:Number(session.otherSalesCents||0),
      cashExpensesCents:Number(session.cashExpensesCents||0),cashDepositsCents:Number(session.cashDepositsCents||0),
      cashWithdrawalsCents:Number(session.cashWithdrawalsCents||0),expectedCashCents:Number(session.expectedCashCents||0),
      actualCashCents:Number(session.actualCashCents||0),differenceCents:Number(session.differenceCents||0),
      closingNotes:session.closingNotes||"",closedBy:session.closedBy||""
    }:null;
    const closureRef=await addDoc(collection(db,"fiscalClosures"),{
      confirmedAt:serverTimestamp(),confirmedAtClient:new Date().toISOString(),businessDate:today,
      operatorUid:auth.currentUser.uid,operatorEmail:auth.currentUser.email||"",
      rtSerial:r?.status?.device?.serial||"8AIGE005584",method:"remote-x7",status:"success",
      reference:z?`Z ${z}`:"Chiusura RT completata",zNumber:z||"",cashSessionId:session?.id||"",
      receiptCount:daySales.length,receiptIds:daySales.map(x=>x.id),receiptRefs,
      salesTotalCents,returnCount:dayReturns.length,returnIds:dayReturns.map(x=>x.id),returnRefs,
      returnsTotalCents,netSalesCents:salesTotalCents-returnsTotalCents,
      expenseCount:dayExpenses.length,expenseRefs,movementCount:dayMovements.length,movementRefs,
      cashSessionSnapshot,fiscalResult:JSON.stringify(r).slice(0,15000),dataVersion:2,
      transmissionStatus:"checking",transmissionCheckedAtClient:"",
      note:"Chiusura fiscale automatica confermata dal DADO e registrata dal gestionale."
    });
    try{
      for(let i=0;i<daySales.length;i+=400){
        const batch=writeBatch(db);
        daySales.slice(i,i+400).forEach(sale=>batch.update(doc(db,"sales",sale.id),{
          fiscalClosureId:closureRef.id,
          fiscalClosureReference:z?`Z ${z}`:"Chiusura RT completata",
          fiscalClosedAtClient:new Date().toISOString()
        }));
        await batch.commit();
      }
    }catch(linkError){
      console.warn("Chiusura registrata, ma collegamento di alcuni scontrini non riuscito:",linkError);
    }
    scheduleFiscalTransmissionChecks(closureRef.id);'''
s, n = pattern.subn(replacement, s, count=1)
if n != 1:
    raise SystemExit(f"blocco successo Z non sostituito: {n}")

# Messaggio di successo coerente con il nuovo comportamento.
s = s.replace(
    '    out.textContent=`Chiusura fiscale completata${z?` · Z ${z}`:""}. Verifica il documento stampato.`;out.className="notice notice-success";toast("Chiusura fiscale completata","success");',
    '    out.textContent=`Chiusura fiscale completata${z?` · Z ${z}`:""}. Registrazione gestionale completata; controllo invio automatico avviato.`;out.className="notice notice-success";toast("Chiusura fiscale registrata automaticamente","success");'
)

# Helpers per controllo XML automatico e ricontrolli passivi, senza reinviare mai la Z.
old_check = '''async function checkFiscalXml(){
  const out=$("fiscalCloseResult");
  if(!window.axonPrinter?.listFiscalXml)return toast("Controllo disponibile solo nell'app Windows","error");
  out.textContent="Controllo XML fiscali SENT/TOSEND...";out.className="notice";
  try{
    const r=await window.axonPrinter.listFiscalXml();
    if(!r?.ok)throw new Error(r?.message||"Lettura XML non riuscita");
    const cleanFiles=x=>(x?.fileslist||x?.files||[]).filter(f=>f&&f.name);
    const pending=cleanFiles(r.tosend).length;
    const sent=cleanFiles(r.sent).length;
    out.textContent=`XML RT: ${pending} in TOSEND · ${sent} elementi in SENT. ${pending?"Controlla le trasmissioni in attesa.":"Nessun XML in attesa rilevato."}`;out.className=`notice ${pending?"notice-warning":"notice-success"}`;
  }catch(e){out.textContent=`Controllo XML non riuscito: ${e.message||e}`;out.className="notice notice-error";}
}
'''
new_check = '''async function readFiscalXmlSummary(){
  if(!window.axonPrinter?.listFiscalXml)throw new Error("Controllo disponibile solo nell'app Windows");
  const r=await window.axonPrinter.listFiscalXml();
  if(!r?.ok)throw new Error(r?.message||"Lettura XML non riuscita");
  const cleanFiles=x=>(x?.fileslist||x?.files||[]).filter(f=>f&&f.name);
  return {pending:cleanFiles(r.tosend).length,sent:cleanFiles(r.sent).length};
}
async function runAutomaticFiscalTransmissionCheck(closureId,attempt=1){
  try{
    const summary=await readFiscalXmlSummary();
    const status=summary.pending>0?"pending":"clear";
    await updateDoc(doc(db,"fiscalClosures",closureId),{
      transmissionStatus:status,xmlPendingCount:summary.pending,xmlSentCount:summary.sent,
      transmissionCheckAttempt:attempt,transmissionCheckedAt:serverTimestamp(),transmissionCheckedAtClient:new Date().toISOString()
    });
    if(state.currentView==="closing"){
      const out=$("fiscalCloseResult");
      out.textContent=`Chiusura registrata · XML RT: ${summary.pending} in attesa · ${summary.sent} in SENT.${summary.pending&&attempt<4?" Ricontrollo automatico tra 30 secondi.":summary.pending?" Verifica il registratore se restano elementi in attesa.":" Invio senza XML in attesa."}`;
      out.className=`notice ${summary.pending?"notice-warning":"notice-success"}`;
    }
    if(summary.pending>0&&attempt<4)setTimeout(()=>runAutomaticFiscalTransmissionCheck(closureId,attempt+1),30000);
  }catch(e){
    try{await updateDoc(doc(db,"fiscalClosures",closureId),{transmissionStatus:"check-error",transmissionCheckError:String(e?.message||e).slice(0,500),transmissionCheckedAtClient:new Date().toISOString()});}catch{}
    console.warn("Controllo automatico invio fiscale non riuscito",e);
  }
}
function scheduleFiscalTransmissionChecks(closureId){
  setTimeout(()=>runAutomaticFiscalTransmissionCheck(closureId,1),1200);
}
async function checkFiscalXml(){
  const out=$("fiscalCloseResult");
  out.textContent="Ricontrollo XML fiscali SENT/TOSEND...";out.className="notice";
  try{
    const summary=await readFiscalXmlSummary();
    out.textContent=`XML RT: ${summary.pending} in TOSEND · ${summary.sent} elementi in SENT. ${summary.pending?"Sono presenti trasmissioni in attesa.":"Nessun XML in attesa rilevato."}`;
    out.className=`notice ${summary.pending?"notice-warning":"notice-success"}`;
  }catch(e){out.textContent=`Controllo XML non riuscito: ${e.message||e}`;out.className="notice notice-error";}
}
'''
if old_check not in s:
    raise SystemExit("checkFiscalXml originale non trovato")
s = s.replace(old_check, new_check)

# Storico: mostra anche la Z e i dati aggregati della chiusura fiscale automatica.
render_pattern = re.compile(r'function renderClosures\(\)\{.*?\n\}\n\nfunction todaySuccessfulFiscalClose\(\)\{', re.S)
render_replacement = '''function renderClosures(){
  const rows=state.cashSessions.filter(x=>x.status==="closed");
  $("closuresTable").innerHTML=`<table class="data-table"><thead><tr><th>Data</th><th>Fondo</th><th>Contanti</th><th>Carta</th><th>Atteso</th><th>Effettivo</th><th>Differenza</th><th>Z</th><th>Scontrini</th><th>Netto</th><th>Invio</th></tr></thead><tbody>${rows.map(x=>{const f=state.fiscalClosures.find(c=>c.cashSessionId===x.id&&c.status==="success")||state.fiscalClosures.find(c=>c.businessDate===x.businessDate&&c.status==="success");const invio=f?.transmissionStatus==="clear"?"OK":f?.transmissionStatus==="pending"?"In attesa":f?.transmissionStatus==="check-error"?"Da verificare":f?"Controllo…":"-";return `<tr><td>${fmtDateTime(x.closedAt||x.closedAtClient)}</td><td>${euro(x.openingFloatCents||0)}</td><td>${euro(x.cashSalesCents||0)}</td><td>${euro(x.cardSalesCents||0)}</td><td>${euro(x.expectedCashCents||0)}</td><td>${euro(x.actualCashCents||0)}</td><td><strong>${euro(x.differenceCents||0)}</strong></td><td>${escapeHtml(f?.reference||"-")}</td><td>${f?Number(f.receiptCount||0):"-"}</td><td>${f?euro(f.netSalesCents||0):"-"}</td><td>${invio}</td></tr>`;}).join("")}</tbody></table>`;
}

function todaySuccessfulFiscalClose(){'''
s, n = render_pattern.subn(render_replacement, s, count=1)
if n != 1:
    raise SystemExit(f"renderClosures non aggiornato: {n}")

# Stato ultima chiusura con controllo invio automatico.
old_render_fiscal = 'function renderFiscalClose(){\n  const x=state.fiscalClosures[0];\n  $("lastFiscalClose").textContent=x?`Ultima chiusura: ${fmtDateTime(x.confirmedAt||x.confirmedAtClient)}${x.reference?" · "+x.reference:""}`:"Nessuna chiusura fiscale registrata nell\'app.";'
new_render_fiscal = 'function renderFiscalClose(){\n  const x=state.fiscalClosures[0];\n  const tx=x?.transmissionStatus==="clear"?" · invio OK":x?.transmissionStatus==="pending"?` · ${Number(x.xmlPendingCount||0)} XML in attesa`:x?.transmissionStatus==="check-error"?" · controllo invio da verificare":"";\n  $("lastFiscalClose").textContent=x?`Ultima chiusura: ${fmtDateTime(x.confirmedAt||x.confirmedAtClient)}${x.reference?" · "+x.reference:""}${tx}`:"Nessuna chiusura fiscale registrata nell\'app.";'
if old_render_fiscal not in s:
    raise SystemExit("renderFiscalClose originale non trovato")
s = s.replace(old_render_fiscal, new_render_fiscal)

s = s.replace('version:"3.5.2"', 'version:"3.5.3"')
app.write_text(s, encoding="utf-8")

# ---------------- index.html ----------------
h = index.read_text(encoding="utf-8")
h, n = re.subn(r'\n\s*<div class="manual-fallback">.*?</div>', '', h, count=1, flags=re.S)
if n != 1:
    raise SystemExit(f"fallback manuale HTML non rimosso: {n}")

old_sequence = '''              <div class="fiscal-sequence">
                <div><span>1</span><p>Registra la quadratura della cassa.</p></div>
                <div><span>2</span><p>Spunta la conferma di sicurezza.</p></div>
                <div><span>3</span><p>Attendi la stampa del documento di chiusura.</p></div>
              </div>
              <label class="check-row fiscal-confirm"><input id="fiscalCloseArm" type="checkbox"> Confermo di voler eseguire la chiusura fiscale della giornata.</label>
              <div class="button-row"><button id="runFiscalCloseBtn" class="btn btn-danger">Chiudi giornata fiscale</button><button id="printSoldTotalsBtn" class="btn btn-soft">Stampa totali</button><button id="checkFiscalXmlBtn" class="btn btn-ghost">Controlla invio</button></div>'''
new_sequence = '''              <div class="fiscal-sequence">
                <div><span>1</span><p>Registra la quadratura della cassa.</p></div>
                <div><span>2</span><p>Premi una sola volta “Chiudi giornata fiscale”.</p></div>
                <div><span>3</span><p>L’app registra automaticamente la Z, collega gli scontrini e controlla l’invio.</p></div>
              </div>
              <div class="button-row"><button id="runFiscalCloseBtn" class="btn btn-danger">Chiudi giornata fiscale</button><button id="printSoldTotalsBtn" class="btn btn-soft">Stampa totali</button><button id="checkFiscalXmlBtn" class="btn btn-ghost">Ricontrolla invio</button></div>'''
if old_sequence not in h:
    raise SystemExit("sequenza fiscale HTML originale non trovata")
h = h.replace(old_sequence, new_sequence)
index.write_text(h, encoding="utf-8")

# ---------------- Electron log bridge ----------------
m = main.read_text(encoding="utf-8")
old_limit = 'const length = Math.max(1, Math.min(240 * 1024, requestedLength || 240 * 1024, Math.max(0, stat.size - offset)));'
new_limit = 'const length = Math.max(1, Math.min(768 * 1024, requestedLength || 768 * 1024, Math.max(0, stat.size - offset)));'
if old_limit not in m:
    raise SystemExit("limite chunk log originale non trovato")
m = m.replace(old_limit, new_limit)
main.write_text(m, encoding="utf-8")

# ---------------- Guida ----------------
if guide_old.exists():
    g = guide_old.read_text(encoding="utf-8")
    g = g.replace("Versione 3.5.2", "Versione 3.5.3", 1)
    start = "======================================================================\n5.3 CHIUSURA ESEGUITA MANUALMENTE\n======================================================================"
    next_head = "======================================================================\n5.4 STORICO QUADRATURE\n======================================================================"
    if start in g and next_head in g:
        before, rest = g.split(start, 1)
        _, after = rest.split(next_head, 1)
        auto = '''======================================================================
5.3 REGISTRAZIONE AUTOMATICA DELLA CHIUSURA
======================================================================

Non è prevista una registrazione manuale della chiusura fiscale nell'uso normale.
Dopo la quadratura è sufficiente premere una sola volta "Chiudi giornata fiscale".

Solo quando il DADO RT30 restituisce un esito positivo, il gestionale registra
automaticamente la chiusura e salva/collega:
- data e ora;
- operatore;
- seriale RT;
- numero/riferimento Z quando disponibile;
- quadratura completa della cassa;
- contanti, carta, resi e totale netto;
- tutti gli scontrini della sessione;
- spese e movimenti di cassa;
- risposta tecnica del registratore.

Subito dopo, l'app controlla automaticamente gli XML fiscali SENT/TOSEND. Se trova XML
in attesa, esegue fino a tre ricontrolli passivi a distanza di 30 secondi. Questi controlli
NON reinviano la chiusura Z e non duplicano operazioni fiscali.

Se l'esito della chiusura è incerto o negativo, non viene registrato come successo e
l'app non ripete automaticamente il comando fiscale.

======================================================================
5.4 STORICO QUADRATURE
======================================================================'''
        g = before + auto + after
    g = g.replace('2. Spuntare:\n   "Confermo di voler eseguire la chiusura fiscale della giornata."\n3. Premere:\n   "Chiudi giornata fiscale".\n4. Attendere la stampa del documento di chiusura.\n5. Controllare l\'esito.', '2. Premere una sola volta "Chiudi giornata fiscale".\n3. Attendere la stampa del documento di chiusura.\n4. L’app registra automaticamente la chiusura e controlla lo stato dell’invio.')
    guide_new.write_text(g, encoding="utf-8")
    guide_old.unlink()

# ---------------- Test automatici ----------------
test_file = app_dir / "tests/automatic-fiscal-closure.test.js"
test_file.write_text('''const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const root=path.join(__dirname,"..");
const html=fs.readFileSync(path.join(root,"index.html"),"utf8");
const app=fs.readFileSync(path.join(root,"js","app.js"),"utf8");
const main=fs.readFileSync(path.join(root,"electron","main.js"),"utf8");

test("chiusura fiscale usa un solo gesto operatore e nessun fallback manuale",()=>{
  assert.equal(html.includes("manual-fallback"),false);
  assert.equal(html.includes("confirmFiscalCloseBtn"),false);
  assert.equal(html.includes("fiscalCloseArm"),false);
  assert.equal(app.includes("manual-keypad"),false);
  assert.equal(app.includes("confirmFiscalClose"),false);
  assert.equal(app.includes("Eseguire ora la chiusura fiscale?"),false);
});

test("chiusura riuscita salva riepilogo e collega gli scontrini",()=>{
  for(const token of ["receiptRefs","cashSessionSnapshot","closureRef","fiscalClosureId","returnsTotalCents","expenseRefs","movementRefs"]) assert.equal(app.includes(token),true,token);
});

test("controllo invio fiscale parte automaticamente senza reinvio Z",()=>{
  for(const token of ["scheduleFiscalTransmissionChecks","runAutomaticFiscalTransmissionCheck","transmissionStatus","xmlPendingCount"]) assert.equal(app.includes(token),true,token);
});

test("bridge log accetta i chunk da 512 KiB del sync V3",()=>{
  assert.equal(main.includes("768 * 1024"),true);
  assert.equal(main.includes("Math.min(240 * 1024"),false);
});
''', encoding="utf-8")

print("Patch automazione 3.5.3 applicata")
