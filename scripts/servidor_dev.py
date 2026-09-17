#!/usr/bin/env python3
"""
Servidor estático para probar la app en local, igual que
`python3 -m http.server`, pero con dos cosas que hacen falta para que lo
local se parezca a producción: sin caché, y con las reglas de `_redirects`.

SIN CACHÉ. http.server no manda ningún header de Cache-Control, así que
el navegador cachea los módulos JS con "heuristic freshness" (RFC 7234) y
una sesión de prueba larga puede terminar viendo un js/*.js viejo aunque
el archivo en disco ya se haya editado — el índice (index.html) tiene su
propio `?v=` para cache-busting, pero los módulos que importa entre sí
(ficha.js, vista-lista.js, etc.) no, así que quedan a merced del caché
del navegador. Pasó en vivo: vista-lista.js se sirvió cacheado
(deliveryType "cache", transferSize 0) incluso después de varias recargas
normales, y una edición nueva no se reflejaba hasta forzar un fetch con
cache:"no-store".

CON _redirects. Desde que cada sección tiene su propia URL (ver
js/router.js), pedir /contactos tiene que devolver index.html: en
producción eso lo hace Cloudflare Pages con el archivo `_redirects` de la
raíz. Acá se lee ESE MISMO archivo en vez de repetir la lista de rutas,
así local y producción no se pueden desincronizar. Sin esto, entrar
directo a una URL de sección (o recargar estando en una) daba 404 en
local, y los tests que prueban justamente eso no podrían correr.

Solo para desarrollo local — no toca nada de producción (Cloudflare
Pages sirve los archivos reales con sus propios headers).
"""

import functools
import http.server
import io
import os
import sys
from pathlib import Path

# La raíz del proyecto es la carpeta donde vive este script (../), no el
# directorio desde el que se lo ejecutó: así sirve siempre los archivos
# de SU copia del repo. Importa con worktrees de git — cada uno tiene su
# propio scripts/servidor_dev.py y arrancar el de un worktree tiene que
# servir ese worktree, no el checkout principal.
RAIZ = Path(__file__).resolve().parent.parent


def leer_reglas_de_rewrite():
    """Las líneas "<desde> <hacia> 200" de _redirects, como dict.

    Solo interesan las de código 200 (rewrite: la URL no cambia y se
    sirve otro archivo). Un 301/302 sería un redirect de verdad y no
    hace falta emularlo para desarrollo.
    """
    archivo = RAIZ / "_redirects"
    if not archivo.exists():
        return {}
    reglas = {}
    for linea in archivo.read_text(encoding="utf-8").splitlines():
        linea = linea.strip()
        if not linea or linea.startswith("#"):
            continue
        partes = linea.split()
        if len(partes) == 3 and partes[2] == "200":
            reglas[partes[0]] = partes[1]
    return reglas


REGLAS = leer_reglas_de_rewrite()

# ---------------------------------------------------------------------------
# Apuntar la app a otro proyecto Firebase (para los tests)
#
# POR QUÉ ACÁ Y NO EN EL CÓDIGO DE LA APP. Los 12 módulos que hablan con
# Firebase importan todos de js/firebase-config.js, así que reemplazar
# ESE módulo mueve la app entera. Y hacerlo en este script es lo seguro:
# solo corre en local, Cloudflare Pages nunca lo ejecuta (sirve los
# archivos estáticos con sus propios headers). O sea que
# js/firebase-config.js queda intacto en el repo y en producción, y no
# hay ningún artefacto del proyecto de pruebas versionado que pueda
# terminar deployado por accidente.
#
# Los valores vienen del entorno, que se los pasa tests/conftest.py (que
# a su vez los lee de tests/.env, no versionado).
# ---------------------------------------------------------------------------

RUTA_CONFIG_FIREBASE = "/js/firebase-config.js"

API_KEY = os.environ.get("MOJONAPP_FIREBASE_API_KEY")
PROJECT_ID = os.environ.get("MOJONAPP_FIREBASE_PROJECT_ID")
# "mojonapp" es producción: ahí no hay nada que reemplazar, se sirve el
# archivo real del repo.
REEMPLAZAR_CONFIG = bool(API_KEY and PROJECT_ID and PROJECT_ID != "mojonapp")


def config_firebase_generado():
    """El mismo módulo que js/firebase-config.js pero con otro proyecto.

    Mantiene la MISMA interfaz (exporta db, auth y firebaseConfig): si le
    faltara alguno, los módulos que lo importan romperían de formas poco
    obvias. authDomain/storageBucket siguen el formato que arma Firebase
    para cualquier proyecto nuevo.
    """
    return f"""// GENERADO AL VUELO por scripts/servidor_dev.py — NO es un archivo del
// repo. Apunta la app al proyecto de pruebas en vez de producción, para
// que los tests no escriban en los datos reales ni se coman la cuota.
// El archivo de verdad es js/firebase-config.js.
import {{ initializeApp }} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {{ getFirestore }} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import {{ getAuth }} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

const firebaseConfig = {{
  apiKey: "{API_KEY}",
  authDomain: "{PROJECT_ID}.firebaseapp.com",
  projectId: "{PROJECT_ID}",
  storageBucket: "{PROJECT_ID}.firebasestorage.app"
}};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export {{ firebaseConfig }};
""".encode("utf-8")


class ManejadorSinCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def send_head(self):
        # La query string se conserva tal cual: los deep links que ya
        # existían ("?lote=", "?vista=lista") viajan ahí.
        camino, separador, query = self.path.partition("?")

        # El "?v=" del cache-busting hace que el pedido no sea igual a la
        # ruta pelada, así que se compara solo el camino.
        if REEMPLAZAR_CONFIG and camino == RUTA_CONFIG_FIREBASE:
            cuerpo = config_firebase_generado()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(cuerpo)))
            self.end_headers()
            return io.BytesIO(cuerpo)

        if camino in REGLAS:
            self.path = REGLAS[camino] + separador + query
        return super().send_head()


if __name__ == "__main__":
    puerto = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    # Banner ruidoso: sin esto se puede levantar el server para mirar la
    # app y estar viendo otro proyecto sin darse cuenta.
    # flush=True porque cuando la salida va a un archivo o a una tubería
    # (por ejemplo lanzado desde los tests) se bufferea y el banner no se
    # ve hasta que el proceso termina, que es justo cuando ya no sirve.
    if REEMPLAZAR_CONFIG:
        print(f"  [servidor_dev] Firebase: proyecto de PRUEBAS '{PROJECT_ID}'", flush=True)
    else:
        print("  [servidor_dev] Firebase: PRODUCCION 'mojonapp' (js/firebase-config.js)", flush=True)
    print(f"  [servidor_dev] sirviendo {RAIZ}", flush=True)
    http.server.test(
        HandlerClass=functools.partial(ManejadorSinCache, directory=str(RAIZ)),
        port=puerto,
    )
