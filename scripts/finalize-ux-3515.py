from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit('uso: finalize-ux-3515.py <app_dir>')

root = Path(sys.argv[1])
styles = root / 'styles.css'
responsive = root / 'responsive.css'
index = root / 'index.html'
ux = root / 'ui-v3515.css'
test_file = root / 'tests' / 'ux-v3515.test.js'
note = root / 'VERSIONE_3_5_15_UX.txt'

# 1) Correzione alla radice del doppio "Esci" nella sidebar compatta.
styles_text = styles.read_text(encoding='utf-8')
old_sidebar = ".sidebar-bottom .status-row{display:none}.sidebar .btn-ghost{font-size:0}.sidebar .btn-ghost:after{content:'Esci';font-size:11px}"
new_sidebar = ".sidebar-bottom .status-row{display:none}#logoutBtn{font-size:0}.sidebar #logoutBtn:after{content:'Esci';font-size:11px}.sidebar .btn-ghost:not(#logoutBtn){font-size:9px;line-height:1.15;padding-inline:4px;white-space:normal}"
if old_sidebar in styles_text:
    styles_text = styles_text.replace(old_sidebar, new_sidebar, 1)
elif new_sidebar not in styles_text:
    raise SystemExit('regola sidebar compatta attesa non trovata')
styles.write_text(styles_text, encoding='utf-8')

# 2) Carica il layer UX 3.5.15 dopo il tema 3.5.13/3.5.14.
responsive_text = responsive.read_text(encoding='utf-8')
if '@import url("ui-v3515.css");' not in responsive_text:
    responsive_text = responsive_text.replace('@import url("ui-v3513.css");', '@import url("ui-v3513.css");\n@import url("ui-v3515.css");', 1)
responsive.write_text(responsive_text, encoding='utf-8')

# 3) Tooltip utili quando la sidebar mostra solo le icone.
index_text = index.read_text(encoding='utf-8')
nav_titles = {
    'data-view="pos"': 'title="Cassa"',
    'data-view="sales"': 'title="Scontrini"',
    'data-view="closing"': 'title="Chiusura"',
    'data-view="returns"': 'title="Resi e annulli"',
    'data-view="inventory"': 'title="Magazzino"',
    'data-view="finance"': 'title="Movimenti"',
    'data-view="dashboard"': 'title="Riepilogo"',
    'data-view="catalog"': 'title="Catalogo"',
    'data-view="settings"': 'title="Impostazioni"',
}
for marker, title in nav_titles.items():
    target = f'class="nav-item'
    # Inserisce title subito dopo data-view solo se quel bottone non lo possiede gia.
    pos = 0
    while True:
        pos = index_text.find(marker, pos)
        if pos < 0:
            break
        start = index_text.rfind('<button', 0, pos)
        end = index_text.find('>', pos)
        tag = index_text[start:end+1]
        if target in tag and ' title=' not in tag:
            updated = tag.replace(marker, f'{marker} {title}', 1)
            index_text = index_text[:start] + updated + index_text[end+1:]
            pos = start + len(updated)
        else:
            pos = end + 1

if 'id="logoutBtn" class="btn btn-ghost btn-block" title=' not in index_text:
    index_text = index_text.replace(
        'id="logoutBtn" class="btn btn-ghost btn-block">Esci</button>',
        'id="logoutBtn" class="btn btn-ghost btn-block" title="Esci dall’account">Esci</button>',
        1
    )
index.write_text(index_text, encoding='utf-8')

