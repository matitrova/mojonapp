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

CON LAS RUTAS DEL ROUTER. Desde que cada sección tiene su propia URL
(ver js/router.js), pedir /contactos tiene que devolver index.html. En
producción eso lo hace Cloudflare Pages solo, sin configurar nada; acá se
imita esa misma regla (ver sirve_el_indice más abajo). Sin esto, entrar
directo a una URL de sección —o recargar estando en una— daba 404 en
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


def sirve_el_indice(camino):
    """¿Este pedido tiene que devolver index.html?

    Imita lo que hace Cloudflare Pages: un pedido que no corresponde a
    ningún archivo del proyecto devuelve index.html con código 200 (no un
    404, ni un redirect). Eso es lo que hace que /contactos, /dashboard y
    el resto de las rutas del router funcionen al entrar directo o al
    recargar, y es comportamiento nativo de Pages — verificado en
    producción: /cualquier-cosa devuelve la app con 200.

    IMPORTANTE, porque ya costó un deploy roto: NO hace falta un archivo
    `_redirects`. Se probó con reglas `"/contactos /index.html 200"` y
    Pages no las aplica como rewrite — las convierte en un redirect 308
    al destino canonizado ("/index.html" pasa a ser "/"), así que entrar
    a /contactos rebotaba al mapa y se perdía la sección. El archivo
    rompía justo lo que ya funcionaba solo.

    Los pedidos con extensión (.js, .css, .svg) quedan afuera: si no
    existen tienen que dar 404 de verdad, no la app — un 200 con HTML
    donde se esperaba un módulo esconde el error real.
    """
    if camino.startswith("/js/") or camino.startswith("/css/"):
        return False
    if Path(camino).suffix:
        return False
    return not (RAIZ / camino.lstrip("/")).exists()

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

        if sirve_el_indice(camino):
            self.path = "/index.html" + separador + query
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
