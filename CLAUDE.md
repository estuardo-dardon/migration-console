# migration-console — Referencia para desarrollar

Consola independiente para controlar migraciones de bases de datos: lista las migraciones de una carpeta con su estado por ambiente, **simula** exactamente qué haría cada script y pide **confirmación** antes de aplicarlo. No pertenece a ningún proyecto; el primer uso previsto es `supabase/migrations` de Delantos. Uso y despliegue: `README.md`.

## Internationalization

Two languages: `es-ES` (default) and `en-US`. Language stored in `localStorage` (`mc.lang`); the selector is in the header.

- **Catalogs**: `src/ui/locales/es-ES.json` and `en-US.json`, flat keys, `{name}` placeholders, `key_one` / `key_other` plural variants chosen by the `count` parameter. `src/ui/i18n.js` (`makeT`) is shared by the browser and the server (`src/i18n.ts`, used by the CLI).
- **The API sends codes, not Spanish.** `Finding.code`, `Note`, `errorInfo`, `skippedInfo`, `skippedCode` and `ConsoleError.code` + `details` are what clients translate (`finding.<code>`, `note.<code>`, `sim.<code>`, `stmt.<code>`, `error.<code>`); the plain `message` / `error` text next to them is English, a fallback for logs and scripts. Never put user-facing Spanish in `src/*.ts`.
- **New user-facing text**: add the key to *both* catalogs. `test/i18n.test.ts` fails if the keys or placeholders differ, or if a risk rule (`RULES`), an error code or a `data-i18n` attribute has no translation. A new `ConsoleError` code needs `error.<code>`; pass the values its message uses in `details`.
- **UI**: static text uses `data-i18n`, `data-i18n-placeholder`, `data-i18n-aria-label` in `index.html`; dynamic text uses `t(...)`. Use `t.parts(...)` to put a DOM node inside a sentence (never build HTML strings). Dates use `toLocaleString(t.lang)`.
- **CLI**: `--lang`, then `CONSOLE_LANG`, then the system locale, then `es-ES`. Startup and configuration errors (`config.ts`, `serve`) stay in English: they are for whoever deploys it.
- A new language: add the file, add it to `LANGS` in `src/ui/i18n.js`, add an `<option>` to the selector.


---

## Stack

| | |
|---|---|
| Runtime | Node ≥ 22, TypeScript estricto, ESM (`"type": "module"`, imports con extensión `.js`) |
| Dependencias | `pg`, `mysql2`, `mssql` — nada más en producción. **Sin framework web**: `node:http` |
| Interfaz | HTML/CSS/JS plano en `src/ui/` (sin build ni framework); `tsconfig` con `allowJs`/`checkJs` desactivados |
| Pruebas | Vitest (`npm test`) |
| Empaquetado | Docker (`Dockerfile`, `docker-compose.example.yml`) |

Las versiones están **fijadas exactas** en `package.json`. Añadir una dependencia es una decisión: la superficie es pequeña a propósito.

## Comandos

```bash
npm install
npm run typecheck
npm test                      # unitarias; las de PostgreSQL se omiten sin base de datos
npm run build                 # tsc + copia de src/ui a dist/
npm run dev                   # necesita config.json y CONSOLE_TOKEN
```

Pruebas de integración (PostgreSQL 16 real, imprescindible tras tocar `drivers/postgres*.ts`, `engine.ts` o el analizador):

```bash
docker run -d --rm --name mc-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres npx vitest run
docker stop mc-pg
```

**Usa siempre `npx vitest run` (o `npm test`), nunca `vitest` a secas**: entra en modo watch y deja procesos vivos.

## Estructura

