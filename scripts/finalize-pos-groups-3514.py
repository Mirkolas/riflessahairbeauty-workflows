from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit('uso: finalize-pos-groups-3514.py <app_dir>')

root = Path(sys.argv[1])
app = root / 'js' / 'app.js'
css = root / 'ui-v3513.css'
test_file = root / 'tests' / 'pos-product-groups.test.js'
note = root / 'VERSIONE_3_5_14_CASSA_GRUPPI.txt'

old = '''function renderProducts() {
  const grid = $("productGrid");
  if (!grid) return;
  const q = $("productSearch").value.trim().toLowerCase();
  const list = state.products.filter(p => p.active !== false)
    .filter(p => state.selectedCategory === "all" || p.categoryId === state.selectedCategory)
    .filter(p => !q || String(p.name || "").toLowerCase().includes(q));
  grid.innerHTML = list.map(p => {
    const low = p.stockTracked && Number(p.stockQty || 0) <= Number(p.minStock || 0);
    const typeLabel = p.type === "product" ? "Prodotto" : "Servizio";
    return `<button class="product-card ${low ? "low" : ""}" data-add-product="${p.id}">
      <div><div class="product-type">${typeLabel}</div><div class="product-name">${escapeHtml(p.name)}</div></div>
      <div><div class="product-price">${euro(p.priceCents || 0)}</div>${p.stockTracked ? `<div class="stock-note">Giacenza: ${Number(p.stockQty || 0)}</div>` : ""}</div>
    </button>`;
  }).join("");
  $("emptyProducts").classList.toggle("hidden", !!list.length);
}
'''

new = '''function renderProducts() {
  const grid = $("productGrid");
  if (!grid) return;
  const q = $("productSearch").value.trim().toLowerCase();
  const list = state.products.filter(p => p.active !== false)
    .filter(p => state.selectedCategory === "all" || p.categoryId === state.selectedCategory)
    .filter(p => !q || String(p.name || "").toLowerCase().includes(q))
    .sort((a, b) => {
      const priceDiff = Number(a.priceCents || 0) - Number(b.priceCents || 0);
      if (priceDiff) return priceDiff;
      return String(a.name || "").localeCompare(String(b.name || ""), "it", { sensitivity:"base" });
    });

  const services = list.filter(p => p.type !== "product");
  const products = list.filter(p => p.type === "product");
  const renderCard = p => {
    const low = p.stockTracked && Number(p.stockQty || 0) <= Number(p.minStock || 0);
    const typeLabel = p.type === "product" ? "Prodotto" : "Servizio";
    return `<button class="product-card ${low ? "low" : ""}" data-add-product="${p.id}">
      <div><div class="product-type">${typeLabel}</div><div class="product-name">${escapeHtml(p.name)}</div></div>
      <div><div class="product-price">${euro(p.priceCents || 0)}</div>${p.stockTracked ? `<div class="stock-note">Giacenza: ${Number(p.stockQty || 0)}</div>` : ""}</div>
    </button>`;
  };
  const renderSection = (title, items, kind) => {
    if (!items.length) return "";
    const countLabel = `${items.length} ${items.length === 1 ? "voce" : "voci"}`;
    return `<section class="pos-product-section pos-product-section-${kind}">
      <div class="pos-product-section-head"><div><span class="pos-product-section-kicker">${kind === "services" ? "Prestazioni" : "Rivendita"}</span><h3>${title}</h3></div><span class="pos-product-section-count">${countLabel} · prezzo crescente</span></div>
      <div class="pos-product-section-grid">${items.map(renderCard).join("")}</div>
    </section>`;
  };

  grid.innerHTML = `${renderSection("Servizi", services, "services")}${renderSection("Prodotti", products, "products")}`;
  $("emptyProducts").classList.toggle("hidden", !!list.length);
}
'''

text = app.read_text(encoding='utf-8')
if 'pos-product-section-services' not in text:
    if old not in text:
        raise SystemExit('blocco renderProducts atteso non trovato: patch interrotta')
    text = text.replace(old, new, 1)
    app.write_text(text, encoding='utf-8')

css_marker = '/* ===== v3.5.14 CASSA: SERVIZI / PRODOTTI ===== */'
css_block = r'''

/* ===== v3.5.14 CASSA: SERVIZI / PRODOTTI ===== */
#productGrid.product-grid{
  display:flex;
  flex-direction:column;
  gap:20px;
  margin-top:14px;
}
.pos-product-section{min-width:0}
.pos-product-section-head{
  display:flex;
  align-items:flex-end;
  justify-content:space-between;
  gap:14px;
  padding:0 2px 9px;
  margin-bottom:10px;
  border-bottom:1px solid var(--line);
}
.pos-product-section-head h3{
  margin:2px 0 0;
  font-size:19px;
  font-weight:760;
  letter-spacing:-.025em;
  color:var(--ink);
}
.pos-product-section-kicker{
  display:block;
  font-size:9px;
  line-height:1;
  font-weight:800;
  letter-spacing:.14em;
  text-transform:uppercase;
  color:var(--accent-dark);
}
.pos-product-section-count{
  flex:0 0 auto;
  font-size:10px;
  font-weight:650;
  color:var(--muted);
  white-space:nowrap;
}
.pos-product-section-grid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(170px,1fr));
  gap:10px;
}
.pos-product-section-services .product-card{border-top:2px solid #d9b692}
.pos-product-section-products .product-card{border-top:2px solid #aaa39e}
@media(max-width:1365px){
  .pos-product-section-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
}
@media(max-width:760px){
  #productGrid.product-grid{gap:16px}
  .pos-product-section-head{align-items:flex-start;flex-direction:column;gap:5px}
  .pos-product-section-count{white-space:normal}
  .pos-product-section-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}
}
'''
css_text = css.read_text(encoding='utf-8')
if css_marker not in css_text:
    css.write_text(css_text.rstrip() + css_block.rstrip() + '\n', encoding='utf-8')

test_content = '''const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'ui-v3513.css'), 'utf8');

test('cassa separa servizi e prodotti e ordina entrambi per prezzo crescente', () => {
  assert.match(app, /const priceDiff = Number\\(a\\.priceCents \\|\\| 0\\) - Number\\(b\\.priceCents \\|\\| 0\\)/);
  assert.match(app, /const services = list\\.filter\\(p => p\\.type !== "product"\\)/);
  assert.match(app, /const products = list\\.filter\\(p => p\\.type === "product"\\)/);
  assert.match(app, /renderSection\\("Servizi", services, "services"\\)/);
  assert.match(app, /renderSection\\("Prodotti", products, "products"\\)/);
  assert.match(css, /#productGrid\\.product-grid\\{[\\s\\S]*display:flex/);
  assert.match(css, /\\.pos-product-section-grid\\{[\\s\\S]*display:grid/);
});
'''
if not test_file.exists() or test_file.read_text(encoding='utf-8') != test_content:
    test_file.write_text(test_content, encoding='utf-8')

note.write_text('''Riflessa Registratore 3.5.14\n\nCassa:\n- Servizi e Prodotti sono mostrati in due sezioni separate.\n- Ogni sezione e ordinata per prezzo crescente; a parita di prezzo per nome.\n- Ricerca e filtro categoria continuano a funzionare su entrambe le sezioni.\n- Nessuna modifica alla logica fiscale DADO RT30.\n''', encoding='utf-8')

print('Patch cassa 3.5.14 applicata')
