# migration-console

Consola para controlar las migraciones de bases de datos: ves qué migraciones están **pendientes, completadas o fallidas**, **simulas** exactamente qué haría cada script y un usuario **confirma** antes de aplicarlo. Es independiente de cualquier proyecto: lee una carpeta de archivos `.sql` y se conecta a las bases que le configures.

## Qué hace

- **Tabla de migraciones** por ambiente (dev, stage, prod…): `Pendiente`, `En ejecución`, `Completada`, `Fallida`, `Modificada` (el archivo cambió después de aplicarse) y `Sin verificar` (el ambiente aún no tiene historial).
- **Simulación** (PostgreSQL): ejecuta los scripts dentro de **una transacción que siempre se deshace** y compara la base de datos antes y después. Muestra, por migración y en conjunto:
  - los objetos que se crearían, cambiarían o eliminarían (tablas, columnas, índices, restricciones, funciones, triggers, políticas RLS, enums, vistas, permisos);
  - las filas que tocaría cada `INSERT`/`UPDATE`/`DELETE`;
  - los riesgos del script (`DROP`, `DELETE` sin `WHERE`, bloqueos largos, índices sin `CONCURRENTLY`…);
  - las sesiones con transacciones largas abiertas que podrían bloquearlo.
  Un script que ya está aplicado y es idempotente aparece como **«sin cambios»**.
- **Dos tipos de ambiente** (`mode`):
  - `apply`: se puede aplicar, solo después de una simulación sin errores y escribiendo la versión para confirmar. Se aplica de una en una, en orden, con candado para que no corran dos a la vez.
  - `simulate-only` (producción): **nunca** se aplica nada desde la consola. Solo muestra qué haría el script y permite descargar el plan.
- **Historial** en la propia base (`migration_console.history`): quién aplicó qué, cuándo y cuánto tardó, y el error si falló.
- **Línea base**: marca como aplicadas (sin ejecutarlas) las migraciones que se aplicaron a mano.

## Arrancar con Docker

```bash
cp config.example.json config.json            # ambientes y bases de datos
cp docker-compose.example.yml docker-compose.yml
cat > .env <<'ENV'
CONSOLE_TOKEN=<un secreto largo: openssl rand -base64 32>
MIGRATIONS_DIR=/ruta/a/tus/migraciones
DEV_DATABASE_URL=postgres://usuario:clave@host:5432/db
PROD_DATABASE_URL=postgres://usuario:clave@host:5432/db
ENV
docker compose up -d --build
# → http://127.0.0.1:8080  (pega el CONSOLE_TOKEN)
```

El puerto se publica solo en `127.0.0.1`. Para compartirlo, ponle delante tu propio proxy con autenticación; no lo publiques abierto.

### Configuración (`config.json`)

| Campo | |
|---|---|
| `migrationsDir` | Carpeta con `<versión>_<nombre>.sql` (formato de Supabase / timestamps). |
| `environments[].name` | `dev`, `stage`, `prod`… |
| `environments[].driver` | `postgres`, `mysql` o `mssql`. |
| `environments[].url` | Cadena de conexión. `${VAR}` se sustituye con variables de entorno: los secretos no van en el archivo. |
| `environments[].mode` | `apply` o `simulate-only`. **No tiene valor por defecto**: hay que decidirlo. |
| `environments[].schemas` | Postgres: esquemas que se comparan (por defecto `["public"]`). |
| `environments[].lockTimeoutMs` / `statementTimeoutMs` | Cuánto espera un bloqueo / una sentencia antes de rendirse (3 s / 60 s al simular; 5 s / 5 min al aplicar). |

Variables: `CONSOLE_TOKEN` (obligatoria, ≥16 caracteres), `CONSOLE_CONFIG`, `CONSOLE_HOST`, `CONSOLE_PORT`, `CONSOLE_LANG` (idioma del CLI).

### Idioma

La consola está en español (`es-ES`, por defecto) e inglés (`en-US`). En la web se cambia con el selector de la cabecera y se recuerda en el navegador; el CLI usa `--lang`, `CONSOLE_LANG` o el idioma del sistema.

## CLI

```bash
npm run build
node dist/cli.js status prod
node dist/cli.js simulate prod 20261101000000 20261102000000     # o sin versiones: las pendientes
node dist/cli.js apply dev 20261101000000 --confirm 20261101000000 --user ana
node dist/cli.js check                                            # valida la configuración
```

## Seguridad

- Todo `/api` exige el token (comparación en tiempo constante). El nombre de usuario que se escribe en pantalla **etiqueta** el historial; no es un inicio de sesión.
- La simulación **no tiene ninguna ruta que haga `COMMIT`**: el `ROLLBACK` está en un `finally`, los `BEGIN`/`COMMIT`/`END`/`ROLLBACK` que traiga el script **no se envían** (un `COMMIT` dentro de un script volvería permanente la simulación) y hay un tope de `idle_in_transaction_session_timeout`. Hay pruebas contra un PostgreSQL real de que nada queda guardado.
- Las sentencias que no caben en una transacción (`CREATE INDEX CONCURRENTLY`, `VACUUM`…) se **omiten** en la simulación y se avisa.
- La simulación toma los mismos bloqueos que tomaría el script (por eso `lockTimeoutMs` es corto): si otra sesión retiene la tabla, falla rápido en vez de hacer cola. **En producción conviene apuntarla a una réplica/clon recién restaurado si el script toca tablas muy usadas.**
- Los secretos nunca se devuelven por la API ni se escriben en el log. La interfaz inserta todo como texto y la política CSP no permite scripts en línea.
- La conexión necesita un rol con permisos de DDL, porque la simulación ejecuta el DDL (aunque lo deshaga). No hay forma de simular DDL con un rol de solo lectura.

## Alcance actual y límites

| Motor | Simulación | Aplicar | Estado |
|---|---|---|---|
| PostgreSQL / Supabase | Ejecutada y deshecha + diff del catálogo | Una transacción por migración (todo o nada) | Probado contra PostgreSQL 16 |
| SQL Server (`mssql`) | Solo análisis del script | Una transacción por migración | **Sin probar contra un servidor real** |
| MySQL (`mysql`) | Solo análisis del script (el DDL confirma la transacción: no se puede deshacer) | Sentencia a sentencia, sin todo-o-nada | **Sin probar contra un servidor real** |

- No hay migraciones «hacia atrás»: se corrige con otra migración nueva.
- La simulación no ve el efecto de otras transacciones concurrentes ni lo que pase después; los números de secuencia consumidos no se devuelven y un efecto fuera de la base (HTTP, archivos) no se puede deshacer.
- Una migración que **no es idempotente** (`CREATE TABLE` sin `IF NOT EXISTS`) y ya está aplicada falla al simularse: eso es información útil, no un error de la consola.
- En un ambiente sin historial el estado no se puede saber sin simular: elige qué migraciones simular (o «desde aquí»). Con `apply`, inicializa el historial y marca como aplicadas las anteriores.

## Desarrollo

```bash
npm install
npm test                                   # unitarias; las de PostgreSQL se omiten sin base de datos
docker run -d --rm --name mc-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test   # incluye las de integración
npm run dev                                # necesita config.json y CONSOLE_TOKEN
```

Estructura: `src/sql` (separador de sentencias y análisis), `src/drivers` (un archivo por motor; `driver.ts` es la interfaz), `src/engine.ts` (reglas: orden, simulación previa, confirmación), `src/server.ts` + `src/ui` (API y pantalla sin build), `src/cli.ts`.
Para soportar otro motor: implementar `Driver` y registrarlo en `src/drivers/index.ts`.