```
src/
  types.ts               Tipos compartidos (Migration, MigrationStatus, EnvMode, SimulationResult, Change…)
  config.ts              Carga y valida config.json; ${VAR} desde el entorno; redactUrl()
  source.ts              Lee <versión>_<nombre>.sql de la carpeta; checksum sha256
  engine.ts              Reglas de negocio: estado, simulación, aplicación, orden, confirmación
  server.ts              API HTTP + estáticos; token, CSP, rutas /api/environments/…
  cli.ts                 serve | status | simulate | apply | check
  sql/splitter.ts        Divide un script en sentencias (comillas, $$, comentarios, #, GO…)
  sql/analyze.ts         Clasifica sentencias y detecta riesgos (reglas RULES)
  drivers/driver.ts      Interfaz Driver (connect, readHistory, initHistory, baseline, simulate, apply, blockers)
  drivers/postgres.ts    Simulación en transacción + ROLLBACK; aplicación con candado y historial
  drivers/postgres-snapshot.ts   Foto del catálogo antes/después y diff
  drivers/mysql.ts, mssql.ts     Solo análisis al simular (sin probar contra un servidor real)
  drivers/static.ts      Base para drivers que solo analizan
  i18n.ts                Catálogos y traductor para el servidor/CLI (pickLang)
  ui/                    index.html, app.js, net.js (efecto neto de la cadena), i18n.js, locales/*.json, style.css
test/                    *.test.ts; *.integration.test.ts necesitan TEST_DATABASE_URL
```

## Conceptos del dominio

- **Ambiente** (`environments[]`): nombre + driver + URL + `mode`. `mode` **no tiene valor por defecto**: hay que decidirlo.
  - `apply`: se puede aplicar.
  - `simulate-only` (producción): **nunca** se aplica desde la consola.
- **Estados** (`MigrationStatus`): `pending`, `running`, `completed`, `failed`, `modified` (el archivo cambió después de aplicarse; se detecta por checksum), `unverified` (el ambiente aún no tiene historial). `deriveRows` en `engine.ts` los calcula.
- **Historial**: tabla `migration_console.history` en la propia base. Candado asesor `7243001` para que no corran dos aplicaciones a la vez.
- **Línea base** (`baseline`): marca como aplicadas, sin ejecutarlas, migraciones que ya se habían aplicado a mano.
- **Simulación** (Postgres): ejecuta el script con savepoints dentro de **una transacción que siempre termina en `ROLLBACK`** y compara una foto del catálogo antes y después. Eso produce los `Change` (objetos creados/modificados/eliminados), las filas tocadas por sentencia y los riesgos.
- **Efecto neto** (`src/ui/net.js`, `netChanges`): pliega el efecto de una cadena de migraciones (crear y luego borrar = nada). Es lo que se enseña como «Lo que hay que aplicar» en producción.

## Invariantes — no los «simplifiques»

Varios fueron errores antes de ser reglas.

1. **La simulación nunca hace `COMMIT`.** El `ROLLBACK` está en un `finally`; los comandos de control de transacción (`BEGIN`, `COMMIT`…) que traiga el script **no se envían** (un `COMMIT` dentro de un script volvería permanente la simulación); hay un tope de `idle_in_transaction_session_timeout`. `SimulationResult.committed` es literalmente `false`. Hay pruebas contra una base real que demuestran que no queda nada: no las debilites.
2. **`simulate-only` no tiene ninguna ruta de código que aplique.** Lo hace cumplir el motor (no la interfaz): el servidor responde 403 y el botón ni aparece. Cualquier camino nuevo que escriba debe pasar por la misma comprobación de modo.
3. **Aplicar exige una simulación previa y sin errores**, válida 30 minutos **para ese checksum exacto** (si el archivo cambia, hay que volver a simular). Se aplica **en orden y de una en una**, y el usuario escribe la versión para confirmar.
4. **Una migración, una transacción** (Postgres y SQL Server): todo o nada. En MySQL el DDL confirma solo, así que no hay todo-o-nada; el motor lo dice. Las sentencias que no caben en transacción (`CREATE INDEX CONCURRENTLY`, `VACUUM`…) se **omiten al simular** y se avisa, y al aplicar se tratan como parciales.
5. **`lock_timeout` corto al simular** (por defecto 3 s) para fallar rápido en vez de hacer cola detrás de un bloqueo ajeno. Simular DDL toma bloqueos reales (ACCESS EXCLUSIVE), por eso se recomienda un clon para tablas muy usadas. No lo subas «para que no falle».
6. **El token manda.** Todo `/api` exige `CONSOLE_TOKEN` (≥ 16 caracteres, comparación en tiempo constante); sin token el servidor no arranca. El nombre de usuario de la pantalla **etiqueta** el historial; no es autenticación.
7. **Los secretos no salen.** Las URL de conexión viajan por `${VAR}` y se enseñan con `redactUrl`; nunca van a la API, al log ni a mensajes de error. No registres cuerpos de error del driver sin pasarlos por la redacción.
8. **La interfaz inserta todo como texto** (`textContent`, nunca `innerHTML` con datos) y la CSP no permite scripts ni estilos en línea. El nombre de una migración o un mensaje de error es contenido no confiable. Si añades un archivo estático, regístralo en el conjunto `STATIC` de `server.ts`.
9. **La conexión necesita permisos de DDL**: no hay forma de simular DDL con un rol de solo lectura. Es una limitación, no un defecto.
10. **El separador de sentencias es el punto más delicado del analizador.** Respeta comillas simples/dobles, `$tag$ … $tag$`, comentarios anidados, y en MySQL `#` y barras invertidas; `GO` en SQL Server; `DELIMITER` se rechaza. Un cambio ahí exige casos nuevos en `test/splitter.test.ts`.
11. **El analizador tiende a avisar de más, no de menos**, pero una regla nueva no debe dar falsos positivos con texto dentro de comentarios o cadenas: pasa siempre por `stripComments`. Cada regla de `RULES` lleva su prueba.

