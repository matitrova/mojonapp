#!/usr/bin/env python3
"""
Carga los datos de la demostración en el proyecto Firebase de pruebas.

PARA QUÉ. Hacen falta dos ambientes: uno que una inmobiliaria use de
verdad, y otro para mostrar y seguir tocando sin romperle nada a nadie.
Este script llena el segundo.

POR QUÉ LOS DATOS SON INVENTADOS Y NO LOS REALES. Los 108 lotes de
producción son parcelas catastrales que existen, y casi no tienen datos
comerciales cargados: 2 de 108 tienen precio, 3 tienen zona, 8 tienen
servicios. Completarlos a ojo para que la demo se vea linda sería
publicar información falsa sobre propiedades reales — justo lo que el
prompt del generador de avisos tiene prohibido hacer. Así que los datos
inventados viven acá, en un proyecto aparte, y producción queda como
está.

Las zonas SÍ son reales (Potrero de los Funes, El Trapiche, Carpintería)
y las coordenadas caen donde corresponde: la idea es que la demo se vea
como la app de una inmobiliaria serrana de San Luis, no como un tablero
de pruebas con "lote 1", "lote 2".

NUNCA ESCRIBE EN PRODUCCIÓN. Si el proyecto configurado es "mojonapp",
aborta antes de tocar nada.

USO:
    .venv/bin/python scripts/sembrar_demo.py            # dry-run: no escribe nada
    .venv/bin/python scripts/sembrar_demo.py --aplicar  # escribe de verdad

Con el Python del entorno virtual del proyecto (ahí está "requests").
Lee tests/.env, igual que scripts/sembrar_proyecto_de_pruebas.py.

ES SEGURO CORRERLO DOS VECES: saltea los lotes y contactos que ya existen
(compara por manzana+lote y por nombre), así que sumar un lote nuevo a la
demo es agregarlo a la lista de abajo y volver a correrlo.

LOS NOMBRES NO MATCHEAN EL PATRÓN DE BORRADO de
scripts/limpiar_datos_de_prueba.py ("PREFIJO-<8 hex>"): este proyecto es
el mismo donde corren los tests, y la demo tiene que sobrevivir a esa
limpieza.
"""

import argparse
import sys
from datetime import date, timedelta
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / "tests"))

import requests  # noqa: E402

import conftest  # noqa: E402  (carga tests/.env y resuelve el token)


def rectangulo(lat, lon, superficie_m2):
    """Un rectángulo aproximado del tamaño pedido, centrado en el punto.

    No pretende ser exacto: es para que el lote se dibuje en el mapa con
    un tamaño creíble y en el lugar correcto. Se usa la aproximación de
    1 grado de latitud ~ 111.320 m, y la longitud se corrige por el
    coseno de la latitud (en San Luis, ~32° sur, el factor es ~0,845).

    Devuelve el anillo en el formato que guarda Firestore: una lista
    PLANA de {lon, lat}, no el anillo anidado de GeoJSON — Firestore no
    admite un array dentro de otro array (ver docALoteFeature en
    js/app.js, que lo reconstruye al leer).
    """
    lado = superficie_m2**0.5
    dlat = lado / 2 / 111_320
    dlon = lado / 2 / (111_320 * 0.845)
    esquinas = [
        (lon - dlon, lat - dlat),
        (lon + dlon, lat - dlat),
        (lon + dlon, lat + dlat),
        (lon - dlon, lat + dlat),
        (lon - dlon, lat - dlat),  # cierra el anillo
    ]
    return [{"lon": round(x, 6), "lat": round(y, 6)} for x, y in esquinas]


# Centro de cada zona, sobre coordenadas reales. Los lotes se van
# separando a partir de acá para que no se pisen en el mapa.
ZONAS = {
    "Potrero de los Funes": (-33.2100, -66.2400),
    "El Trapiche": (-33.1200, -66.0600),
    "Carpintería": (-32.3600, -65.0100),
}

HOY = date.today()


def servicios(luz=False, agua=False, gas=False, cloaca=False):
    return {"luz": luz, "agua": agua, "gas": gas, "cloaca": cloaca}


def lote(zona, barrio, manzana, numero, superficie, precio, servs, descripcion,
         estado="disponible", fila=0, col=0, **extra):
    lat, lon = ZONAS[zona]
    datos = {
        "manzana": manzana,
        "lote": numero,
        "nomenclatura": None,
        "superficie_m2": superficie,
        "estado": estado,
        "precio_usd": precio,
        "sector": zona,
        "barrio": barrio,
        "servicios": servs,
        "descripcion": descripcion,
        "geometry": {
            "type": "Polygon",
            "coordinates": rectangulo(lat + fila * 0.0008, lon + col * 0.0010, superficie),
        },
    }
    datos.update(extra)
    return datos


