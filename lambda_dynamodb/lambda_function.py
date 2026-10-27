import base64
import json
import os
import re
from collections import Counter
from decimal import Decimal, InvalidOperation

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

# =========================================================
# CONFIGURACIÓN
# =========================================================
MAX_LIMIT = 100
MAX_FILTROS = 8
MAX_VUELTAS = 25          # páginas de DynamoDB por solicitud cuando hay filtros
MUESTRA_ESQUEMA = 5       # páginas leídas por tabla para describir sus campos
MAX_VALORES = 15          # un campo de texto con pocos valores repetidos se ofrece como lista

dynamodb = boto3.resource("dynamodb")
client = dynamodb.meta.client

# Únicas tablas que el panel puede ver; otra tabla de la cuenta queda fuera.
# Debe coincidir con la política IAM LecturaDynamoDB.
LECTURA = {"clientes", "compras", "inventario", "productos", "proveedores", "sucursales", "ventas"}

# Tablas que aceptan registros nuevos y cómo validarlos.
# El ID se genera solo con el prefijo (C011, P011...).
ESCRITURA = {
    "clientes": {
        "prefijo": "C",
        "singular": "cliente",
        "campos": [
            {"nombre": "nombre", "etiqueta": "Nombre completo", "tipo": "S", "requerido": True, "max": 80},
            {"nombre": "correo", "etiqueta": "Correo", "tipo": "S", "formato": "email", "requerido": True, "max": 120, "unico": True},
            {"nombre": "ciudad", "etiqueta": "Ciudad", "tipo": "S", "requerido": True, "max": 60},
        ],
    },
    "productos": {
        "prefijo": "P",
        "singular": "producto",
        "campos": [
            {"nombre": "nombre", "etiqueta": "Nombre del producto", "tipo": "S", "requerido": True, "max": 80, "unico": True},
            {"nombre": "categoria", "etiqueta": "Categoría", "tipo": "S", "requerido": True, "max": 60},
            {"nombre": "precio", "etiqueta": "Precio", "tipo": "N", "requerido": True, "min": 0, "max": 1_000_000_000},
        ],
    },
}

OPERADORES = {"eq", "ne", "contains", "begins_with", "gt", "ge", "lt", "le", "between", "exists", "not_exists"}
CAMPO_VALIDO = re.compile(r"^[A-Za-z0-9_]{1,64}$")
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class ErrorSolicitud(Exception):
    def __init__(self, mensaje, status=400, extra=None):
        super().__init__(mensaje)
        self.status = status
        self.extra = extra or {}


def default(o):
    if isinstance(o, Decimal):
        return int(o) if o % 1 == 0 else float(o)
    if isinstance(o, (set, frozenset)):
        return sorted(o, key=str)
    if isinstance(o, bytes):
        return base64.b64encode(o).decode()
    return str(o)


def response(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=default),
    }


def encode_token(lek):
    if not lek:
        return None
    return base64.urlsafe_b64encode(json.dumps(lek, default=default).encode()).decode()


def decode_token(token):
    if not token:
        return None
    return json.loads(base64.urlsafe_b64decode(token.encode()), parse_float=Decimal, parse_int=Decimal)


def convertir(valor, tipo):
    # Convierte el valor recibido como texto al tipo del atributo (S o N)
    if tipo == "N":
        try:
            return Decimal(str(valor).strip())
        except InvalidOperation:
            raise ErrorSolicitud(f"'{valor}' no es un número válido")
    return str(valor)


def describir(tabla):
    t = client.describe_table(TableName=tabla)["Table"]
    tipos = {a["AttributeName"]: a["AttributeType"] for a in t["AttributeDefinitions"]}

    def llaves(schema):
        out = {}
        for k in schema:
            rol = "pk" if k["KeyType"] == "HASH" else "sk"
            out[rol] = {"nombre": k["AttributeName"], "tipo": tipos.get(k["AttributeName"], "S")}
        return out

    return {
        "nombre": t["TableName"],
        "llaves": llaves(t["KeySchema"]),
        "items": t.get("ItemCount", 0),
        "tamano": t.get("TableSizeBytes", 0),
        "estado": t.get("TableStatus"),
        "indices": [
            {"nombre": i["IndexName"], "llaves": llaves(i["KeySchema"])}
            for i in t.get("GlobalSecondaryIndexes", []) + t.get("LocalSecondaryIndexes", [])
        ],
    }


def tablas_permitidas():
    nombres = []
    for page in client.get_paginator("list_tables").paginate():
        nombres.extend(n for n in page["TableNames"] if n in LECTURA)
    return nombres


def limite(params):
    try:
        return max(1, min(int(params.get("limit", 25)), MAX_LIMIT))
    except ValueError:
        return 25