# 4) Layer UI/UX completo. Solo presentazione: nessuna logica fiscale o dati.
ux_css = r'''/* ========================================================================== */
/* Riflessa Registratore · UX 3.5.15                                          */
/* Rifinitura visuale e interattiva. Nessuna logica fiscale modificata.       */
/* ========================================================================== */

:root{
  --ux-gap-xs:6px;
  --ux-gap-sm:10px;
  --ux-gap:14px;
  --ux-gap-lg:20px;
  --ux-ease:cubic-bezier(.22,.8,.3,1);
  --ux-shadow:0 10px 30px rgba(46,33,24,.07);
  --ux-shadow-hover:0 16px 34px rgba(46,33,24,.105);
}

/* Movimento breve e professionale: feedback, non decorazione invasiva. */
.btn,.mini-btn,.nav-item,.product-card,.category-tabs button,.subtab,.card,.kpi,
.qty-control button,.modal-card,.sale-details,.pos-tools{
  transition:transform .16s var(--ux-ease),box-shadow .16s var(--ux-ease),background-color .16s ease,border-color .16s ease,opacity .16s ease;
}
.btn:active:not(:disabled),.mini-btn:active:not(:disabled),.category-tabs button:active,.qty-control button:active{transform:translateY(1px) scale(.985)}
.product-card:active{transform:translateY(1px) scale(.988)}
.nav-item:hover{transform:translateX(1px)}

/* Shell: piu aria e allineamenti costanti. */
.sidebar{overflow:hidden}
.nav-menu{min-height:0;overflow-y:auto;overflow-x:hidden;padding-right:2px}
.sidebar-bottom{flex:0 0 auto}
.sidebar-bottom>.btn{margin-top:2px!important}
.workspace{min-width:0;background:transparent}
.topbar{gap:14px}
.top-actions{min-width:0}
.content{width:100%;padding-top:18px!important}

/* Superfici comuni: tutti i moduli seguono la stessa grammatica. */
.view>.card,.view>.grid-2,.view>.kpi-grid{margin-bottom:16px}
.grid-2{gap:16px!important}
.card{padding:19px!important}
.card-head{min-height:44px}
.card-head>.button-row{margin-top:0}
.button-row{row-gap:8px!important}
.btn{min-height:42px;padding:10px 15px}
.mini-btn{min-height:34px}
.form-grid label{min-width:0}
.form-grid input,.form-grid select,.form-grid textarea{min-width:0}
.notice{line-height:1.5}

/* Focus piu netto senza il doppio anello visivo. */
input:focus,select:focus,textarea:focus{box-shadow:0 0 0 3px rgba(189,137,96,.12)!important}
button:focus:not(:focus-visible),input:focus:not(:focus-visible),select:focus:not(:focus-visible),textarea:focus:not(:focus-visible){outline:none!important}

/* CASSA: toolbar compatta, catalogo leggibile, conto sempre gerarchico. */
#view-pos .pos-layout{gap:14px}
#view-pos .catalog-pane{padding:14px!important;overflow:visible}
#view-pos .section-toolbar{gap:9px}
#view-pos .pos-search-row{gap:9px}
#view-pos .search-input,#view-pos .barcode-input{min-height:46px!important;padding:11px 13px!important}
#view-pos .search-input{font-size:15px}
#view-pos .category-tabs{gap:6px;padding-top:1px}
#view-pos .category-tabs button{min-height:36px;padding:8px 13px}
#view-pos #productGrid.product-grid{gap:18px;margin-top:13px}
#view-pos .pos-product-section-head{margin-bottom:9px;padding-bottom:8px}
#view-pos .pos-product-section-grid{gap:9px}
#view-pos .product-card{min-height:104px;padding:12px 13px;border-radius:11px!important}
#view-pos .product-card:hover{transform:translateY(-2px);box-shadow:var(--ux-shadow-hover)!important}
#view-pos .product-card .product-name{line-height:1.25}
#view-pos .product-card .product-price{margin-top:6px}
#view-pos .cart-pane{overflow:hidden}
#view-pos .cart-title-row{padding:14px 15px}
#view-pos .cart-lines{padding:7px 14px}
#view-pos .cart-line{animation:ux-cart-line-in .16s var(--ux-ease) both}
@keyframes ux-cart-line-in{from{opacity:.35;transform:translateY(3px)}to{opacity:1;transform:none}}
#view-pos .cart-empty{min-height:84px;display:grid;place-items:center;margin:6px 12px;padding:20px 14px}
#view-pos .cart-summary{padding:14px 15px 15px}
#view-pos .cart-client-label{margin-bottom:9px}
#view-pos .sale-details,#view-pos .pos-tools{border-radius:10px}
#view-pos .sale-details summary,#view-pos .pos-tools summary{min-height:42px;display:flex;align-items:center;justify-content:space-between;gap:10px}
#view-pos .summary-line{line-height:1.65}
#view-pos .summary-total{padding-top:10px;margin-top:8px;border-top:1px solid #eee7e1}
#view-pos .payment-grid-3{gap:9px}
#view-pos .payment-grid-3 .pay{min-height:58px;border-radius:11px!important;font-size:14px}
#view-pos .payment-grid-3 .pay:hover:not(:disabled){transform:translateY(-1px);filter:brightness(1.025)}
#view-pos .clear-cart-btn{margin-top:4px}
#view-pos .status-compact{margin-top:8px}

/* RIEPILOGO */
#view-dashboard .dashboard-hero{padding:22px!important}
#view-dashboard .metric-list,#view-dashboard .business-alerts,#view-dashboard .timeline{border-radius:10px}
#view-dashboard .metric-list>*,#view-dashboard .business-alerts>*{transition:background .14s ease,transform .14s var(--ux-ease)}
#view-dashboard .metric-list>*:hover,#view-dashboard .business-alerts>*:hover{transform:translateX(2px)}

/* SCONTRINI */
#view-sales .receipt-history-card{padding:18px!important}
#view-sales .receipt-filters{gap:9px!important}
#view-sales .receipt-history-summary{min-height:36px;display:flex;align-items:center}
#view-sales .receipt-actions{align-items:center}
#view-sales .receipt-actions .mini-btn:hover{transform:translateY(-1px)}

/* CHIUSURA */
#view-closing .grid-2{align-items:stretch}
#view-closing .grid-2>.card{display:flex;flex-direction:column}
#view-closing .cash-session-card{margin:10px 0}
#view-closing .close-totals{gap:9px}
#view-closing .fiscal-sequence{margin:13px 0}
#view-closing .button-row{margin-top:auto;padding-top:10px}

/* RESI E ANNULLI */
#view-returns>.card{padding:20px!important}
#view-returns .notice{margin-bottom:14px!important}
#view-returns .return-line{border-radius:10px;transition:background .14s ease,border-color .14s ease}
#view-returns .return-line:hover{background:#fffaf8}

/* MAGAZZINO */
#view-inventory>.card{padding:18px!important}
#view-inventory .table-wrap{margin-top:8px}
#view-inventory .data-table td,#view-inventory .data-table th{padding-top:11px;padding-bottom:11px}

/* MOVIMENTI */
#view-finance>.grid-2{align-items:start}
#view-finance>.grid-2>.card{padding:19px!important}
#view-finance>.card:last-child .table-wrap{margin-top:10px}

/* CATALOGO */
#view-catalog .subtabs{margin-bottom:12px}
#view-catalog .catalog-tab.card{padding:20px!important}
#view-catalog .catalog-tab .form-grid{margin-bottom:4px}
#view-catalog .catalog-tab .table-wrap{margin-top:16px}

/* IMPOSTAZIONI */
#view-settings>.grid-2{align-items:start}
#view-settings .printer-info{gap:9px}
#view-settings .technical-details{margin-top:12px}
#view-settings .technical-details[open]{box-shadow:inset 0 0 0 1px rgba(189,137,96,.06)}

/* Tabelle: scansione piu facile per un proprietario che lavora velocemente. */
.table-wrap{overflow:auto;overscroll-behavior:contain}
.data-table th{white-space:nowrap}
.data-table tbody tr:hover td{background:rgba(249,246,243,.72)}
.data-table td,.data-table th{vertical-align:middle}
.table-actions{row-gap:6px}

/* Modali e dettagli: entrata morbida e contenuto leggibile. */
.modal:not(.hidden) .modal-card{animation:ux-modal-in .18s var(--ux-ease) both}
@keyframes ux-modal-in{from{opacity:.35;transform:translateY(8px) scale(.988)}to{opacity:1;transform:none}}
details[open]>*:not(summary){animation:ux-details-in .14s ease-out both}
@keyframes ux-details-in{from{opacity:.2;transform:translateY(-2px)}to{opacity:1;transform:none}}

/* Desktop compatto: corregge il doppio Esci e mantiene leggibili i comandi footer. */
@media(max-width:1100px){
  .app-shell{grid-template-columns:84px minmax(0,1fr)!important}
  .sidebar{padding:14px 8px 12px!important}
  .sidebar-brand{padding-bottom:14px!important}
  .nav-menu{gap:3px;margin-top:12px}
  .nav-item{min-height:49px!important;margin:0 1px!important;border-radius:10px!important}
  .sidebar-bottom{gap:7px;padding-top:10px!important}
  .sidebar-bottom>.btn{min-height:43px!important;padding:6px 3px!important;border-radius:10px!important}
  .sidebar #logoutBtn{font-size:0!important}
  .sidebar #logoutBtn::after{content:"Esci"!important;font-size:10px!important}
  .sidebar .btn-ghost:not(#logoutBtn){font-size:9px!important;line-height:1.15!important;white-space:normal!important;color:#e8dfd9!important}
  .sidebar .btn-ghost:not(#logoutBtn)::after{content:none!important}
  .topbar{padding-inline:16px!important}
  .top-actions{gap:7px}
  .top-statuses{gap:6px!important}
  .content{padding:14px!important}
  #view-pos .pos-layout{grid-template-columns:minmax(0,1fr) 338px!important;gap:12px}
  #view-pos .product-card{min-height:100px}
}

/* Tra 761 e 900 px: catalogo sopra, conto sotto ma organizzato su due colonne.
   Evita il lungo blocco verticale visibile sui PC da banco compatti. */
@media(min-width:761px) and (max-width:900px){
  #view-pos .pos-layout{display:block!important}
  #view-pos .catalog-pane{margin-bottom:12px}
  #view-pos .cart-pane{
    display:grid!important;
    grid-template-columns:minmax(0,1fr) minmax(330px,.9fr);
    grid-template-areas:"title title" "lines summary";
    position:static!important;
    max-height:none!important;
    overflow:hidden!important;
  }
  #view-pos .cart-title-row{grid-area:title}
  #view-pos .cart-lines,#view-pos .cart-empty{grid-area:lines}
  #view-pos .cart-lines{min-height:250px;max-height:390px!important}
  #view-pos .cart-empty{min-height:250px;margin:0;border-radius:0}
  #view-pos .cart-summary{grid-area:summary;border-top:0!important;border-left:1px solid var(--line);align-self:stretch}
  #view-pos .payment-grid-3{grid-template-columns:1fr!important}
  #view-pos .payment-grid-3 .pay{min-height:50px}
  .topbar{align-items:flex-start;padding-block:10px;min-height:76px!important;height:auto!important}
  .top-actions{max-width:60%}
}

@media(max-width:760px){
  .card{padding:13px!important}
  .nav-item:hover{transform:none}
  #view-pos .catalog-pane{padding:9px!important}
  #view-pos .search-input,#view-pos .barcode-input{min-height:44px!important}
  #view-pos .pos-product-section-grid{gap:7px}
  #view-pos .product-card{min-height:96px;padding:10px}
  #view-pos .cart-summary{padding:11px 12px 13px}
  #view-pos .payment-grid-3 .pay{min-height:50px}
  .button-row{gap:7px!important}
}

@media(prefers-reduced-motion:reduce){
  .cart-line,.modal-card,details[open]>*:not(summary){animation:none!important}
}
'''
ux.write_text(ux_css.rstrip() + '\n', encoding='utf-8')