LOTES = [
    # Potrero de los Funes — la zona cara, con vista al dique.
    lote("Potrero de los Funes", "Altos del Potrero", "14", "7", 900, 22000, servicios(luz=True, agua=True),
         "Lote en pendiente suave con vista al dique. Calle de ripio consolidada.", fila=0, col=0),
    lote("Potrero de los Funes", "Altos del Potrero", "14", "8", 780, 19500, servicios(luz=True, agua=True),
         "Pegado al lote 7, misma vista y mismo frente a la calle.", fila=0, col=1),
    lote("Potrero de los Funes", "Altos del Potrero", "14", "9", 1200, 31000, servicios(luz=True, agua=True, gas=True),
         "El más grande de la manzana, en esquina. Los tres servicios ya instalados.", fila=0, col=2),
    lote("Potrero de los Funes", "Las Carolinas", "21", "3", 1570, 52000, servicios(luz=True, agua=True, cloaca=True),
         "Sobre el sector comercial del barrio, con frente amplio.", estado="reservado",
         reservado_hasta=(HOY + timedelta(days=12)).isoformat(), fila=1, col=0),
    lote("Potrero de los Funes", "Las Carolinas", "21", "4", 800, 24000, servicios(luz=True, agua=True),
         "Terreno plano, apto para construir sin movimiento de suelo.", fila=1, col=1),

    # El Trapiche — más grande y más barato, con menos servicios.
    lote("El Trapiche", None, "3", "22", 2500, 15000, servicios(),
         "Terreno plano de media hectárea, todavía sin servicios.", fila=0, col=0),
    lote("El Trapiche", None, "3", "23", 2200, 14000, servicios(luz=True),
         "Con luz en el terreno. Lindero al lote 22, se pueden comprar juntos.", fila=0, col=1),
    lote("El Trapiche", None, "5", "1", 4000, 26000, servicios(luz=True, agua=True),
         "Fracción con frente sobre el camino principal.", fila=1, col=0),
    lote("El Trapiche", None, "5", "2", 1800, 11500, servicios(),
         "El más económico de la cartera. Sin servicios, con buen acceso.", fila=1, col=1),

    # Carpintería — lotes chicos de barrio, con todos los servicios.
    lote("Carpintería", "Las Chacras", "8", "4", 450, 16000, servicios(luz=True, agua=True, gas=True),
         "Lote de barrio con luz, agua y gas ya instalados.", fila=0, col=0),
    lote("Carpintería", "Las Chacras", "8", "5", 480, 17000, servicios(luz=True, agua=True, gas=True),
         "Al lado del 4, mismas medidas y mismos servicios.", fila=0, col=1),
    lote("Carpintería", "Las Chacras", "8", "6", 520, 18500, servicios(luz=True, agua=True, gas=True, cloaca=True),
         "El único de la manzana con cloaca.", estado="vendido", fila=0, col=2),
]

# Contactos repartidos por el pipeline, para que el CRM y el Dashboard no
# se vean vacíos en la demo. Los seguimientos usan fechas relativas a hoy
# (uno vencido y uno para hoy) así la pantalla de "Seguimientos" siempre
# tiene algo que mostrar, sin importar cuándo se siembre.
CONTACTOS = [
    ("Carolina Giménez", "266 4 55-8821", "caro.gimenez@example.com", "nuevo", None,
     "Consultó por el lote de Altos del Potrero. Quiere saber si acepta financiación."),
    ("Rubén Ochoa", "266 4 41-2030", None, "contactado", (HOY - timedelta(days=2)).isoformat(),
     "Llamar de nuevo, quedó en confirmar si viene el fin de semana."),
    ("Familia Sosa", "266 4 62-7714", "sosa.familia@example.com", "visita", HOY.isoformat(),
     "Visitan hoy a la tarde los dos lotes de El Trapiche."),
    ("Marcelo Pérez", "266 4 30-9955", "mperez@example.com", "oferta", (HOY + timedelta(days=3)).isoformat(),
     "Ofertó 20.000 por el lote 7. Esperando respuesta del dueño."),
    ("Lucía Ferreyra", "266 4 15-8842", "lu.ferreyra@example.com", "cerrado", None,
     "Compró el lote 6 de Las Chacras."),
    ("Diego Ibarra", "266 4 77-1190", None, "perdido", None,
     "Buscaba algo bajo 10.000, no tenemos nada en ese rango."),
]


def existentes(coleccion):
    """Lo que ya hay cargado, para no duplicar al correr dos veces."""
    base = (
        f"https://firestore.googleapis.com/v1/projects/{conftest.FIREBASE_PROJECT_ID}"
        f"/databases/(default)/documents/{coleccion}?pageSize=300"
    )
    respuesta = requests.get(
        base, headers={"Authorization": f"Bearer {conftest._id_token_de_prueba()}"}, timeout=20
    )
    respuesta.raise_for_status()
    return respuesta.json().get("documents", [])


