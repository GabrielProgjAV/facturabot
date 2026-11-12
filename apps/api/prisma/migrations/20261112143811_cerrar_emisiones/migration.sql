-- CreateEnum
CREATE TYPE "DestinoFactura" AS ENUM ('PROVEEDOR', 'MANUAL', 'SIN_FACTURA');

-- AlterTable
ALTER TABLE "borradores" ADD COLUMN     "destino_factura" "DestinoFactura";

-- AlterTable
ALTER TABLE "emisiones" ADD COLUMN     "cancelada_en" TIMESTAMPTZ,
ADD COLUMN     "cancelada_por" BIGINT,
ADD COLUMN     "no_existe_confirmado_en" TIMESTAMPTZ,
ADD COLUMN     "no_existe_confirmado_por" BIGINT;

-- ============================================================================================
-- Escrito a mano (docs/planes/fase-5-alegra.md §4, decisiones de Gabriel del 2026-11-12).
-- Prisma no modela CHECK ni triggers. Ninguna regla de aquí se desactiva nunca, ni en la base de
-- desarrollo ni en la real; la supresión por Ley 1581 será por anonimización, con una excepción
-- controlada que todavía no existe.
-- ============================================================================================

-- 1. Borradores aprobados antes de que existiera la emisión: se facturaron (o no) por fuera del
--    bot. Quedan como MANUAL para que nunca se emitan (sería un duplicado).
UPDATE "borradores" SET "destino_factura" = 'MANUAL' WHERE "estado" = 'APROBADO';

-- 2. Un borrador APROBADO tiene destino; uno que no está APROBADO, no (todas las filas lo cumplen).
ALTER TABLE "borradores" ADD CONSTRAINT "borradores_destino_solo_aprobado_check"
  CHECK (("estado" = 'APROBADO') = ("destino_factura" IS NOT NULL));

-- Un APROBADO tiene quién y cuándo; uno que no está APROBADO, nada de eso. NOT VALID: lo exige a
-- toda fila nueva o modificada, no a los aprobados viejos sin quién (que ya no se pueden modificar).
ALTER TABLE "borradores" ADD CONSTRAINT "borradores_aprobacion_completa_check"
  CHECK (("estado" = 'APROBADO') = ("aprobado_por" IS NOT NULL AND "aprobado_en" IS NOT NULL))
  NOT VALID;

-- 3. Borradores: nacen PENDIENTE; aprobar no cambia lo que se mostró; lo que ya no está PENDIENTE
--    no cambia. Reemplaza la función de la migración proteger_emisiones.
CREATE OR REPLACE FUNCTION "borradores_proteger_no_pendientes"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD."estado" <> 'PENDIENTE' AND (
       NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."chat_id" IS DISTINCT FROM OLD."chat_id"
       OR NEW."estado" IS DISTINCT FROM OLD."estado"
       OR NEW."datos" IS DISTINCT FROM OLD."datos"
       OR NEW."version" IS DISTINCT FROM OLD."version"
       OR NEW."aprobado_por" IS DISTINCT FROM OLD."aprobado_por"
       OR NEW."aprobado_en" IS DISTINCT FROM OLD."aprobado_en"
       OR NEW."destino_factura" IS DISTINCT FROM OLD."destino_factura") THEN
    RAISE EXCEPTION 'borradores_no_pendiente_inmutable: un borrador % ya no se puede cambiar', OLD."estado"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Aprobar es aprobar lo que el usuario vio: los mismos datos, la misma versión, ya mostrada.
  IF OLD."estado" = 'PENDIENTE' AND NEW."estado" = 'APROBADO' AND (
       NEW."datos" IS DISTINCT FROM OLD."datos"
       OR NEW."version" IS DISTINCT FROM OLD."version"
       OR NEW."version_mostrada" IS DISTINCT FROM NEW."version") THEN
    RAISE EXCEPTION 'borradores_aprobacion_coherente: al aprobar no cambian datos ni versión, y la versión aprobada es la mostrada'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION "borradores_nacer_pendiente"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW."estado" <> 'PENDIENTE'
     OR NEW."aprobado_por" IS NOT NULL
     OR NEW."aprobado_en" IS NOT NULL
     OR NEW."destino_factura" IS NOT NULL THEN
    RAISE EXCEPTION 'borradores_nacer_pendiente: un borrador nace PENDIENTE y sin aprobación'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "borradores_nacer_pendiente"
  BEFORE INSERT ON "borradores"
  FOR EACH ROW EXECUTE FUNCTION "borradores_nacer_pendiente"();

