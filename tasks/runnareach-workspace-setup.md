# Anclar runnareach.com al Google Workspace de Rünna — paso a paso

> Guía hand-holding para alguien que nunca ha hecho esto. No saltes pasos. Cada
> click está aquí. Cada valor está listo para copiar-pegar.

---

## TL;DR (qué vas a hacer y por qué)

Vas a tomar el dominio **runnareach.com** que acabas de comprar y conectarlo al
Google Workspace que ya tiene Rünna (el de runna.com.mx). Cuando termines:

- Vas a poder crear correos como `pedro@runnareach.com` con su propio buzón Gmail
- Esos correos van a estar autenticados (SPF + DKIM + DMARC) — sin esto van directo a spam
- Vas a poder usarlos en S.P.A.M. para outreach a prospectos canadienses

**No es un alias** del dominio principal. Es un **dominio secundario** —
distinto buzón, distinto password, distinto inbox. Eso es lo que queremos
para outreach.

---

## ⏱️ Cuánto tiempo te va a tomar

| Fase | Tu tiempo | Espera (DNS propaga) |
|---|---|---|
| Fase 1: Agregar dominio en Workspace | 5 min | — |
| Fase 2: Encontrar tu DNS | 2 min | — |
| Fase 3: TXT de verificación | 5 min | 5–15 min |
| Fase 4: MX records | 3 min | 15–60 min |
| Fase 5: SPF | 2 min | 15 min |
| Fase 6: DKIM | 5 min | 30 min |
| Fase 7: DMARC | 2 min | 15 min |
| Fase 8: Crear mailboxes | 5 min | — |
| Fase 9: Verificar | 5 min | — |
| **Total trabajo activo** | **~35 min** | + propagación |
| **Fase 10: Warming** | — | **6 semanas calendar** ⚠️ |

> ⚠️ **No mandes outreach a frío hasta terminar Fase 10.** Si lo haces antes,
> quemas el dominio para siempre y tienes que comprar otro.

---

## Antes de empezar — lo que necesitas tener a la mano

- [ ] **Acceso super-admin al Workspace de Rünna** (admin.google.com con tu
      cuenta @runna.com.mx). Si no lo tienes, pídele a quien lo tenga.
- [ ] **Login al registrador donde compraste runnareach.com** (GoDaddy /
      Namecheap / Cloudflare / Google Domains / etc.) — necesitas usuario +
      password
- [ ] **Una pestaña abierta en cada uno** lado a lado. Vas a brincar entre las
      dos como 6 veces.
- [ ] **30–40 minutos sin interrupciones** para no perderte a media configuración.

---

## 🟣 FASE 1 — Agregar runnareach.com al Workspace

### Paso 1.1 — Entra al Admin Console

Abre 👉 **https://admin.google.com** en una pestaña nueva.

Inicia sesión con tu cuenta de **super-admin** del Workspace de Rünna
(probablemente algo como `pedro@runna.com.mx` o `admin@runna.com.mx`).

> 💡 Si te dice "You don't have admin access" → no eres super-admin. Pídele a
> quien sí lo sea que te promueva, o que haga estos pasos él/ella.

### Paso 1.2 — Ve a la sección de dominios

Una vez dentro, en el menú lateral izquierdo:

1. Click en **Account** (al fondo del menú, ícono de engrane)
2. Click en **Domains**
3. Click en **Manage domains**

Vas a ver una lista con `runna.com.mx` (y quizá otros dominios).

### Paso 1.3 — Agregar runnareach.com

1. Click en el botón **Add a domain** (arriba a la derecha)
2. En el campo "Domain name" escribe: `runnareach.com`
3. **MUY IMPORTANTE** — selecciona el radio button **Secondary domain**.
   - ❌ NO selecciones "User alias domain" — los aliases comparten buzón.
     Necesitamos buzones SEPARADOS para outreach.
4. Click en **Add domain & start verification**

### Paso 1.4 — Copia el código de verificación

Google te va a mostrar una pantalla con varias opciones de verificación.
Elige la primera: **TXT record (recommended)**.

Vas a ver algo como:

```
google-site-verification=Xy7abc1234567defGHIJK_lmnopqrstUVWXYZabc
```

📋 **Copia ese valor completo** (desde `google-site-verification=` hasta el
final). Pégalo en una nota — lo vas a usar en la siguiente fase.

⏸️ **NO cierres esta pestaña.** Ábrela en otra ventana o déjala atrás. Vas
a regresar.