# 5) Test statici per impedire regressioni del bug e del layout compatto.
test_content = r'''const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const responsive = fs.readFileSync(path.join(root, 'responsive.css'), 'utf8');
const ux = fs.readFileSync(path.join(root, 'ui-v3515.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('sidebar compatta etichetta Esci solo sul logout', () => {
  assert.doesNotMatch(styles, /\.sidebar \.btn-ghost:after\{content:'Esci'/);
  assert.match(styles, /#logoutBtn\{font-size:0\}/);
  assert.match(styles, /\.sidebar #logoutBtn:after\{content:'Esci'/);
  assert.match(ux, /\.sidebar \.btn-ghost:not\(#logoutBtn\)::after\{content:none!important\}/);
});

test('UX 3.5.15 viene caricata e mantiene layout compatto usabile', () => {
  assert.match(responsive, /@import url\("ui-v3515\.css"\)/);
  assert.match(ux, /@media\(min-width:761px\) and \(max-width:900px\)/);
  assert.match(ux, /grid-template-areas:"title title" "lines summary"/);
  assert.match(ux, /\.modal:not\(\.hidden\) \.modal-card/);
  assert.match(ux, /prefers-reduced-motion:reduce/);
});

test('navigazione compatta espone tooltip descrittivi', () => {
  for (const label of ['Cassa','Scontrini','Chiusura','Resi e annulli','Magazzino','Movimenti','Riepilogo','Catalogo','Impostazioni']) {
    assert.match(html, new RegExp(`title="${label.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}"`));
  }
  assert.match(html, /id="logoutBtn"[^>]*title="Esci dall’account"/);
});
'''
test_file.write_text(test_content, encoding='utf-8')

note.write_text('''Riflessa Registratore 3.5.15\n\nUI/UX:\n- corretto il doppio “Esci” nella sidebar compatta: Stato sistema mantiene la propria etichetta;\n- rifinite spaziature, card, form, tabelle, pulsanti e gerarchie visive in tutte le sezioni;\n- Cassa piu compatta e leggibile sui PC da banco, con conto a due colonne tra 761 e 900 px;\n- micro-animazioni brevi per card, carrello, modali e dettagli, con rispetto di prefers-reduced-motion;\n- tooltip sulla navigazione quando la sidebar mostra solo le icone;\n- nessuna modifica alla logica fiscale DADO RT30, ai dati o ai comandi di stampa.\n''', encoding='utf-8')

print('Patch UX 3.5.15 applicata')