-- 4. Emisiones: nacen PENDIENTE, sin nada del proveedor, y solo de un borrador APROBADO con destino
--    PROVEEDOR. Reemplaza la función de la migración proteger_emisiones.
CREATE OR REPLACE FUNCTION "emisiones_exigir_borrador_aprobado"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public."borradores"
    WHERE "id" = NEW."borrador_id" AND "estado" = 'APROBADO' AND "destino_factura" = 'PROVEEDOR'
  ) THEN
    RAISE EXCEPTION 'emisiones_borrador_aprobado: la emisión solo nace de un borrador APROBADO con destino PROVEEDOR'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."estado" <> 'PENDIENTE'
     OR NEW."id_externo" IS NOT NULL
     OR NEW."numero" IS NOT NULL
     OR NEW."cufe" IS NOT NULL
     OR NEW."estado_dian" IS NOT NULL
     OR NEW."emitida_en" IS NOT NULL
     OR NEW."codigo_error" IS NOT NULL
     OR NEW."no_existe_confirmado_por" IS NOT NULL
     OR NEW."no_existe_confirmado_en" IS NOT NULL
     OR NEW."cancelada_por" IS NOT NULL
     OR NEW."cancelada_en" IS NOT NULL THEN
    RAISE EXCEPTION 'emisiones_nacer_pendiente: una emisión nace PENDIENTE y sin datos del proveedor'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- 5. Emisiones: columnas que no cambian y transiciones como lista de PERMITIDAS.
CREATE OR REPLACE FUNCTION "emisiones_proteger_cambios"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
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

  -- Transiciones permitidas (§4). Todo lo que no está en la lista se rechaza; EMITIDA y CANCELADA
  -- son finales. DESCONOCIDO no vuelve directo a PENDIENTE: pasa por NO_CREADA.
  IF NEW."estado" <> OLD."estado" AND (OLD."estado"::text, NEW."estado"::text) NOT IN (
       ('PENDIENTE', 'CREANDO_BORRADOR'),
       ('PENDIENTE', 'CANCELADA'),
       ('CREANDO_BORRADOR', 'BORRADOR_CREADO'),
       ('CREANDO_BORRADOR', 'NO_CREADA'),
       ('CREANDO_BORRADOR', 'DESCONOCIDO'),
       ('DESCONOCIDO', 'BORRADOR_CREADO'),
       ('DESCONOCIDO', 'NO_CREADA'),
       ('BORRADOR_CREADO', 'TIMBRANDO'),
       ('BORRADOR_CREADO', 'DESCONOCIDO'),
       ('TIMBRANDO', 'EMITIDA'),
       ('TIMBRANDO', 'RECHAZADA'),
       ('RECHAZADA', 'TIMBRANDO'),
       ('RECHAZADA', 'EMITIDA'),
       ('NO_CREADA', 'PENDIENTE'),
       ('NO_CREADA', 'CANCELADA')
     ) THEN
    RAISE EXCEPTION 'emisiones_transicion_no_permitida: de % a %', OLD."estado", NEW."estado"
      USING ERRCODE = 'check_violation';
  END IF;

  -- DESCONOCIDO → NO_CREADA solo con la confirmación del usuario ("No existe en Alegra").
  IF OLD."estado" = 'DESCONOCIDO' AND NEW."estado" = 'NO_CREADA'
     AND (NEW."no_existe_confirmado_por" IS NULL OR NEW."no_existe_confirmado_en" IS NULL) THEN
    RAISE EXCEPTION 'emisiones_no_existe_sin_confirmar: pasar a NO_CREADA desde DESCONOCIDO exige quién y cuándo'
      USING ERRCODE = 'check_violation';
  END IF;

  -- PENDIENTE o NO_CREADA → CANCELADA solo con la decisión del usuario ("Ya la facturé a mano"):
  -- si se facturó a mano, no queda abierta la opción de reintentar.
  IF NEW."estado" = 'CANCELADA' AND OLD."estado" <> 'CANCELADA'
     AND (NEW."cancelada_por" IS NULL OR NEW."cancelada_en" IS NULL) THEN
    RAISE EXCEPTION 'emisiones_cancelada_sin_quien: cancelar exige quién y cuándo'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

-- 6. Nada se borra: ni DELETE ni TRUNCATE en borradores ni en emisiones (una emisión borrada
--    dejaría emitir otra vez el mismo borrador). Las pruebas usan una base aparte que se recrea.
CREATE FUNCTION "rechazar_borrado"() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '%_sin_borrado: las filas de % no se borran (Ley 1581: se anonimiza)',
    TG_TABLE_NAME, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER "emisiones_sin_borrado"
  BEFORE DELETE ON "emisiones"
  FOR EACH ROW EXECUTE FUNCTION "rechazar_borrado"();
CREATE TRIGGER "emisiones_sin_truncate"
  BEFORE TRUNCATE ON "emisiones"
  FOR EACH STATEMENT EXECUTE FUNCTION "rechazar_borrado"();
CREATE TRIGGER "borradores_sin_borrado"
  BEFORE DELETE ON "borradores"
  FOR EACH ROW EXECUTE FUNCTION "rechazar_borrado"();
CREATE TRIGGER "borradores_sin_truncate"
  BEFORE TRUNCATE ON "borradores"
  FOR EACH STATEMENT EXECUTE FUNCTION "rechazar_borrado"();