---

## 🟣 FASE 2 — Encontrar dónde se editan tus DNS

Aquí depende de dónde compraste el dominio. Salta a la sección que aplique:

| Si compraste en... | Salta a |
|---|---|
| **Cloudflare** | [Fase 2A](#fase-2a--cloudflare) |
| **GoDaddy** | [Fase 2B](#fase-2b--godaddy) |
| **Namecheap** | [Fase 2C](#fase-2c--namecheap) |
| **Google Domains / Squarespace Domains** | [Fase 2D](#fase-2d--google-domains--squarespace) |
| **Otro (Hover, Porkbun, etc.)** | [Fase 2E](#fase-2e--otro-registrador) |

### Fase 2A — Cloudflare

1. Entra a 👉 **https://dash.cloudflare.com**
2. Login con tu cuenta
3. Click en `runnareach.com` en la lista de sitios
4. En el menú lateral izquierdo, click en **DNS** → **Records**
5. La zona donde vas a agregar todos los records es esta tabla. Cada
   "Add record" es lo mismo:
   - **Type**: el tipo (TXT, MX, etc.)
   - **Name**: el host (puede ser `@`, `_dmarc`, o `google._domainkey`)
   - **Content** / **Target**: el valor
   - **Proxy status**: ⚠️ siempre **DNS only** (nube gris, no naranja).
     Si dejas la nube naranja, los records de email no funcionan.
   - **TTL**: déjalo en Auto

✅ Listo, ya sabes dónde editar. Salta a [Fase 3](#-fase-3--verificar-el-dominio).

### Fase 2B — GoDaddy

1. Entra a 👉 **https://dcc.godaddy.com/domains**
2. Login con tu cuenta
3. En la lista de dominios, click en `runnareach.com`
4. Click en **DNS** (tab arriba)
5. Vas a ver la tabla de DNS records. Para agregar uno:
   - Click en **Add new record**
   - **Type**: el tipo
   - **Name**: el host (en GoDaddy `@` significa la raíz)
   - **Value** o **Data**: el valor
   - **TTL**: 1 hora (default)

✅ Listo. Salta a [Fase 3](#-fase-3--verificar-el-dominio).

### Fase 2C — Namecheap

1. Entra a 👉 **https://www.namecheap.com/myaccount/login**
2. Login
3. Click en **Domain List** (sidebar izquierdo)
4. Encuentra `runnareach.com` y click en **Manage** (botón a la derecha de la fila)
5. Click en la tab **Advanced DNS**
6. Para agregar un record:
   - Click en **Add new record**
   - **Type**: el tipo
   - **Host**: el host (en Namecheap `@` significa la raíz)
   - **Value**: el valor
   - **TTL**: Automatic

✅ Listo. Salta a [Fase 3](#-fase-3--verificar-el-dominio).

### Fase 2D — Google Domains / Squarespace

Google Domains se vendió a Squarespace en 2023. Si todavía estás en Google
Domains:

1. Entra a 👉 **https://domains.google.com**
2. Click en `runnareach.com`
3. Sidebar izquierdo: **DNS** → **Manage custom records**

Si ya migraste a Squarespace:

1. Entra a 👉 **https://account.squarespace.com**
2. **Domains** → `runnareach.com` → **DNS Settings**
3. Scroll a **Custom Records**, click **Add Record**

✅ Listo. Salta a [Fase 3](#-fase-3--verificar-el-dominio).

### Fase 2E — Otro registrador

Busca en su panel de control algo que diga:

- "DNS settings", "DNS records", "DNS management"
- "Zone editor", "Zone file"
- "Advanced DNS", "Custom DNS"

Si no lo encuentras, busca en Google: `<nombre del registrador> add TXT record`
y deberías encontrar instrucciones específicas.

✅ Una vez que lo encuentres, sigue con [Fase 3](#-fase-3--verificar-el-dominio).

---

## 🟣 FASE 3 — Verificar el dominio

Ahora vas a pegar ese código de verificación que copiaste en Paso 1.4.

### Paso 3.1 — Agregar el TXT record de verificación

En tu registrador (donde quedaste en Fase 2), agrega un nuevo record con
**estos valores exactos**:

| Campo | Valor |
|---|---|
| **Type** | `TXT` |
| **Name** / **Host** | `@` (significa la raíz del dominio) |
| **Value** / **Content** | `google-site-verification=Xy7abc...` *(el código que copiaste)* |
| **TTL** | Auto / 1 hora / 3600 (cualquiera está bien) |

Click en **Save** / **Add Record**.

### Paso 3.2 — Esperar a que propague

⏱️ **Espera 5–15 minutos.** Los DNS no son instantáneos.

Mientras esperas, puedes verificar que el record ya está visible públicamente
yendo a 👉 **https://mxtoolbox.com/TXTLookup.aspx**

- En "Domain Name" escribe: `runnareach.com`
- Click en **TXT Lookup**
- Si ves tu `google-site-verification=...` en los resultados, ya propagó. Si no,
  espera otros 5–10 min.

### Paso 3.3 — Decirle a Google que verifique

Regresa a la pestaña del Admin Console (la que dejaste abierta al final de Fase 1).

Si ya cerraste esa pestaña, vuelve a:
**admin.google.com → Account → Domains → Manage domains → runnareach.com**

Click en **Verify** o **Activate**.

Si dice "Verified successfully" — ✅ pasaste Fase 3.
Si dice "We couldn't find the record" — espera 10 min más y reintenta.

---

## 🟣 FASE 4 — MX records (para recibir email)

Estos records le dicen al mundo: "para mandar mail a @runnareach.com, manda a
los servidores de Google". Sin esto no llega ni un solo correo.

### Paso 4.1 — Borrar MX records viejos (si existen)

Algunos registradores ponen MX records de placeholder cuando compras un
dominio. Borra TODOS los MX que ya estén ahí antes de agregar el de Google.

### Paso 4.2 — Agregar el MX record de Google

> 📌 **Buenas noticias**: Google migró a un solo MX record en 2023. Antes
> había 5 (ASPMX, ALT1, ALT2…), pero ahora solo necesitas uno.

| Campo | Valor |
|---|---|
| **Type** | `MX` |
| **Name** / **Host** | `@` |
| **Value** / **Mail server** | `smtp.google.com` |
| **Priority** | `1` |
| **TTL** | Auto / 1 hora |

Click en **Save**.

> 💡 Si tu UI te exige múltiples MX records, deja **solo este**. No agregues
> los antiguos ASPMX.L.GOOGLE.COM — Google los va a deprecar.

### Paso 4.3 — Verificar

⏱️ Espera 15–30 min, luego ve a 👉 **https://mxtoolbox.com/SuperTool.aspx**

- En el dropdown elige **MX Lookup**
- Escribe `runnareach.com`
- Click **Search**
- Deberías ver `smtp.google.com` con priority 1.

---

## 🟣 FASE 5 — SPF (autoriza a Google a enviar en tu nombre)

SPF dice: "los emails que digan ser de @runnareach.com solo son legítimos si
salen de los servidores de Google". Sin SPF, casi todos los proveedores marcan
tus correos como spam.

### Paso 5.1 — Agregar SPF

| Campo | Valor |
|---|---|
| **Type** | `TXT` |
| **Name** / **Host** | `@` |
| **Value** | `v=spf1 include:_spf.google.com ~all` |
| **TTL** | Auto |

Click en **Save**.

> ⚠️ **Solo puede haber UN record SPF por dominio.** Si ya hay uno (raro pero
> pasa), no agregues otro — edita el existente para meter
> `include:_spf.google.com` dentro.

### Paso 5.2 — Verificar

Ve a 👉 **https://mxtoolbox.com/spf.aspx** → escribe `runnareach.com` → Search.

Debería mostrar tu record y decir **SPF Record: PASS**.

---

## 🟣 FASE 6 — DKIM (firma criptográfica)

DKIM firma cada correo con una llave privada que solo Google tiene. El receptor
verifica con la llave pública (que vas a publicar en DNS) que el correo no fue
modificado en tránsito.

### Paso 6.1 — Generar la llave en Workspace

En **admin.google.com**:

1. Sidebar: **Apps** → **Google Workspace** → **Gmail**
2. Click en **Authenticate email** (en la página de Gmail settings)
3. En el dropdown "Selected domain" elige **runnareach.com**
4. Click en **Generate new record**
5. Selecciona **2048** bits (más seguro que 1024)
6. Selector: déjalo en **google** (default)
7. Click **Generate**

Google te va a mostrar:

```
DNS Host name (TXT record name):  google._domainkey
TXT record value:                 v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BA...
                                  (un blob largísimo, copia TODO)
```

📋 **Copia el TXT record value completo.** Es muy largo (1000+ caracteres) —
asegúrate de copiar desde `v=DKIM1` hasta el final, sin saltos de línea
extras.

⏸️ **NO cierres esta pestaña.** Vuelves al final.

### Paso 6.2 — Pegarlo en tu DNS

En tu registrador:

| Campo | Valor |
|---|---|
| **Type** | `TXT` |
| **Name** / **Host** | `google._domainkey` |
| **Value** | El blob largo que copiaste (`v=DKIM1; k=rsa; p=...`) |
| **TTL** | Auto |

Click **Save**.

> ⚠️ Algunos registradores (GoDaddy en particular) tienen un límite de 255
> caracteres por TXT — si tu blob no cabe, busca en Google
> "<tu registrador> long TXT record DKIM" y sigue las instrucciones de
> "split into multiple strings".

### Paso 6.3 — Activar DKIM en Workspace

⏱️ Espera 30 min para que el DNS propague.

Verifica en 👉 **https://mxtoolbox.com/dkim.aspx**:
- Domain: `runnareach.com`
- Selector: `google`
- Si dice "DKIM record found" — ya propagó.

Regresa a la pestaña de **Gmail → Authenticate email** y click en
**Start authentication**.

Si dice "Authenticating email" → ✅ DKIM está activo.

---

## 🟣 FASE 7 — DMARC (política de qué hacer con los falsos)

DMARC le dice a los receptores: "si un email NO pasa SPF ni DKIM, hazle X".
Para warming empezamos con `p=none` (solo monitorear, no rechazar).

### Paso 7.1 — Agregar DMARC

| Campo | Valor |
|---|---|
| **Type** | `TXT` |
| **Name** / **Host** | `_dmarc` |
| **Value** | `v=DMARC1; p=none; rua=mailto:dmarc@runna.com.mx; pct=100; adkim=r; aspf=r;` |
| **TTL** | Auto |

> 📌 **¿Por qué `p=none`?** Porque durante warming a veces los headers no
> alinean perfecto y no quieres que tus primeros correos legítimos reboten.
> En 4–6 semanas subes a `p=quarantine` y eventualmente a `p=reject`.

### Paso 7.2 — Verificar

Ve a 👉 **https://mxtoolbox.com/dmarc.aspx** → `runnareach.com` → Search.

Deberías ver tu record con `p=none`. ✅

---

## 🟣 FASE 8 — Crear los buzones de tus senders

Ahora sí, el momento que importa: crear `pedro@runnareach.com`.

### Paso 8.1 — En el Admin Console

1. Ve a 👉 **https://admin.google.com**
2. Sidebar: **Directory** → **Users**
3. Click en **Add new user** (botón arriba)
4. Llena:
   - **First name**: Pedro (o el que sea)
   - **Last name**: De Velasco
   - **Primary email**: `pedro` y en el dropdown del dominio elige
     **@runnareach.com** (no @runna.com.mx)
   - **Password**: genera uno fuerte. **NO** uses el mismo de @runna.com.mx.
5. Click **Add new user**

### Paso 8.2 — Login para activar

Abre 👉 **https://gmail.com** en una ventana de incógnito.

Login con `pedro@runnareach.com` y el password que pusiste. Acepta los
términos. Manda un email de prueba a tu correo personal. Si llega, el
buzón está vivo. ✅

### Paso 8.3 — Configurar firma + nombre de display

Dentro de Gmail con `pedro@runnareach.com`:

1. **⚙ Settings → See all settings → General**
2. Configura:
   - **Signature**: una firma profesional con nombre, título, logo Rünna
3. **Settings → Accounts and Import → Send mail as → edit info**
   - **Name**: `Pedro De Velasco` (o como quieras que aparezca)
4. Save changes

> 💡 Repite Paso 8.1 para cada sender que vayas a usar (típicamente 3–4 para
> empezar a escalar el outreach distribuido).

---

## 🟣 FASE 9 — Verificar que TODO funciona

Antes de empezar warming, valida que la configuración está limpia.

### Paso 9.1 — Score con mail-tester

Esta es **la prueba más importante**. Si pasas esta, ya estás listo para
warming.

1. Abre 👉 **https://www.mail-tester.com**
2. Te muestra una dirección random como `test-abc123@mail-tester.com` —
   **cópiala**
3. Desde Gmail con `pedro@runnareach.com`, manda un email a esa dirección:
   - **To**: la dirección de mail-tester
   - **Subject**: cualquier cosa, p.ej. "Test 1"
   - **Body**: 3–4 párrafos de texto real (NO uses palabras tipo "free", "buy",
     "act now" — eso baja el score artificialmente). Algo como:

     > Hola — esto es un test de configuración del dominio nuevo
     > runnareach.com en mi Workspace de Rünna. Solo verificando que SPF,
     > DKIM y DMARC están alineados. Si recibiste este correo, todo está
     > funcionando bien. Saludos, Pedro.

   - Mándalo
4. Regresa a la pestaña de mail-tester y click en **Then check your score**

Vas a ver un score 0/10 a 10/10. **Quieres ≥ 9/10** antes de empezar warming.

Si tu score es bajo, abre los detalles para ver qué falló:
- ❌ "SPF: not aligned" → revisa Fase 5
- ❌ "DKIM: not signed" → revisa Fase 6, asegúrate de haber dado **Start
  authentication** después de pegar el record
- ❌ "DMARC: not found" → revisa Fase 7

### Paso 9.2 — Verificación adicional con port25 (opcional)

Manda un email desde `pedro@runnareach.com` a:
**`check-auth@verifier.port25.com`**

Subject: cualquier cosa. Body: vacío está bien.

Te va a responder con un email detallado mostrando:
- SPF: pass / fail
- DKIM: pass / fail
- DMARC: pass / fail
- Sender-ID: pass / fail

Quieres ver `pass` en SPF, DKIM, y DMARC.

---

## 🟣 FASE 10 — Warming (LO MÁS IMPORTANTE)

> 🚨 **No te saltes esta fase.** Si empiezas a mandar 100 correos a frío el
> día 1 desde un dominio nuevo, los proveedores (Gmail, Outlook, Yahoo) lo
> marcan como spammer en menos de una semana. Tu dominio queda inutilizable
> y la única solución es comprar otro y empezar de cero.

### Plan de 6 semanas

| Semana | Volumen / día | Tipo de envíos |
|---|---|---|
| 1 | 5–10 | Solo a contactos que **sí van a abrir y responder** (amigos, equipo Rünna, clientes existentes). Mete diversidad: Gmail, Outlook, Hotmail, Yahoo. |
| 2 | 15–25 | Igual — pide que respondan, no solo que abran. Las respuestas son señal #1 para los ESPs. |
| 3 | 30–50 | Ya puedes meter contactos de bajo riesgo (newsletters opt-in, comunidad PRO Academy si aplica). |
| 4 | 50–80 | Sigue mezclando con respuestas reales. |
| 5 | 80–120 | Casi listo — ya puedes empezar test pequeño en S.P.A.M. con 20/día desde @runnareach.com. |
| 6+ | 200–300 | **AHORA SÍ** ya puedes cargarle al engine. Empieza con `daily_cap=30` en la tabla `sender_inboxes` y sube de a 10/día. |

### Tools que automatizan warming

Hacer warming manual es tedioso (mandar 5–10 correos diarios reales a humanos
que respondan). Estos tools lo simulan automáticamente conectándose a una red
de inboxes que se mandan y responden entre sí:

| Tool | Precio aprox. | Recomendación |
|---|---|---|
| **Mailwarm** | $69/mes por inbox | Veterano, confiable. https://www.mailwarm.com |
| **Warmup Inbox** | $39/mes por inbox | Buen balance precio/features. https://www.warmupinbox.com |
| **Lemwarm** (parte de Lemlist) | $29/mes por inbox | El más barato, buena UI. https://www.lemlist.com |
| **Instantly Warmup** | Incluido en Instantly | Gratis si ya pagas Instantly. https://instantly.ai |

> 💡 Pedro: para 1 dominio + 1–3 senders, **Lemwarm o Warmup Inbox** son
> suficientes. ~$30–70/mes total durante 6 semanas, después puedes cancelar.

### Reglas durante warming

- ✅ Configura el tool de warming desde el día 1 después de Fase 9
- ✅ No mandes outreach a frío hasta semana 5–6
- ✅ Mantén `p=none` en DMARC durante todo el warming
- ❌ NO uses link tracking ni open tracking durante semana 1–2 (los links
  redirigidos son señal de spam para los ESPs hasta que el dominio tiene
  reputación)
- ❌ NO mandes el mismo template a 100 inboxes — los filtros de spam detectan
  exact-match content
- ❌ NO uses palabras tipo "free", "guaranteed", "act now", "limited time",
  "make money fast" en outreach inicial

### Después de warming (semana 7+)

- Sube DMARC a `p=quarantine`:
  Edita el TXT `_dmarc` y cambia `p=none` por `p=quarantine`
- Ya puedes activar link tracking en S.P.A.M.
- Mantén volume ≤ 300/día por inbox por las siguientes 4 semanas
- Después de 12 semanas total puedes ir a `p=reject` (DMARC estricto)

---

## 🆘 Troubleshooting

### "Domain verified" pero los emails no llegan

99% de probabilidades es que faltan los MX records (Fase 4). Reverifica en
mxtoolbox.com/SuperTool.aspx con MX Lookup.

### El score de mail-tester sale 6/10 o menos

Probablemente DKIM no terminó de activarse o el TXT está corrupto. Vuelve a
Fase 6.3 y dale **Start authentication** otra vez. Espera 1 hora y reintenta.

### "Could not find DKIM record"

Algunos registradores cortan el TXT a 255 chars. Tu DKIM record es ~400+
chars. Tienes que partirlo en múltiples strings entre comillas:

```
"v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxxx..." "...yyy..."
```

Busca en Google: `<tu registrador> DKIM long TXT record split` para
instrucciones exactas. Cloudflare lo maneja automáticamente, GoDaddy y
Namecheap a veces no.

### "550 5.7.0 mail relay denied"

Estás tratando de mandar desde un buzón que todavía no terminas de configurar.
Asegúrate de haber hecho login al menos una vez con cada sender (Paso 8.2)
para que Gmail active el outbox.

### Conflicto de SPF — "Permanent error: too many lookups"

Significa que tu SPF tiene >10 includes. En este caso solo tiene
`include:_spf.google.com` así que no debería pasar. Si pasa, revisa que no
hayas dejado un SPF viejo del registrador.

---

## 📋 Checklist final

Cuando completes cada fase, marca acá:

- [ ] **Fase 1** — runnareach.com agregado como dominio secundario en Workspace
- [ ] **Fase 2** — Sé dónde editar mis DNS records
- [ ] **Fase 3** — TXT de verificación pegado y dominio verificado
- [ ] **Fase 4** — MX `smtp.google.com` priority 1 publicado
- [ ] **Fase 5** — SPF `v=spf1 include:_spf.google.com ~all` publicado
- [ ] **Fase 6** — DKIM generado, pegado, activado en Workspace
- [ ] **Fase 7** — DMARC `p=none` publicado
- [ ] **Fase 8** — `pedro@runnareach.com` creado y firmado
- [ ] **Fase 9** — mail-tester.com score ≥ 9/10
- [ ] **Fase 10a** — Tool de warming configurado (Lemwarm / Warmup Inbox)
- [ ] **Fase 10b** — Semana 1 de warming completada
- [ ] **Fase 10c** — Semana 6 de warming completada → ready for S.P.A.M.

---

## 📖 Glosario rápido

| Término | Qué significa |
|---|---|
| **DNS** | Domain Name System — la "guía telefónica" de internet. Le dice a Google y a todos los demás dónde mandar tu correo. |
| **TXT record** | Un texto que pones en tu DNS que cualquiera puede leer. Se usa para verificación, SPF, DKIM, DMARC. |
| **MX record** | "Mail Exchange" — el record que dice qué servidor recibe el correo de tu dominio. |
| **SPF** | "Sender Policy Framework" — autoriza qué servidores pueden mandar correo en tu nombre. |
| **DKIM** | "DomainKeys Identified Mail" — firma criptográfica que prueba que el correo no fue modificado. |
| **DMARC** | Política de qué hacer con correos que no pasan SPF/DKIM. Empezamos con `p=none` (solo monitorear). |
| **Warming** | Subir el volumen de envío de manera gradual para construir reputación con Gmail/Outlook. Sin warming = spam folder garantizado. |
| **Sender inbox** | El buzón desde el que mandas (p.ej. pedro@runnareach.com). Tabla `sender_inboxes` en S.P.A.M. |
| **Cold outreach** | Correos a frío — gente que no te conoce. Lo más sensible a reputación de dominio. |

---

## Cuando termines

Avísame con "ok runnareach setup completado" y actualizo el todo:
- [ ] **Domains locked: runna.agency (primary) + runnareach.com (outreach
      secondary). Public name: Runna CA.** ← este queda más sólido
- [ ] Marcamos `runnareach.com` agregado al Workspace ✓ con DNS configurado ✓

Después de la fase 10 podemos arrancar S.P.A.M. para mandar de a poquito.
