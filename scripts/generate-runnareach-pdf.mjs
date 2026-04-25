// Generates `tasks/runnareach-namecheap-setup.pdf` — a Namecheap-specific,
// no-warming, hand-holding guide for adding runnareach.com to the Rünna
// Workspace. Run with: node scripts/generate-runnareach-pdf.mjs
//
// Re-run any time the inline HTML below changes.

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const html = String.raw`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Anclar runnareach.com al Workspace de Rünna — Setup</title>
<style>
  @page {
    size: A4;
    margin: 18mm 16mm 18mm 16mm;
    @bottom-right {
      content: counter(page) " / " counter(pages);
      font-family: ui-sans-serif, -apple-system, "Helvetica Neue", sans-serif;
      font-size: 9pt;
      color: #888;
    }
    @bottom-left {
      content: "runnareach.com → Rünna Workspace";
      font-family: ui-sans-serif, -apple-system, "Helvetica Neue", sans-serif;
      font-size: 9pt;
      color: #888;
    }
  }
  :root {
    --purple: #775cbf;
    --purple-dark: #5a3fa0;
    --pink: #de5a5f;
    --gold: #fbae42;
    --ink: #1a1a2e;
    --muted: #555;
    --line: #e3e0ee;
    --bg-soft: #faf9fd;
    --bg-warn: #fff7e6;
    --bg-danger: #fff0f0;
    --bg-ok: #f0fff4;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    color: var(--ink);
    font-family: ui-sans-serif, -apple-system, "Helvetica Neue", "Inter", sans-serif;
    font-size: 10.5pt;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  h1 {
    font-size: 22pt;
    color: var(--purple-dark);
    margin: 0 0 4mm 0;
    line-height: 1.15;
  }
  h2 {
    font-size: 14pt;
    color: var(--purple-dark);
    border-bottom: 2px solid var(--purple);
    padding-bottom: 1mm;
    margin: 10mm 0 3mm 0;
    page-break-after: avoid;
  }
  h2.phase {
    background: linear-gradient(90deg, var(--purple) 0%, var(--pink) 100%);
    color: white;
    border: none;
    padding: 2.5mm 4mm;
    border-radius: 1.5mm;
    margin-top: 8mm;
    page-break-after: avoid;
  }
  h3 {
    font-size: 11.5pt;
    color: var(--ink);
    margin: 5mm 0 2mm 0;
    page-break-after: avoid;
  }
  p { margin: 0 0 3mm 0; }
  ul, ol { margin: 0 0 3mm 0; padding-left: 6mm; }
  li { margin-bottom: 1.5mm; }
  code, .mono {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 9.5pt;
    background: var(--bg-soft);
    border: 1px solid var(--line);
    padding: 0.4mm 1.2mm;
    border-radius: 0.8mm;
    color: var(--purple-dark);
    word-break: break-all;
  }
  pre {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 9pt;
    background: var(--bg-soft);
    border: 1px solid var(--line);
    border-left: 3px solid var(--purple);
    padding: 2.5mm 3mm;
    border-radius: 1mm;
    overflow-x: hidden;
    word-break: break-all;
    white-space: pre-wrap;
    margin: 0 0 3mm 0;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 0 0 4mm 0;
    page-break-inside: avoid;
    font-size: 10pt;
  }
  th, td {
    border: 1px solid var(--line);
    padding: 1.6mm 2.2mm;
    text-align: left;
    vertical-align: top;
  }
  th {
    background: var(--bg-soft);
    font-weight: 600;
    color: var(--purple-dark);
    font-size: 9.5pt;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  td.mono, th.mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 9pt; }
  a { color: var(--purple-dark); text-decoration: underline; word-break: break-all; }
  .callout {
    border-left: 3px solid var(--purple);
    background: var(--bg-soft);
    padding: 2.5mm 3.5mm;
    border-radius: 0.8mm;
    margin: 0 0 3.5mm 0;
    page-break-inside: avoid;
  }
  .callout.warn { border-left-color: var(--gold); background: var(--bg-warn); }
  .callout.danger { border-left-color: var(--pink); background: var(--bg-danger); }
  .callout.ok { border-left-color: #4caf50; background: var(--bg-ok); }
  .callout strong { color: var(--purple-dark); }
  .callout.warn strong { color: #b07300; }
  .callout.danger strong { color: #b3373c; }
  .callout.ok strong { color: #2e7d32; }
  .checklist { list-style: none; padding-left: 0; }
  .checklist li {
    margin-bottom: 1.5mm;
    padding-left: 7mm;
    position: relative;
  }
  .checklist li::before {
    content: "";
    position: absolute;
    left: 0;
    top: 1.2mm;
    width: 4mm;
    height: 4mm;
    border: 1.5px solid var(--purple);
    border-radius: 0.8mm;
    background: white;
  }
  .step {
    background: white;
    border: 1px solid var(--line);
    border-radius: 1.5mm;
    padding: 3mm 4mm;
    margin-bottom: 3mm;
    page-break-inside: avoid;
  }
  .step-num {
    display: inline-block;
    background: var(--purple);
    color: white;
    font-weight: 700;
    font-size: 9.5pt;
    padding: 0.5mm 2.5mm;
    border-radius: 0.8mm;
    margin-right: 2mm;
    vertical-align: middle;
  }
  .step-title {
    font-weight: 600;
    color: var(--ink);
    font-size: 11pt;
    margin-bottom: 2mm;
  }
  .meta {
    color: var(--muted);
    font-size: 9.5pt;
  }
  .cover {
    text-align: center;
    padding-top: 25mm;
  }
  .cover h1 { font-size: 26pt; margin-bottom: 6mm; }
  .cover .subtitle { font-size: 12pt; color: var(--muted); }
  .cover .summary {
    text-align: left;
    margin-top: 12mm;
  }
  .pill {
    display: inline-block;
    background: var(--purple);
    color: white;
    border-radius: 1.2mm;
    padding: 0.4mm 2mm;
    font-size: 9pt;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .pill.warn { background: var(--gold); color: var(--ink); }
  .pill.ok { background: #4caf50; }
  .toc {
    background: var(--bg-soft);
    border: 1px solid var(--line);
    border-radius: 1.5mm;
    padding: 4mm;
    margin-bottom: 6mm;
  }
  .toc h2 { margin-top: 0; border: none; padding: 0; }
  .toc ol { margin: 0; padding-left: 5mm; }
  .toc li { margin-bottom: 1mm; }
  .field-row {
    display: grid;
    grid-template-columns: 32mm 1fr;
    gap: 2mm;
    padding: 1.5mm 0;
    border-bottom: 1px dashed var(--line);
  }
  .field-row:last-child { border-bottom: none; }
  .field-label {
    font-weight: 600;
    color: var(--muted);
    font-size: 9.5pt;
  }
  .field-value {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 9.5pt;
    color: var(--purple-dark);
    word-break: break-all;
  }
</style>
</head>
<body>

<div class="cover">
  <span class="pill">Setup · Namecheap</span>
  <h1>Anclar runnareach.com al Google Workspace de Rünna</h1>
  <p class="subtitle">Guía paso a paso · sin warming (eso es Fase 2)</p>

  <div class="summary">
    <div class="callout">
      <p><strong>Qué vas a hacer:</strong> conectar el dominio
      <code>runnareach.com</code> (recién comprado en Namecheap) al Workspace
      que ya tiene Rünna. Cuando termines vas a poder crear correos
      autenticados en <code>@runnareach.com</code> con buzón propio.</p>
    </div>

    <div class="callout warn">
      <p><strong>⚠️ Importante:</strong> esta guía cubre solo el setup
      técnico (Fases 1–9). El <em>warming</em> del dominio (calendarizar
      envíos durante 6 semanas antes de mandar a frío) es Fase 2 y va en
      otro documento.</p>
    </div>

    <h3>Tiempo estimado</h3>
    <table>
      <thead>
        <tr><th>Fase</th><th>Tu tiempo</th><th>Espera DNS</th></tr>
      </thead>
      <tbody>
        <tr><td>1 · Agregar dominio en Workspace</td><td>5 min</td><td>—</td></tr>
        <tr><td>2 · Login a Namecheap DNS</td><td>2 min</td><td>—</td></tr>
        <tr><td>3 · TXT verificación</td><td>5 min</td><td>5–15 min</td></tr>
        <tr><td>4 · MX records</td><td>3 min</td><td>15–60 min</td></tr>
        <tr><td>5 · SPF</td><td>2 min</td><td>15 min</td></tr>
        <tr><td>6 · DKIM</td><td>5 min</td><td>30 min</td></tr>
        <tr><td>7 · DMARC</td><td>2 min</td><td>15 min</td></tr>
        <tr><td>8 · Crear mailboxes</td><td>5 min</td><td>—</td></tr>
        <tr><td>9 · Verificar con mail-tester</td><td>5 min</td><td>—</td></tr>
        <tr><td><strong>Total trabajo activo</strong></td><td colspan="2"><strong>~35 min + propagación</strong></td></tr>
      </tbody>
    </table>

    <h3>Antes de empezar</h3>
    <ul class="checklist">
      <li>Acceso super-admin al Workspace de Rünna (cuenta tipo
          <code>pedro@runna.com.mx</code>)</li>
      <li>Login a Namecheap (usuario + password)</li>
      <li>Una pestaña abierta en cada sitio, lado a lado — vas a brincar
          entre las dos varias veces</li>
      <li>~35 minutos sin interrupciones</li>
    </ul>
  </div>
</div>

<h2 class="phase">Fase 1 · Agregar runnareach.com al Workspace</h2>

<div class="step">
  <div class="step-title"><span class="step-num">1.1</span>Entra al Admin Console</div>
  <p>Abre <a href="https://admin.google.com">https://admin.google.com</a>
  e inicia sesión con tu cuenta super-admin (probablemente
  <code>pedro@runna.com.mx</code> o <code>admin@runna.com.mx</code>).</p>
  <div class="callout">
    <p>💡 Si te dice <em>"You don't have admin access"</em>, no eres
    super-admin. Pídele a quien sí lo sea que te promueva, o que haga
    estos pasos por ti.</p>
  </div>
</div>

<div class="step">
  <div class="step-title"><span class="step-num">1.2</span>Ve a la sección de dominios</div>
  <ol>
    <li>Sidebar izquierdo, hasta abajo: <strong>Account</strong> (ícono engrane)</li>
    <li>Click en <strong>Domains</strong></li>
    <li>Click en <strong>Manage domains</strong></li>
  </ol>
  <p>Vas a ver una lista con <code>runna.com.mx</code> (y quizá otros
  dominios).</p>
</div>

<div class="step">
  <div class="step-title"><span class="step-num">1.3</span>Agregar runnareach.com</div>
  <ol>
    <li>Click en el botón <strong>Add a domain</strong> (arriba a la derecha)</li>
    <li>En el campo "Domain name" escribe: <code>runnareach.com</code></li>
    <li><strong>MUY IMPORTANTE</strong> — selecciona el radio button
        <strong>Secondary domain</strong>.</li>
  </ol>
  <div class="callout danger">
    <p><strong>❌ NO selecciones "User alias domain"</strong> — los aliases
    comparten buzón con runna.com.mx. Necesitamos buzones SEPARADOS para
    outreach desde @runnareach.com.</p>
  </div>
  <ol start="4">
    <li>Click <strong>Add domain &amp; start verification</strong></li>
  </ol>
</div>

<div class="step">
  <div class="step-title"><span class="step-num">1.4</span>Copia el código de verificación</div>
  <p>Google muestra una pantalla con varias opciones de verificación.
  Elige la primera: <strong>TXT record (recommended)</strong>.</p>
  <p>Vas a ver algo así:</p>
  <pre>google-site-verification=Xy7abc1234567defGHIJK_lmnopqrstUVWXYZabc</pre>
  <p>📋 <strong>Copia ese valor completo</strong> (desde
  <code>google-site-verification=</code> hasta el final). Pégalo en una
  nota — lo vas a usar en Fase 3.</p>
  <div class="callout warn">
    <p><strong>⏸️ NO cierres esta pestaña.</strong> Déjala atrás. Vas a
    regresar varias veces durante toda la guía.</p>
  </div>
</div>

<h2 class="phase">Fase 2 · Login a Namecheap (DNS)</h2>

<div class="step">
  <div class="step-title"><span class="step-num">2.1</span>Entra a Namecheap</div>
  <ol>
    <li>Abre <a href="https://www.namecheap.com/myaccount/login">https://www.namecheap.com/myaccount/login</a></li>
    <li>Login con tu usuario y password</li>
  </ol>
</div>

<div class="step">
  <div class="step-title"><span class="step-num">2.2</span>Encuentra runnareach.com</div>
  <ol>
    <li>Sidebar izquierdo: click en <strong>Domain List</strong></li>
    <li>En la lista, encuentra <code>runnareach.com</code></li>
    <li>Click en el botón <strong>Manage</strong> (a la derecha de la fila)</li>
  </ol>
</div>

<div class="step">
  <div class="step-title"><span class="step-num">2.3</span>Abre la tab Advanced DNS</div>
  <p>Arriba de la pantalla vas a ver tabs: <em>Domain · Products · Sharing
  &amp; Transfer · Advanced DNS</em>.</p>
  <p>Click en <strong>Advanced DNS</strong>. Ahí es donde vas a agregar
  todos los records DNS de las próximas fases.</p>
  <div class="callout">
    <p><strong>📌 Cómo agregar un record en Namecheap:</strong></p>
    <ol>
      <li>Click en <strong>ADD NEW RECORD</strong> (botón abajo de la tabla)</li>
      <li>Llena los campos según la fase:
        <ul>
          <li><strong>Type</strong>: el tipo del record (TXT, MX, etc.)</li>
          <li><strong>Host</strong>: el subdominio. <code>@</code> = la raíz
              del dominio</li>
          <li><strong>Value</strong>: el valor exacto</li>
          <li><strong>TTL</strong>: déjalo en <em>Automatic</em></li>
        </ul>
      </li>
      <li>Click en el ícono ✓ (palomita verde) a la derecha de la fila
          para guardar</li>
    </ol>
  </div>
  <div class="callout warn">
    <p><strong>⚠️ Borra cualquier record default que Namecheap haya puesto.</strong>
    Cuando compras un dominio, Namecheap normalmente agrega 1–2 records
    "Parking page" o redirects que no necesitas. Bórralos antes de empezar
    para no tener conflictos.</p>
  </div>
</div>

<h2 class="phase">Fase 3 · TXT de verificación</h2>

<div class="step">
  <div class="step-title"><span class="step-num">3.1</span>Agregar el TXT en Namecheap</div>
  <p>En <strong>Advanced DNS</strong> click en <strong>ADD NEW RECORD</strong>
  y captura:</p>
  <div>
    <div class="field-row">
      <div class="field-label">Type</div>
      <div class="field-value">TXT Record</div>
    </div>
    <div class="field-row">
      <div class="field-label">Host</div>
      <div class="field-value">@</div>
    </div>
    <div class="field-row">
      <div class="field-label">Value</div>
      <div class="field-value">google-site-verification=Xy7abc... <span class="meta">(el código que copiaste en 1.4)</span></div>
    </div>
    <div class="field-row">
      <div class="field-label">TTL</div>
      <div class="field-value">Automatic</div>
    </div>
  </div>
  <p>Click en la palomita verde (✓) a la derecha para guardar.</p>
</div>

<div class="step">
  <div class="step-title"><span class="step-num">3.2</span>Esperar a que propague</div>
  <p>⏱️ <strong>Espera 5–15 minutos.</strong> Los DNS no son instantáneos.</p>
  <p>Para confirmar que el record ya está visible públicamente, ve a
  <a href="https://mxtoolbox.com/TXTLookup.aspx">mxtoolbox.com/TXTLookup.aspx</a>:</p>
  <ol>
    <li>En "Domain Name" escribe <code>runnareach.com</code></li>
    <li>Click <strong>TXT Lookup</strong></li>
    <li>Si ves tu <code>google-site-verification=...</code> en los
        resultados, ya propagó.</li>
  </ol>
</div>

<div class="step">
  <div class="step-title"><span class="step-num">3.3</span>Decirle a Google que verifique</div>
  <p>Regresa a la pestaña del Admin Console. Si ya cerraste, vuelve a:
  <strong>admin.google.com → Account → Domains → Manage domains →
  runnareach.com</strong>.</p>
  <p>Click en <strong>Verify</strong> (o <strong>Activate</strong>).</p>
  <div class="callout ok">
    <p><strong>✅ "Verified successfully"</strong> → pasaste Fase 3.</p>
  </div>
  <div class="callout warn">
    <p><strong>"We couldn't find the record"</strong> → espera 10 min más
    y reintenta. A veces Namecheap tarda hasta 30 min.</p>
  </div>
</div>

<h2 class="phase">Fase 4 · MX records (recibir email)</h2>

<div class="callout">
  <p><strong>📌 Buenas noticias:</strong> Google migró a un solo MX record en
  2023. Antes había 5 (ASPMX, ALT1, ALT2…), ahora solo necesitas uno.</p>
</div>

<div class="step">
  <div class="step-title"><span class="step-num">4.1</span>Borrar MX records viejos</div>
  <p>Si ves cualquier record MX previo en la tabla de Advanced DNS,
  bórralo. Click en el ícono de basura (🗑) a la derecha de cada fila MX.</p>
</div>

<div class="step">
  <div class="step-title"><span class="step-num">4.2</span>Agregar el MX de Google</div>
  <p>Click en <strong>ADD NEW RECORD</strong> y captura:</p>
  <div>
    <div class="field-row">
      <div class="field-label">Type</div>
      <div class="field-value">MX Record</div>
    </div>
    <div class="field-row">
      <div class="field-label">Host</div>
      <div class="field-value">@</div>
    </div>
    <div class="field-row">
      <div class="field-label">Value</div>
      <div class="field-value">smtp.google.com</div>
    </div>
    <div class="field-row">
      <div class="field-label">Priority</div>
      <div class="field-value">1</div>
    </div>
    <div class="field-row">
      <div class="field-label">TTL</div>
      <div class="field-value">Automatic</div>
    </div>
  </div>
  <p>Click en la palomita verde para guardar.</p>
</div>

<div class="step">
  <div class="step-title"><span class="step-num">4.3</span>Verificar</div>
  <p>⏱️ Espera 15–30 min, luego ve a
  <a href="https://mxtoolbox.com/SuperTool.aspx">mxtoolbox.com/SuperTool.aspx</a>:</p>
  <ol>
    <li>En el dropdown elige <strong>MX Lookup</strong></li>
    <li>Escribe <code>runnareach.com</code></li>
    <li>Click <strong>Search</strong></li>
    <li>Deberías ver <code>smtp.google.com</code> con priority 1.</li>
  </ol>
</div>

<h2 class="phase">Fase 5 · SPF (autorizar a Google)</h2>

<p>SPF dice: "los emails que digan ser de @runnareach.com solo son
legítimos si salen de los servidores de Google". Sin SPF tus correos
caen directo a spam.</p>

<div class="step">
  <div class="step-title"><span class="step-num">5.1</span>Agregar SPF</div>
  <p>En Advanced DNS, click <strong>ADD NEW RECORD</strong>:</p>
  <div>
    <div class="field-row">
      <div class="field-label">Type</div>
      <div class="field-value">TXT Record</div>
    </div>
    <div class="field-row">
      <div class="field-label">Host</div>
      <div class="field-value">@</div>
    </div>
    <div class="field-row">
      <div class="field-label">Value</div>
      <div class="field-value">v=spf1 include:_spf.google.com ~all</div>
    </div>
    <div class="field-row">
      <div class="field-label">TTL</div>
      <div class="field-value">Automatic</div>
    </div>
  </div>
  <p>Guardar (palomita verde).</p>
  <div class="callout warn">
    <p><strong>⚠️ Solo puede haber UN record SPF por dominio.</strong> Si
    Namecheap ya tiene uno (raro pero pasa), edita el existente para
    incluir <code>include:_spf.google.com</code> dentro, en vez de
    agregar otro.</p>
  </div>
</div>

<div class="step">
  <div class="step-title"><span class="step-num">5.2</span>Verificar</div>
  <p>Ve a <a href="https://mxtoolbox.com/spf.aspx">mxtoolbox.com/spf.aspx</a>:</p>
  <ol>
    <li>Escribe <code>runnareach.com</code></li>
    <li>Click <strong>Search</strong></li>
    <li>Deberías ver tu record y <strong>SPF Record: PASS</strong>.</li>
  </ol>
</div>

<h2 class="phase">Fase 6 · DKIM (firma criptográfica)</h2>

<p>DKIM firma cada correo con una llave privada que solo Google tiene.
El receptor verifica con la llave pública (que vas a publicar en DNS)
que el correo no fue modificado en tránsito.</p>

<div class="step">
  <div class="step-title"><span class="step-num">6.1</span>Generar la llave en Workspace</div>
  <p>En <a href="https://admin.google.com">admin.google.com</a>:</p>
  <ol>
    <li>Sidebar: <strong>Apps → Google Workspace → Gmail</strong></li>
    <li>Click en <strong>Authenticate email</strong></li>
    <li>En el dropdown <em>Selected domain</em> elige <strong>runnareach.com</strong></li>
    <li>Click <strong>Generate new record</strong></li>
    <li>Selecciona <strong>2048</strong> bits (más seguro)</li>
    <li>Selector: deja en <code>google</code> (default)</li>
    <li>Click <strong>Generate</strong></li>
  </ol>
  <p>Google muestra:</p>
  <pre>DNS Host name (TXT record name):  google._domainkey
TXT record value:                 v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOC...
                                  (un blob largo, copia TODO)</pre>
  <p>📋 <strong>Copia el TXT record value completo.</strong> Es muy largo
  (1000+ caracteres) — desde <code>v=DKIM1</code> hasta el final.</p>
  <div class="callout warn">
    <p><strong>⏸️ NO cierres esta pestaña.</strong> Vuelves a darle "Start
    authentication" después de pegar el record.</p>
  </div>
</div>

<div class="step">
  <div class="step-title"><span class="step-num">6.2</span>Pegarlo en Namecheap</div>
  <p>En <strong>Advanced DNS → ADD NEW RECORD</strong>:</p>
  <div>
    <div class="field-row">
      <div class="field-label">Type</div>
      <div class="field-value">TXT Record</div>
    </div>
    <div class="field-row">
      <div class="field-label">Host</div>
      <div class="field-value">google._domainkey</div>
    </div>
    <div class="field-row">
      <div class="field-label">Value</div>
      <div class="field-value">v=DKIM1; k=rsa; p=MIIBIjANBg... <span class="meta">(el blob largo completo)</span></div>
    </div>
    <div class="field-row">
      <div class="field-label">TTL</div>
      <div class="field-value">Automatic</div>
    </div>
  </div>
  <p>Click palomita verde para guardar.</p>
  <div class="callout warn">
    <p><strong>⚠️ Si Namecheap te dice "Value too long":</strong> el límite
    técnico de TXT es 255 chars y tu DKIM mide ~400+. Namecheap normalmente
    lo maneja automáticamente, pero si te aparece error:</p>
    <ol>
      <li>Parte el blob en dos pedazos de menos de 255 chars cada uno</li>
      <li>Pégalos así: <code>"primer pedazo" "segundo pedazo"</code>
          — con comillas dobles y espacio entre ellos</li>
    </ol>
    <p>Namecheap los concatena al servir el record.</p>
  </div>
</div>

<div class="step">
  <div class="step-title"><span class="step-num">6.3</span>Activar DKIM en Workspace</div>
  <p>⏱️ Espera 30 min para que el DNS propague.</p>
  <p>Verifica en <a href="https://mxtoolbox.com/dkim.aspx">mxtoolbox.com/dkim.aspx</a>:</p>
  <ul>
    <li>Domain: <code>runnareach.com</code></li>
    <li>Selector: <code>google</code></li>
    <li>Si dice <em>"DKIM record found"</em> → ya propagó.</li>
  </ul>
  <p>Regresa a la pestaña de <strong>Gmail → Authenticate email</strong> y
  click en <strong>Start authentication</strong>.</p>
  <div class="callout ok">
    <p><strong>✅ "Authenticating email"</strong> → DKIM activo. Pasaste Fase 6.</p>
  </div>
</div>

<h2 class="phase">Fase 7 · DMARC (política de monitoreo)</h2>

<p>DMARC le dice a los receptores: "si un email NO pasa SPF ni DKIM,
hazle X". Para empezar usamos <code>p=none</code> (solo monitorear, no
rechazar). Esto se sube a <code>quarantine</code> y luego a
<code>reject</code> después del warming (Fase 2).</p>

<div class="step">
  <div class="step-title"><span class="step-num">7.1</span>Agregar DMARC en Namecheap</div>
  <p><strong>Advanced DNS → ADD NEW RECORD</strong>:</p>
  <div>
    <div class="field-row">
      <div class="field-label">Type</div>
      <div class="field-value">TXT Record</div>
    </div>
    <div class="field-row">
      <div class="field-label">Host</div>
      <div class="field-value">_dmarc</div>
    </div>
    <div class="field-row">
      <div class="field-label">Value</div>
      <div class="field-value">v=DMARC1; p=none; rua=mailto:dmarc@runna.com.mx; pct=100; adkim=r; aspf=r;</div>
    </div>
    <div class="field-row">
      <div class="field-label">TTL</div>
      <div class="field-value">Automatic</div>
    </div>
  </div>
  <p>Guardar.</p>
</div>

<div class="step">
  <div class="step-title"><span class="step-num">7.2</span>Verificar</div>
  <p>Ve a <a href="https://mxtoolbox.com/dmarc.aspx">mxtoolbox.com/dmarc.aspx</a>:</p>
  <ol>
    <li>Escribe <code>runnareach.com</code></li>
    <li>Click <strong>Search</strong></li>
    <li>Deberías ver tu record con <code>p=none</code>. ✅</li>
  </ol>
</div>

<h2 class="phase">Fase 8 · Crear los buzones de tus senders</h2>

<div class="step">
  <div class="step-title"><span class="step-num">8.1</span>En el Admin Console</div>
  <ol>
    <li>Ve a <a href="https://admin.google.com">admin.google.com</a></li>
    <li>Sidebar: <strong>Directory → Users</strong></li>
    <li>Click <strong>Add new user</strong> (botón arriba)</li>
    <li>Llena:
      <ul>
        <li><strong>First name</strong>: Pedro</li>
        <li><strong>Last name</strong>: De Velasco</li>
        <li><strong>Primary email</strong>: <code>pedro</code> y en el
            dropdown del dominio elige <strong>@runnareach.com</strong>
            (NO @runna.com.mx)</li>
        <li><strong>Password</strong>: genera uno fuerte. Guárdalo en tu
            password manager.</li>
      </ul>
    </li>
    <li>Click <strong>Add new user</strong></li>
  </ol>
  <div class="callout">
    <p><strong>NO uses el mismo password de @runna.com.mx.</strong> Cada
    sender debe tener su propio buzón con su propio password.</p>
  </div>
</div>

<div class="step">
  <div class="step-title"><span class="step-num">8.2</span>Login para activar el buzón</div>
  <ol>
    <li>Abre <a href="https://gmail.com">gmail.com</a> en una ventana de
        incógnito (para no chocar con tu sesión de @runna.com.mx)</li>
    <li>Login con <code>pedro@runnareach.com</code> y el password</li>
    <li>Acepta los términos</li>
    <li>Manda un email de prueba a tu correo personal. Si llega, el buzón
        está vivo. ✅</li>
  </ol>
</div>

<div class="step">
  <div class="step-title"><span class="step-num">8.3</span>Configurar firma + display name</div>
  <p>Dentro de Gmail con <code>pedro@runnareach.com</code>:</p>
  <ol>
    <li>⚙ <strong>Settings → See all settings → General</strong>
      <ul>
        <li><strong>Signature</strong>: firma profesional con nombre, título, logo Rünna</li>
      </ul>
    </li>
    <li><strong>Settings → Accounts and Import → Send mail as → edit info</strong>
      <ul>
        <li><strong>Name</strong>: <code>Pedro De Velasco</code> (como quieres que aparezca)</li>
      </ul>
    </li>
    <li>Save changes</li>
  </ol>
  <p>Repite Paso 8.1 para cada sender adicional que quieras (típicamente
  3–4 para empezar el outreach distribuido en Fase 2).</p>
</div>

<h2 class="phase">Fase 9 · Verificar que TODO funciona</h2>

<p>Antes de terminar, valida que toda la configuración está limpia.
Esto te ahorra dolores de cabeza después.</p>

<div class="step">
  <div class="step-title"><span class="step-num">9.1</span>Score con mail-tester</div>
  <p>Esta es <strong>la prueba más importante</strong>:</p>
  <ol>
    <li>Abre <a href="https://www.mail-tester.com">mail-tester.com</a></li>
    <li>Te muestra una dirección random como
        <code>test-abc123@mail-tester.com</code> — <strong>cópiala</strong></li>
    <li>Desde Gmail con <code>pedro@runnareach.com</code>, manda un email a
        esa dirección con:
      <ul>
        <li><strong>Subject</strong>: cualquier cosa, p.ej. "Test 1"</li>
        <li><strong>Body</strong>: 3–4 párrafos de texto real. Por ejemplo:</li>
      </ul>
    </li>
  </ol>
  <pre>Hola — esto es un test de configuración del dominio nuevo
runnareach.com en mi Workspace de Rünna. Solo verificando
que SPF, DKIM y DMARC están alineados. Si recibiste este
correo, todo está funcionando bien.

Saludos, Pedro.</pre>
  <ol start="4">
    <li>Mándalo</li>
    <li>Regresa a mail-tester y click <strong>Then check your score</strong></li>
  </ol>
  <div class="callout ok">
    <p><strong>✅ Quieres ≥ 9/10.</strong> Si pasas esto, técnicamente
    estás listo para empezar warming (Fase 2 — guía aparte).</p>
  </div>
  <div class="callout danger">
    <p><strong>Score &lt; 9/10:</strong> abre los detalles del reporte:</p>
    <ul>
      <li><em>"SPF: not aligned"</em> → revisa Fase 5</li>
      <li><em>"DKIM: not signed"</em> → revisa Fase 6.3, asegúrate de
          haber dado <strong>Start authentication</strong> después de pegar
          el record</li>
      <li><em>"DMARC: not found"</em> → revisa Fase 7</li>
    </ul>
  </div>
</div>

<div class="step">
  <div class="step-title"><span class="step-num">9.2</span>Verificación adicional con port25 (opcional)</div>
  <p>Manda un email desde <code>pedro@runnareach.com</code> a:</p>
  <pre>check-auth@verifier.port25.com</pre>
  <p>Subject cualquier cosa, body vacío está bien. Te responde con un
  email detallado mostrando:</p>
  <ul>
    <li>SPF: pass / fail</li>
    <li>DKIM: pass / fail</li>
    <li>DMARC: pass / fail</li>
    <li>Sender-ID: pass / fail</li>
  </ul>
  <p>Quieres ver <strong>pass</strong> en SPF, DKIM y DMARC.</p>
</div>

<h2>Troubleshooting (Namecheap específico)</h2>

<div class="step">
  <div class="step-title">"Domain verified" pero los emails no llegan</div>
  <p>99% de las veces faltan los MX records (Fase 4). Reverifica en
  <a href="https://mxtoolbox.com/SuperTool.aspx">mxtoolbox.com/SuperTool.aspx</a>
  con <strong>MX Lookup</strong>. Debe mostrar
  <code>smtp.google.com</code> priority 1.</p>
</div>

<div class="step">
  <div class="step-title">Score de mail-tester sale 6/10 o menos</div>
  <p>Probablemente DKIM no terminó de activarse. Vuelve a Fase 6.3 y
  dale <strong>Start authentication</strong> otra vez. Espera 1 hora y
  reintenta.</p>
</div>

<div class="step">
  <div class="step-title">Namecheap dice "Value too long" al pegar DKIM</div>
  <p>Parte el blob en dos pedazos &lt; 255 chars y pégalos así:</p>
  <pre>"v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG..." "...resto del blob"</pre>
  <p>Con comillas dobles y espacio entre ellos. Namecheap los concatena
  automáticamente al servir el record.</p>
</div>

<div class="step">
  <div class="step-title">"550 5.7.0 mail relay denied" al mandar test</div>
  <p>El buzón aún no está activado. Asegúrate de haber hecho login al
  menos una vez con cada sender (Paso 8.2) para que Gmail prenda el
  outbox.</p>
</div>

<div class="step">
  <div class="step-title">Conflicto de SPF / "too many lookups"</div>
  <p>Significa que tu SPF tiene &gt; 10 includes. En este caso solo tiene
  <code>include:_spf.google.com</code>, así que no debería pasar. Si pasa,
  es porque dejaste un SPF viejo de Namecheap (verifica en Advanced DNS
  que solo haya UN TXT que empiece con <code>v=spf1</code>).</p>
</div>

<h2>Checklist final</h2>

<ul class="checklist">
  <li><strong>Fase 1</strong> — runnareach.com agregado como Secondary domain en Workspace</li>
  <li><strong>Fase 2</strong> — Sé llegar a Advanced DNS en Namecheap</li>
  <li><strong>Fase 3</strong> — TXT verificación pegado · dominio verificado en Workspace</li>
  <li><strong>Fase 4</strong> — MX <code>smtp.google.com</code> priority 1 publicado</li>
  <li><strong>Fase 5</strong> — SPF <code>v=spf1 include:_spf.google.com ~all</code> publicado</li>
  <li><strong>Fase 6</strong> — DKIM generado · pegado · activado en Workspace</li>
  <li><strong>Fase 7</strong> — DMARC <code>p=none</code> publicado</li>
  <li><strong>Fase 8</strong> — <code>pedro@runnareach.com</code> creado · login OK · firma OK</li>
  <li><strong>Fase 9</strong> — mail-tester.com score ≥ 9/10</li>
</ul>

<div class="callout ok">
  <p><strong>Cuando completes los 9 puntos, técnicamente estás listo.</strong>
  El siguiente paso es Fase 2 (warming) — calendarizar envíos durante
  6 semanas antes de meterlo a S.P.A.M. para outreach a frío. Esa guía
  va aparte.</p>
</div>

<h2>Glosario rápido</h2>

<table>
  <thead>
    <tr><th>Término</th><th>Qué significa</th></tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>DNS</strong></td>
      <td>Domain Name System — la "guía telefónica" de internet. Le dice a
          Google y a todos los demás dónde mandar tu correo.</td>
    </tr>
    <tr>
      <td><strong>TXT record</strong></td>
      <td>Un texto que pones en tu DNS que cualquiera puede leer. Se usa para
          verificación, SPF, DKIM, DMARC.</td>
    </tr>
    <tr>
      <td><strong>MX record</strong></td>
      <td>"Mail Exchange" — el record que dice qué servidor recibe el
          correo de tu dominio.</td>
    </tr>
    <tr>
      <td><strong>SPF</strong></td>
      <td>Sender Policy Framework — autoriza qué servidores pueden mandar
          correo en tu nombre.</td>
    </tr>
    <tr>
      <td><strong>DKIM</strong></td>
      <td>DomainKeys Identified Mail — firma criptográfica que prueba que
          el correo no fue modificado.</td>
    </tr>
    <tr>
      <td><strong>DMARC</strong></td>
      <td>Política de qué hacer con correos que no pasan SPF/DKIM. Empezamos
          con <code>p=none</code> (solo monitorear).</td>
    </tr>
    <tr>
      <td><strong>Secondary domain</strong></td>
      <td>Dominio adicional en un Workspace donde cada usuario tiene su
          propio buzón separado (no comparten con el dominio principal).</td>
    </tr>
    <tr>
      <td><strong>Sender inbox</strong></td>
      <td>El buzón desde el que mandas (p.ej. <code>pedro@runnareach.com</code>).
          En S.P.A.M. estos viven en la tabla <code>sender_inboxes</code>.</td>
    </tr>
  </tbody>
</table>

</body>
</html>`;

const outputPath = join(
  process.cwd(),
  "tasks",
  "runnareach-namecheap-setup.pdf",
);

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

// `setContent` blocks until the network idles → we don't fetch anything
// external, so this resolves instantly. Then `pdf()` prints with our
// `@page` rules so margins + footer counters apply.
await page.setContent(html, { waitUntil: "load" });
await page.emulateMedia({ media: "print" });
await page.pdf({
  path: outputPath,
  format: "A4",
  printBackground: true,
  preferCSSPageSize: true,
});

await browser.close();

const { statSync } = await import("node:fs");
const stat = statSync(outputPath);
console.log(`✓ wrote ${outputPath} (${(stat.size / 1024).toFixed(1)} KB)`);