## Cómo añadir un motor de base de datos

1. Implementa `Driver` en `src/drivers/<motor>.ts` (si solo analiza, extiende la base de `static.ts`).
2. Decláralo en `src/drivers/index.ts` y en `DriverName` (`types.ts`).
3. Declara sus `capabilities` con honestidad (¿simula de verdad?, ¿todo-o-nada?, ¿DDL transaccional?). La interfaz y el motor se adaptan a eso.
4. Pruébalo contra un servidor real antes de marcarlo como soportado. **MySQL y SQL Server hoy no lo están** y el README lo dice: no cambies esa nota sin haberlo hecho.

## Cómo añadir una regla de riesgo

Añádela a `RULES` en `src/sql/analyze.ts` con: código estable, severidad (`info|warning|danger`), patrón sobre la sentencia ya sin comentarios, y mensaje. Escribe una prueba que pase y otra que no deba saltar. Los textos para el usuario viven en el motor/interfaz, no repartidos.

## Estilo

- TypeScript estricto, sin `any` salvo en los límites con los drivers. Funciones pequeñas y puras donde se pueda (`sql/*`, `net.js`, `deriveRows`); la E/S vive en `drivers/` y `source.ts`.
- Errores de negocio con `ConsoleError` (código + mensaje), que el servidor traduce a un estado HTTP; no lances `Error` genérico hacia la API.
- Una dependencia nueva, un cambio de CSP o una ruta que escriba son decisiones que se comentan, no detalles.
- Comentarios solo donde el porqué no es evidente (sobre todo en `postgres*.ts` y el separador).

## Git

Repositorio local sin remoto todavía; trabaja en ramas cortas (`feat/…`, `bugfix/…`, `chore/…`) y haz commits pequeños. `config.json`, `.env`, `node_modules/` y `dist/` están en `.gitignore`: **nunca** versiones una URL de base de datos real.

## Límites conocidos (no los vendas como resueltos)

- MySQL y SQL Server: escritos pero **sin probar** contra un servidor real; la simulación solo analiza (en MySQL no se puede deshacer el DDL).
- No hay migraciones «hacia atrás»: se corrige con otra migración.
- La simulación no ve transacciones concurrentes ni efectos fuera de la base (HTTP, archivos); las secuencias consumidas no se devuelven.
- Una migración **no idempotente** ya aplicada falla al simularse: es información, no un error de la consola.
- Sin usuarios reales: un token compartido. Si se necesita auditoría por persona, hay que añadir autenticación.
- Pendientes razonables: probar los otros dos drivers, aplicar sin transacción con reanudación, notificaciones, autenticación por usuario.