def nombres_llave(info, indice=None):
    # Atributos que forman la llave de paginación (tabla + índice si aplica)
    nombres = [l["nombre"] for l in info["llaves"].values()]
    if indice:
        nombres += [l["nombre"] for l in indice["llaves"].values() if l["nombre"] not in nombres]
    return nombres


# =========================================================
# FILTROS (FilterExpression)
# =========================================================
def condicion_filtros(params):
    crudo = params.get("filtros")
    if not crudo:
        return None
    try:
        filtros = json.loads(crudo)
    except ValueError:
        raise ErrorSolicitud("El parámetro filtros no es JSON válido")
    if not isinstance(filtros, list) or len(filtros) > MAX_FILTROS:
        raise ErrorSolicitud(f"Se aceptan hasta {MAX_FILTROS} filtros")

    cond = None
    for f in filtros:
        campo, op, tipo = f.get("campo", ""), f.get("op", ""), f.get("tipo", "S")
        if not CAMPO_VALIDO.match(campo) or op not in OPERADORES or tipo not in ("S", "N"):
            raise ErrorSolicitud("Filtro inválido", extra={"filtro": f})
        a = Attr(campo)
        if op == "exists":
            c = a.exists()
        elif op == "not_exists":
            c = a.not_exists()
        else:
            if f.get("valor") in (None, ""):
                raise ErrorSolicitud(f"Falta el valor del filtro sobre {campo}")
            v = convertir(f["valor"], tipo)
            if op in ("contains", "begins_with"):
                c = getattr(a, op)(str(f["valor"]))
            elif op == "between":
                if f.get("valor2") in (None, ""):
                    raise ErrorSolicitud(f"Falta el segundo valor del rango sobre {campo}")
                c = a.between(v, convertir(f["valor2"], tipo))
            else:
                c = getattr(a, {"ge": "gte", "le": "lte"}.get(op, op))(v)
        cond = c if cond is None else cond & c
    return cond


def paginar(operacion, kwargs, limit, start, llaves):
    # Con FilterExpression una página puede volver con pocos resultados:
    # se siguen leyendo páginas hasta juntar `limit` elementos.
    hay_filtro = "FilterExpression" in kwargs
    items, lek, vueltas, leidos = [], start, 0, 0
    while True:
        k = dict(kwargs, Limit=max(limit, 50) if hay_filtro else limit)
        if lek:
            k["ExclusiveStartKey"] = lek
        r = operacion(**k)
        vueltas += 1
        leidos += r.get("ScannedCount", 0)
        items.extend(r.get("Items", []))
        lek = r.get("LastEvaluatedKey")
        if len(items) >= limit or not lek or vueltas >= MAX_VUELTAS:
            break
    if len(items) > limit:
        items = items[:limit]
        lek = {n: items[-1][n] for n in llaves if n in items[-1]}
    return items, lek, leidos


# =========================================================
# ESQUEMA: campos de cada tabla a partir de sus datos
# =========================================================
def siguiente_id(prefijo, valores):
    patron = re.compile(rf"^{re.escape(prefijo)}(\d+)$")
    nums = [int(m.group(1)) for v in valores if (m := patron.match(str(v)))]
    ancho = max([len(str(v)) - len(prefijo) for v in valores if patron.match(str(v))] or [3])
    return f"{prefijo}{(max(nums) + 1 if nums else 1):0{ancho}d}"


def leer_todo(tabla, paginas, **kwargs):
    items, lek = [], None
    for _ in range(paginas):
        if lek:
            kwargs["ExclusiveStartKey"] = lek
        r = dynamodb.Table(tabla).scan(**kwargs)
        items.extend(r.get("Items", []))
        lek = r.get("LastEvaluatedKey")
        if not lek:
            break
    return items, lek is None


def tipo_de(v):
    if isinstance(v, bool):
        return "BOOL"
    if isinstance(v, Decimal):
        return "N"
    if isinstance(v, str):
        return "S"
    return "otro"


