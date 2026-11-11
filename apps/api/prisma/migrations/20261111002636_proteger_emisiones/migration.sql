-- Escrita a mano: Prisma no modela restricciones CHECK ni triggers (docs/planes/fase-5-alegra.md §4).
-- Cierra en la base lo que encontró la revisión de seguridad del PR #10: un CHECK solo ve la fila
-- nueva, así que un UPDATE equivocado podía cambiar el modo, la cuenta o devolver una emisión al
-- paso 1. Aprobada por Gabriel el 2026-11-10.

-- 1. Restricciones CHECK nuevas ------------------------------------------------------------------

-- Una emisión con factura en el proveedor no puede estar en un estado de "todavía no existe nada":
-- así nunca vuelve al paso 1 (crear el borrador), que es el único que puede duplicar.
ALTER TABLE "emisiones" ADD CONSTRAINT "emisiones_sin_id_externo_segun_estado_check"
  CHECK ("id_externo" IS NULL OR "estado" NOT IN ('PENDIENTE', 'CREANDO_BORRADOR', 'NO_CREADA', 'CANCELADA'));

-- Solo códigos ("http_401", "alegra_3226"): nunca el mensaje del proveedor, que puede traer datos
-- personales (Ley 1581 de 2012).
ALTER TABLE "emisiones" ADD CONSTRAINT "emisiones_codigo_error_check"
  CHECK ("codigo_error" ~ '^[a-z0-9_]{1,64}$');

-- Un texto vacío no identifica una cuenta ni una factura.
ALTER TABLE "emisiones" ADD CONSTRAINT "emisiones_textos_no_vacios_check"
  CHECK ("cuenta_proveedor" <> '' AND "id_externo" <> '');

-- Una emisión EMITIDA siempre tiene cuándo se emitió y su estado ante la DIAN (aunque sea PENDIENTE).
ALTER TABLE "emisiones" ADD CONSTRAINT "emisiones_emitida_completa_check"
  CHECK ("estado" <> 'EMITIDA' OR ("emitida_en" IS NOT NULL AND "estado_dian" IS NOT NULL));

-- Una emisión que nació con ALEGRA_EMITIR apagada nunca tiene datos de una factura timbrada.
ALTER TABLE "emisiones" ADD CONSTRAINT "emisiones_solo_borrador_sin_timbre_check"
  CHECK ("modo" <> 'SOLO_BORRADOR' OR ("numero" IS NULL AND "cufe" IS NULL AND "emitida_en" IS NULL));

-- 2. Emisiones: columnas que no cambian y transiciones de estado ---------------------------------

CREATE FUNCTION "emisiones_proteger_cambios"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Con qué borrador, proveedor, cuenta y modo nació una emisión no cambia nunca.
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."borrador_id" IS DISTINCT FROM OLD."borrador_id"
     OR NEW."proveedor" IS DISTINCT FROM OLD."proveedor"
     OR NEW."cuenta_proveedor" IS DISTINCT FROM OLD."cuenta_proveedor"
     OR NEW."modo" IS DISTINCT FROM OLD."modo"
     OR NEW."creada_en" IS DISTINCT FROM OLD."creada_en" THEN
    RAISE EXCEPTION 'emisiones_columnas_inmutables: id, borrador_id, proveedor, cuenta_proveedor, modo y creada_en no se pueden cambiar'
      USING ERRCODE = 'check_violation';
  END IF;

  -- El id de la factura en el proveedor se guarda una vez y no se cambia ni se borra.
  IF OLD."id_externo" IS NOT NULL AND NEW."id_externo" IS DISTINCT FROM OLD."id_externo" THEN
    RAISE EXCEPTION 'emisiones_id_externo_inmutable: el id externo ya guardado no se puede cambiar'
      USING ERRCODE = 'check_violation';
  END IF;

  -- La fecha de la factura solo se puede actualizar antes de tocar al proveedor.
  IF NEW."fecha_factura" IS DISTINCT FROM OLD."fecha_factura"
     AND NOT (OLD."estado" = 'PENDIENTE' AND OLD."id_externo" IS NULL) THEN
    RAISE EXCEPTION 'emisiones_fecha_factura_inmutable: la fecha solo cambia en PENDIENTE y sin id externo'
      USING ERRCODE = 'check_violation';
  END IF;

  -- EMITIDA y CANCELADA son finales.
  IF OLD."estado" IN ('EMITIDA', 'CANCELADA') AND NEW."estado" <> OLD."estado" THEN
    RAISE EXCEPTION 'emisiones_estado_final: una emisión % no cambia de estado', OLD."estado"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Solo se cancela lo que todavía no tocó al proveedor (plan B: "ya la facturé a mano").
  IF NEW."estado" = 'CANCELADA' AND OLD."estado" NOT IN ('PENDIENTE', 'CANCELADA') THEN
    RAISE EXCEPTION 'emisiones_transicion_a_cancelada: solo se cancela una emisión PENDIENTE (estaba %)', OLD."estado"
      USING ERRCODE = 'check_violation';
  END IF;

  -- A PENDIENTE (reintentar desde el paso 1) solo se vuelve desde NO_CREADA o DESCONOCIDO.
  IF NEW."estado" = 'PENDIENTE' AND OLD."estado" NOT IN ('PENDIENTE', 'NO_CREADA', 'DESCONOCIDO') THEN
    RAISE EXCEPTION 'emisiones_transicion_a_pendiente: no se vuelve a PENDIENTE desde %', OLD."estado"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "emisiones_proteger_cambios"
  BEFORE UPDATE ON "emisiones"
  FOR EACH ROW EXECUTE FUNCTION "emisiones_proteger_cambios"();

-- 3. Emisiones: solo nacen de un borrador APROBADO ----------------------------------------------

CREATE FUNCTION "emisiones_exigir_borrador_aprobado"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "borradores" WHERE "id" = NEW."borrador_id" AND "estado" = 'APROBADO'
  ) THEN
    RAISE EXCEPTION 'emisiones_borrador_aprobado: la emisión solo nace de un borrador APROBADO'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "emisiones_exigir_borrador_aprobado"
  BEFORE INSERT ON "emisiones"
  FOR EACH ROW EXECUTE FUNCTION "emisiones_exigir_borrador_aprobado"();

-- 4. Borradores: lo aprobado (o cancelado) ya no cambia ------------------------------------------

-- La emisión envía a la DIAN lo que el humano aprobó: después de salir de PENDIENTE, ni los datos,
-- ni la versión, ni el estado, ni la aprobación cambian. `version_mostrada` y `actualizado_en` sí.
CREATE FUNCTION "borradores_proteger_no_pendientes"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."estado" <> 'PENDIENTE' AND (
       NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."chat_id" IS DISTINCT FROM OLD."chat_id"
       OR NEW."estado" IS DISTINCT FROM OLD."estado"
       OR NEW."datos" IS DISTINCT FROM OLD."datos"
       OR NEW."version" IS DISTINCT FROM OLD."version"
       OR NEW."aprobado_por" IS DISTINCT FROM OLD."aprobado_por"
       OR NEW."aprobado_en" IS DISTINCT FROM OLD."aprobado_en") THEN
    RAISE EXCEPTION 'borradores_no_pendiente_inmutable: un borrador % ya no se puede cambiar', OLD."estado"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "borradores_proteger_no_pendientes"
  BEFORE UPDATE ON "borradores"
  FOR EACH ROW EXECUTE FUNCTION "borradores_proteger_no_pendientes"();