def texto(doc, campo):
    return doc.get("fields", {}).get(campo, {}).get("stringValue")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--aplicar", action="store_true", help="escribir de verdad (sin esto, solo informa)")
    args = parser.parse_args()

    if conftest.FIREBASE_PROJECT_ID == "mojonapp":
        sys.exit(
            "ABORTADO: esto sembraría datos INVENTADOS en producción.\n"
            "Configurá FIREBASE_PROJECT_ID en tests/.env con el proyecto de pruebas."
        )

    print(f"Proyecto: {conftest.FIREBASE_PROJECT_ID}\n")

    # La clave incluye el SECTOR y no solo manzana+lote. Con (manzana,
    # lote) sola pasó esto: en el proyecto de pruebas —que se comparte con
    # la suite— había un documento con manzana "8" y lote "6" que no era de
    # la demo, así que el lote 12 se salteó por "ya existe" y la demo quedó
    # sin su único lote VENDIDO. Con las métricas de venta del Dashboard en
    # cero, que es exactamente lo que la demo existe para evitar.
    #
    # Los lotes de la demo siempre tienen sector cargado; los que dejan los
    # tests y el importador de catastro, no. Eso hace la clave lo bastante
    # específica sin inventar un campo marcador.
    def clave(manzana, numero, sector):
        return (manzana, numero, sector)

    lotes_ya = {clave(texto(d, "manzana"), texto(d, "lote"), texto(d, "sector")) for d in existentes("lotes")}
    contactos_ya = {texto(d, "nombre") for d in existentes("contactos")}

    lotes_nuevos = [l for l in LOTES if clave(l["manzana"], l["lote"], l["sector"]) not in lotes_ya]
    contactos_nuevos = [c for c in CONTACTOS if c[0] not in contactos_ya]

    print(f"Lotes:     {len(lotes_nuevos)} a crear, {len(LOTES) - len(lotes_nuevos)} ya estaban")
    for l in lotes_nuevos:
        print(f"  Mz {l['manzana']} lote {l['lote']:<3} {l['sector']:<22} {l['superficie_m2']:>5} m²  {l['estado']}")
    print(f"\nContactos: {len(contactos_nuevos)} a crear, {len(CONTACTOS) - len(contactos_nuevos)} ya estaban")
    for c in contactos_nuevos:
        print(f"  {c[0]:<20} {c[3]}")

    if not args.aplicar:
        print("\nDry-run: no se escribió nada. Volvé a correrlo con --aplicar para hacerlo de verdad.")
        return

    print()
    ids_por_clave = {}
    for l in lotes_nuevos:
        doc_id = conftest.crear_lote_de_prueba(l)
        ids_por_clave[(l["manzana"], l["lote"])] = (doc_id, f"Manzana {l['manzana']} — Lote {l['lote']}")
        print(f"  lote creado: Mz {l['manzana']} lote {l['lote']} ({doc_id})")

    # Un par de contactos quedan apuntando a lotes reales de la demo, para
    # que el mini-mapa del CRM y los "lotes de interés" tengan qué mostrar.
    interes = [par for par in (ids_por_clave.get(("14", "7")), ids_por_clave.get(("3", "22"))) if par]
    ahora = f"{HOY.isoformat()}T12:00:00.000Z"
    for i, (nombre, telefono, email, estado, seguimiento, nota) in enumerate(contactos_nuevos):
        lotes_interes = []
        if interes:
            elegido = interes[i % len(interes)]
            lotes_interes = [{"id": elegido[0], "titulo": elegido[1]}]
        doc_id = conftest.crear_contacto_de_prueba({
            "nombre": nombre,
            "telefono": telefono,
            "email": email,
            "estado": estado,
            "motivo_perdido": "Fuera de presupuesto" if estado == "perdido" else None,
            "proximo_seguimiento": seguimiento,
            "nota_fijada": nota,
            "lotes_interes": lotes_interes,
            "etiquetas": [],
            "actividades": [
                {"tipo": "contacto_creado", "texto": "Contacto creado", "fecha": ahora, "autor_email": None}
            ],
            "origen": "ficha" if lotes_interes else "manual",
            "fecha_creacion": ahora,
            "fecha_actualizacion": ahora,
        })
        print(f"  contacto creado: {nombre} ({doc_id})")

    print(f"\nListo: {len(lotes_nuevos)} lotes y {len(contactos_nuevos)} contactos.")

    # Verificar contra la base, no confiar en que no saltó ninguna
    # excepción. Es la lección de la corrida anterior: el script terminó
    # sin error y sin embargo faltaba un lote, porque el salteo por
    # idempotencia es silencioso por diseño. Un "listo" que no comprueba
    # nada es exactamente el tipo de verde falso que ya nos costó horas.
    quedaron = {clave(texto(d, "manzana"), texto(d, "lote"), texto(d, "sector")) for d in existentes("lotes")}
    faltan = [l for l in LOTES if clave(l["manzana"], l["lote"], l["sector"]) not in quedaron]
    if faltan:
        print("\nPERO FALTAN en la base, revisar:")
        for l in faltan:
            print(f"  Mz {l['manzana']} lote {l['lote']} — {l['sector']} ({l['estado']})")
        sys.exit(1)
    print(f"Verificado: los {len(LOTES)} lotes de la demo están en la base.")


if __name__ == "__main__":
    main()