def esquema_tabla(nombre):
    info = describir(nombre)
    items, completo = leer_todo(nombre, MUESTRA_ESQUEMA)
    llaves = [l["nombre"] for l in info["llaves"].values()]

    datos = {}
    for it in items:
        for k, v in it.items():
            d = datos.setdefault(k, {"tipos": Counter(), "valores": Counter(), "n": 0, "min": None, "max": None})
            d["n"] += 1
            t = tipo_de(v)
            d["tipos"][t] += 1
            if t == "S":
                d["valores"][v] += 1
            elif t == "N":
                d["min"] = v if d["min"] is None else min(d["min"], v)
                d["max"] = v if d["max"] is None else max(d["max"], v)

    campos = []
    for k in llaves + sorted(c for c in datos if c not in llaves):
        if k not in datos:
            continue
        d = datos[k]
        campo = {"nombre": k, "tipo": d["tipos"].most_common(1)[0][0], "presentes": d["n"], "llave": k in llaves}
        repetidos = len(d["valores"]) < d["n"]
        if campo["tipo"] == "S" and not campo["llave"] and repetidos and len(d["valores"]) <= MAX_VALORES:
            campo["valores"] = d["valores"].most_common()
        if campo["tipo"] == "N":
            campo["min"], campo["max"] = d["min"], d["max"]
        campos.append(campo)

    info.update(conteo=len(items), conteoExacto=completo, campos=campos)
    if nombre in ESCRITURA:
        esc = ESCRITURA[nombre]
        pk = info["llaves"]["pk"]["nombre"]
        info["escritura"] = {
            "singular": esc["singular"],
            "campos": esc["campos"],
            "siguienteId": siguiente_id(esc["prefijo"], [it.get(pk) for it in items]),
        }
    return info


# =========================================================
# INSERTAR
# =========================================================
def limpiar_texto(v):
    v = re.sub(r"\s+", " ", str(v)).strip()
    return "".join(ch for ch in v if ch.isprintable())


def validar(tabla, body):
    if not isinstance(body, dict):
        raise ErrorSolicitud("El cuerpo debe ser un objeto JSON")
    esquema = ESCRITURA[tabla]
    item, errores = {}, {}
    for c in esquema["campos"]:
        n = c["nombre"]
        crudo = body.get(n)
        if crudo is None or str(crudo).strip() == "":
            if c.get("requerido"):
                errores[n] = "Este campo es obligatorio"
            continue
        if c["tipo"] == "N":
            try:
                v = Decimal(str(crudo).strip())
            except InvalidOperation:
                errores[n] = "Debe ser un número"
                continue
            if not v.is_finite():
                errores[n] = "Debe ser un número"
            elif "min" in c and v < c["min"]:
                errores[n] = f"No puede ser menor que {c['min']}"
            elif "max" in c and v > c["max"]:
                errores[n] = f"No puede ser mayor que {c['max']:,}".replace(",", ".")
            elif v.as_tuple().exponent < -2:
                errores[n] = "Máximo dos decimales"
            else:
                item[n] = v
        else:
            v = limpiar_texto(crudo)
            if c.get("formato") == "email":
                v = v.lower()
                if not EMAIL.match(v):
                    errores[n] = "Escribe un correo válido, por ejemplo ana@correo.com"
                    continue
            if len(v) > c.get("max", 200):
                errores[n] = f"Máximo {c['max']} caracteres"
            else:
                item[n] = v
    desconocidos = set(body) - {c["nombre"] for c in esquema["campos"]}
    if desconocidos:
        errores["_"] = f"Campos no permitidos: {', '.join(sorted(desconocidos))}"
    if errores:
        raise ErrorSolicitud("Revisa los campos marcados", extra={"campos": errores})

    # Valores que no se pueden repetir (sin distinguir mayúsculas)
    for c in esquema["campos"]:
        if c.get("unico") and c["nombre"] in item:
            existentes, _ = leer_todo(tabla, 20, ProjectionExpression="#c", ExpressionAttributeNames={"#c": c["nombre"]})
            buscado = str(item[c["nombre"]]).lower()
            if any(str(e.get(c["nombre"], "")).lower() == buscado for e in existentes):
                raise ErrorSolicitud(
                    "Revisa los campos marcados", status=409,
                    extra={"campos": {c["nombre"]: f"Ya existe un {esquema['singular']} con ese {c['nombre']}"}})
    return item


def insertar(tabla, body):
    if tabla not in ESCRITURA:
        raise ErrorSolicitud("Esta tabla es de solo lectura", status=403)
    item = validar(tabla, body)
    info = describir(tabla)
    pk = info["llaves"]["pk"]["nombre"]
    esc = ESCRITURA[tabla]
    for _ in range(5):
        ids, _ = leer_todo(tabla, 20, ProjectionExpression="#k", ExpressionAttributeNames={"#k": pk})
        nuevo = dict(item, **{pk: siguiente_id(esc["prefijo"], [i[pk] for i in ids])})
        try:
            dynamodb.Table(tabla).put_item(Item=nuevo, ConditionExpression=Attr(pk).not_exists())
            return nuevo
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
    raise ErrorSolicitud("No se pudo asignar un ID libre, intenta de nuevo", status=409)


# =========================================================
# HANDLER
# =========================================================
def lambda_handler(event, context):
    route = event.get("routeKey", "")
    params = event.get("queryStringParameters") or {}
    path_params = event.get("pathParameters") or {}

    print("Ruta:", route, "Params:", params, "Path:", path_params)

    try:
        # LISTAR TABLAS: GET /api/dynamo/tablas
        if route == "GET /api/dynamo/tablas":
            return response(200, {"tablas": [describir(n) for n in tablas_permitidas()]})

        # ESQUEMA DE TODAS LAS TABLAS: GET /api/dynamo/esquema
        if route == "GET /api/dynamo/esquema":
            return response(200, {"tablas": [esquema_tabla(n) for n in tablas_permitidas()]})

        tabla = path_params.get("tabla", "")
        if not tabla:
            return response(400, {"error": "Debe indicar la tabla"})
        if tabla not in LECTURA:
            return response(404, {"error": "Tabla no encontrada"})

        # INSERTAR: POST /api/dynamo/tablas/{tabla}/items
        if route == "POST /api/dynamo/tablas/{tabla}/items":
            cuerpo = event.get("body") or "{}"
            if event.get("isBase64Encoded"):
                cuerpo = base64.b64decode(cuerpo).decode()
            try:
                body = json.loads(cuerpo)
            except ValueError:
                return response(400, {"error": "El cuerpo no es JSON válido"})
            nuevo = insertar(tabla, body)
            pk = next(k for k in nuevo if k not in body)
            return response(201, {"mensaje": f"{ESCRITURA[tabla]['singular'].capitalize()} {nuevo[pk]} guardado", "item": nuevo})

        info = describir(tabla)

        # ESCANEAR CON FILTROS: GET /api/dynamo/tablas/{tabla}?filtros=[...]
        if route == "GET /api/dynamo/tablas/{tabla}":
            kwargs = {}
            cond = condicion_filtros(params)
            if cond is not None:
                kwargs["FilterExpression"] = cond
            items, lek, leidos = paginar(dynamodb.Table(tabla).scan, kwargs, limite(params),
                                         decode_token(params.get("next")), nombres_llave(info))
            return response(200, {"tabla": info, "items": items, "next": encode_token(lek), "leidos": leidos})

        # BUSCAR POR LLAVE: GET /api/dynamo/tablas/{tabla}/item?pk=...&sk=...
        if route == "GET /api/dynamo/tablas/{tabla}/item":
            pk = params.get("pk")
            if not pk:
                return response(400, {"error": "Debe indicar el valor de la llave"})
            llaves = info["llaves"]
            key = {llaves["pk"]["nombre"]: convertir(pk, llaves["pk"]["tipo"])}
            if "sk" in llaves:
                sk = params.get("sk")
                if not sk:
                    return response(400, {"error": f"La tabla requiere también {llaves['sk']['nombre']}"})
                key[llaves["sk"]["nombre"]] = convertir(sk, llaves["sk"]["tipo"])
            item = dynamodb.Table(tabla).get_item(Key=key).get("Item")
            return response(200, {"tabla": info, "items": [item] if item else [], "next": None})

        # CONSULTAR ÍNDICE: GET /api/dynamo/tablas/{tabla}/indice/{indice}?pk=...&sk=...&filtros=[...]
        if route == "GET /api/dynamo/tablas/{tabla}/indice/{indice}":
            indice = next((i for i in info["indices"] if i["nombre"] == path_params.get("indice")), None)
            if not indice:
                return response(404, {"error": "Índice no encontrado"})
            pk = params.get("pk")
            if not pk:
                return response(400, {"error": "Debe indicar el valor de la llave del índice"})
            llaves = indice["llaves"]
            cond = Key(llaves["pk"]["nombre"]).eq(convertir(pk, llaves["pk"]["tipo"]))
            if "sk" in llaves and params.get("sk"):
                sk = Key(llaves["sk"]["nombre"])
                if llaves["sk"]["tipo"] == "N":
                    cond = cond & sk.eq(convertir(params["sk"], "N"))
                else:
                    cond = cond & sk.begins_with(params["sk"])
            kwargs = {"IndexName": indice["nombre"], "KeyConditionExpression": cond}
            filtro = condicion_filtros(params)
            if filtro is not None:
                kwargs["FilterExpression"] = filtro
            items, lek, leidos = paginar(dynamodb.Table(tabla).query, kwargs, limite(params),
                                         decode_token(params.get("next")), nombres_llave(info, indice))
            return response(200, {"tabla": info, "items": items, "next": encode_token(lek), "leidos": leidos})

        return response(404, {"error": "Ruta no encontrada", "ruta": route})

    except ErrorSolicitud as e:
        return response(e.status, {"error": str(e), **e.extra})
    except ClientError as e:
        print("ERROR AWS:", str(e))
        code = e.response["Error"]["Code"]
        status = 404 if code == "ResourceNotFoundException" else 500
        return response(status, {"error": "Error de AWS", "detalle": code})
    except Exception as e:
        print("ERROR:", str(e))
        return response(500, {"error": "Error interno"})
